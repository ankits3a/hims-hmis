import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import { downtimeFormCounters, downtimeKitRanges, downtimeKits } from "../db/schema";
import { appendEvent } from "../events/append";
import { hmacSign, hmacVerify } from "../crypto";
import { kitGenerated } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../db/client";

// PLAN 11c D7 + D9 — THE DOWNTIME KIT: PAPER WITH NUMBERS ON IT THAT RECOVERY CAN RECONCILE.
//
// When the screens go dark the hospital does not stop; it writes on paper. Map 1's protocol is
// that every sheet handed to a desk carries a serial from a RESERVED RANGE, so that when the
// power comes back somebody can prove which sheets exist, which were used, and which are still
// blank. That proof is the whole product here: a range nobody can enumerate is a stack of paper.
//
// ═══ WHY THIS IS NOT BILLING'S `document_series`, AND THE DISTINCTION IS NOT STYLISTIC ═══
//
// A `document_series` number is a DOCUMENT NUMBER: per-fiscal-year, GST-consecutive, printed on a
// tax invoice, and legally consequential. A kit serial is a RECONCILIATION KEY. Recovery does not
// promote a kit serial into an invoice number — it BACKFILLS a real document through billing's own
// lane, which allocates a real invoice number from `document_series` at that moment. If the kit
// drew from that counter instead, then every unused blank sheet in a drawer would have consumed a
// GST-consecutive number that no document will ever carry, and the consecutiveness that the series
// exists to guarantee would be broken by stationery.
//
// So the kit allocates from `downtime_form_counters`, its own table, and `document_series` is
// never read or written from this file.
//
// ═══ THE SINGLE-WINNER COUNTER, AND THE ORDERED LOCK (06.1 C1) ═══
//
// The advance is `UPDATE … SET next_serial = next_serial + n … RETURNING` — the shipped pattern
// (`modules/billing/series.ts` `nextDocNo`, `modules/opd/sessions.ts` `allocateToken`). The row
// lock the UPDATE takes is what makes two concurrent generations DISJOINT (Book V13): the second
// transaction blocks on the row until the first commits and then reads the already-advanced value.
// A read-then-write (`SELECT next_serial` … `UPDATE SET next_serial = <read + n>`) has exactly the
// same shape and is WRONG, because two racers both read the same value and the second overwrites
// the first — two kits, one range, and two desks writing the same serials on different paper.
//
// ONE GENERATION SPANS SEVERAL FORM KINDS, SO IT TAKES SEVERAL ROW LOCKS, AND THE ORDER IS FIXED
// (the 06.1 C1 lesson). Two transactions that take the same locks in different orders deadlock:
// A holds `receipt` and wants `registration` while B holds `registration` and wants `receipt`, and
// Postgres kills one of them. `LOCK_ORDER` below is a total order over the `form_kind` COLUMN
// VALUE and every generation walks it, so no two generations can ever interleave their locks.
//
// ═══ THE SIGNED QR (D9 / E-23) ═══
//
// Every form gets `dtk1.<kitId>.<formKind>.<serial>.<hmac>` — the `makeBadgeToken`/
// `parseBadgeToken` shape from `kernel/crypto.ts`, Plan 02's utility CONSUMED rather than
// recreated. It is what makes a scanned sheet at backfill time verifiable rather than merely
// legible: a serial somebody wrote on the wrong form, or invented, does not verify. `hmacVerify`
// is `timingSafeEqual`-based; nothing here compares signatures with `===`.
//
// ═══ THE CLOCK ═══
//
// `now` is injected everywhere (GC8). Nothing in this file reads the wall clock except through
// that default, and no fixture anywhere derives from it.

/**
 * D7's stage-1 form kinds — a CODE CONSTANT, promotable to data when a real drill demands a
 * fourth. The list is deliberately the three sheets a desk cannot run a shift without: who the
 * patient is, what was done, and what was paid.
 */
export const DOWNTIME_FORM_KINDS = ["registration", "consultation", "receipt"] as const;
export type DowntimeFormKind = (typeof DOWNTIME_FORM_KINDS)[number];

/**
 * THE LOCK ORDER, AND IT IS DERIVED FROM THE COLUMN VALUE RATHER THAN FROM THE CONSTANT ABOVE.
 *
 * `DOWNTIME_FORM_KINDS` is in PRESENTATION order — the order a desk uses the sheets in — and a
 * later edit could reasonably reorder it without anybody thinking about locking. Sorting the
 * strings gives a total order over `downtime_form_counters.form_kind` itself, which is the thing
 * actually being locked, and it cannot drift when the presentation order changes. That is what
 * "counters are locked in `form_kind` order" means here, literally.
 */
export const LOCK_ORDER: readonly DowntimeFormKind[] = [...DOWNTIME_FORM_KINDS].sort((a, b) =>
  a < b ? -1 : a > b ? 1 : 0,
);

/** Bounds, so a typo cannot reserve a million serials nobody will ever print. */
export const MAX_DESKS_PER_KIT = 50;
export const MAX_FORMS_PER_DESK_KIND = 500;
/** The list route's page cap — the `ALERTS_PAGE_LIMIT` precedent: bounded by construction. */
export const DOWNTIME_KIT_PAGE_LIMIT = 50;

/** The QR's version prefix. Bumped only if the payload's SHAPE changes; the key is not versioned. */
export const KIT_QR_PREFIX = "dtk1";

/**
 * The generation request. Counts are PER DESK PER KIND because that is how paper is handed over —
 * "the front desk gets 20 registration sheets and 20 receipts" — and because a range is only a
 * reconciliation key if it names the desk it went to.
 *
 * No `.default()` anywhere: the schema's input type equals its output type, so the controller can
 * parse it through the shipped `parsed()` helper rather than inline (the note `interfaces.ts`'s
 * registration schema carries, in the opposite direction).
 */
export const downtimeKitRequestSchema = z.object({
  note: z.string().max(2000).nullish(),
  desks: z
    .array(
      z.object({
        desk: z.string().min(1).max(120),
        counts: z.object({
          registration: z.number().int().min(0).max(MAX_FORMS_PER_DESK_KIND).optional(),
          consultation: z.number().int().min(0).max(MAX_FORMS_PER_DESK_KIND).optional(),
          receipt: z.number().int().min(0).max(MAX_FORMS_PER_DESK_KIND).optional(),
        }),
      }),
    )
    .min(1)
    .max(MAX_DESKS_PER_KIT),
});
export type DowntimeKitRequest = z.infer<typeof downtimeKitRequestSchema>;

export type DowntimeKitErrorCode =
  | "downtime_kit_empty"
  | "downtime_kit_duplicate_desk"
  | "downtime_kit_not_found";

/** The house convention for a refusal a controller maps once (`ModeError`, `InterfaceError`). */
export class DowntimeKitError extends Error {
  constructor(
    readonly code: DowntimeKitErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "DowntimeKitError";
  }
}

/** One reserved block: `[startSerial, endSerial]` INCLUSIVE, for one desk and one form kind. */
export type DowntimeKitRange = {
  id: string;
  desk: string;
  formKind: DowntimeFormKind;
  startSerial: number;
  /** Inclusive. `count === endSerial - startSerial + 1`, always. */
  endSerial: number;
  count: number;
};

export type DowntimeKitView = {
  id: string;
  note: string | null;
  generatedBy: string;
  generatedAt: string;
  totalForms: number;
  ranges: DowntimeKitRange[];
};

export type GenerateDowntimeKitResult = DowntimeKitView & { eventId: string };

/**
 * RESERVE THE PAPER (D7, Book V13/V14).
 *
 * Tx-typed on purpose: the counter advance, the kit row, every range row and the event are ONE
 * append. A generation that advanced the counters and then failed to write its ranges would burn
 * serials that no kit can account for — which is precisely the hole the serials exist to close.
 *
 * THE TWO REFUSALS ARE CHECKED BEFORE ANY COUNTER MOVES, and that ordering is the decision:
 * a request that names the same desk twice would violate
 * `downtime_kit_ranges_kit_desk_kind_ux` at INSERT time, after three counters had already been
 * advanced inside the transaction — the rollback would undo it, but the refusal is cheaper and it
 * is a better sentence for the duty manager who mistyped.
 */
export async function generateDowntimeKit(
  tx: Tx,
  actor: Actor,
  input: DowntimeKitRequest,
  now: Date = new Date(),
): Promise<GenerateDowntimeKitResult> {
  const seenDesks = new Set<string>();
  for (const d of input.desks) {
    if (seenDesks.has(d.desk)) {
      throw new DowntimeKitError(
        "downtime_kit_duplicate_desk",
        `desk "${d.desk}" appears more than once in one kit`,
      );
    }
    seenDesks.add(d.desk);
  }

  const totals = new Map<DowntimeFormKind, number>();
  for (const d of input.desks) {
    for (const kind of LOCK_ORDER) {
      const n = d.counts[kind] ?? 0;
      if (n > 0) totals.set(kind, (totals.get(kind) ?? 0) + n);
    }
  }
  const totalForms = [...totals.values()].reduce((a, b) => a + b, 0);
  if (totalForms === 0) {
    throw new DowntimeKitError("downtime_kit_empty", "a kit that reserves no forms is not a kit");
  }

  // ── the counters, IN `form_kind` ORDER (06.1 C1) ────────────────────────────────────────────
  //
  // One block per kind for the WHOLE kit, carved into per-desk sub-ranges below. Reserving the
  // kind's whole block in one advance rather than one advance per desk×kind is what keeps the
  // lock count at three and the hold time at one statement each.
  type Block = { startSerial: number; endSerial: number; nextFree: number };
  const blocks = new Map<DowntimeFormKind, Block>();
  for (const kind of LOCK_ORDER) {
    const total = totals.get(kind) ?? 0;
    if (total === 0) continue;

    // First-ever row for this kind: `next_serial` defaults to 1, so the INSERT alone hands out
    // nothing — the UPDATE below is what allocates. `ON CONFLICT DO NOTHING` lets every racer's
    // insert no-op after the first and every racer proceed to the same single-winner UPDATE
    // (`nextDocNo`'s cold-start path, verbatim).
    await tx.insert(downtimeFormCounters).values({ formKind: kind, nextSerial: 1 }).onConflictDoNothing();

    const rows = await tx
      .update(downtimeFormCounters)
      .set({ nextSerial: sql`${downtimeFormCounters.nextSerial} + ${total}` })
      .where(eq(downtimeFormCounters.formKind, kind))
      .returning({ nextSerial: downtimeFormCounters.nextSerial });
    // RETURNING is the POST-advance value (the `allocateToken` note): the block just reserved ends
    // one below it.
    const after = rows[0]!.nextSerial;
    const startSerial = after - total;
    blocks.set(kind, { startSerial, endSerial: after - 1, nextFree: startSerial });
  }

  const kitId = newId();
  await tx.insert(downtimeKits).values({
    id: kitId,
    note: input.note ?? null,
    generatedBy: actor.id,
    generatedAt: now,
  });

  // Desks in REQUEST order, kinds in LOCK_ORDER — deterministic, so a kit generated twice from the
  // same request produces the same shape and a print run is reproducible.
  const ranges: DowntimeKitRange[] = [];
  for (const d of input.desks) {
    for (const kind of LOCK_ORDER) {
      const n = d.counts[kind] ?? 0;
      if (n === 0) continue;
      const block = blocks.get(kind)!;
      const startSerial = block.nextFree;
      const endSerial = startSerial + n - 1;
      block.nextFree = endSerial + 1;
      ranges.push({ id: newId(), desk: d.desk, formKind: kind, startSerial, endSerial, count: n });
    }
  }

  await tx.insert(downtimeKitRanges).values(
    ranges.map((r) => ({
      id: r.id,
      kitId,
      desk: r.desk,
      formKind: r.formKind,
      startSerial: r.startSerial,
      endSerial: r.endSerial,
    })),
  );

  const { eventId } = await appendEvent(
    tx,
    kitGenerated.make({
      actor,
      occurredAt: now,
      // No patientId, ever (GC6): a kit is issued to a DESK, not to a patient.
      payload: {
        kitId,
        note: input.note ?? null,
        deskCount: input.desks.length,
        totalForms,
        blocks: LOCK_ORDER.filter((k) => blocks.has(k)).map((k) => {
          const b = blocks.get(k)!;
          return {
            formKind: k,
            startSerial: b.startSerial,
            endSerial: b.endSerial,
            count: b.endSerial - b.startSerial + 1,
          };
        }),
      },
    }),
  );

  return {
    id: kitId,
    note: input.note ?? null,
    generatedBy: actor.id,
    generatedAt: now.toISOString(),
    totalForms,
    ranges,
    eventId,
  };
}

type RangeRow = typeof downtimeKitRanges.$inferSelect;

function toRange(row: RangeRow): DowntimeKitRange {
  return {
    id: row.id,
    desk: row.desk,
    formKind: row.formKind as DowntimeFormKind,
    startSerial: row.startSerial,
    endSerial: row.endSerial,
    count: row.endSerial - row.startSerial + 1,
  };
}

/**
 * Newest kit FIRST — the opposite of `listInterfaces`, and deliberately so: a duty manager opening
 * this screen during an outage wants the kit they just generated, not the one from the drill three
 * months ago. `seq` is the only monotone column (`newId()` is a non-monotonic ULID — audit A1).
 */
export async function listDowntimeKits(db: Db, limit = DOWNTIME_KIT_PAGE_LIMIT): Promise<DowntimeKitView[]> {
  const kits = await db
    .select()
    .from(downtimeKits)
    .orderBy(desc(downtimeKits.seq))
    .limit(Math.min(limit, DOWNTIME_KIT_PAGE_LIMIT));
  if (kits.length === 0) return [];

  const rangeRows = await db
    .select()
    .from(downtimeKitRanges)
    .where(inArray(downtimeKitRanges.kitId, kits.map((k) => k.id)))
    .orderBy(asc(downtimeKitRanges.seq));

  const byKit = new Map<string, DowntimeKitRange[]>();
  for (const row of rangeRows) {
    const list = byKit.get(row.kitId) ?? [];
    list.push(toRange(row));
    byKit.set(row.kitId, list);
  }

  return kits.map((k) => {
    const ranges = byKit.get(k.id) ?? [];
    return {
      id: k.id,
      note: k.note,
      generatedBy: k.generatedBy,
      generatedAt: k.generatedAt.toISOString(),
      totalForms: ranges.reduce((a, r) => a + r.count, 0),
      ranges,
    };
  });
}

/** One form on one sheet of paper: what to print in the corner, and what the QR encodes. */
export type KitPrintForm = {
  formKind: DowntimeFormKind;
  serial: number;
  /** `dtk1.<kitId>.<formKind>.<serial>.<hmac>` — what `verifyKitSerial` reads back. */
  qr: string;
};

export type KitPrintRange = DowntimeKitRange & { forms: KitPrintForm[] };

export type KitPrintPayload = {
  kitId: string;
  note: string | null;
  generatedBy: string;
  generatedAt: string;
  totalForms: number;
  ranges: KitPrintRange[];
};

/** The signed body, in ONE place, so the signer and the verifier cannot disagree about it. */
function qrBody(kitId: string, formKind: DowntimeFormKind, serial: number): string {
  return `${KIT_QR_PREFIX}.${kitId}.${formKind}.${serial}`;
}

/**
 * WHAT THE PRINTER RENDERS (D9, T5's screen). One entry per SHEET, not per range: the range is the
 * reservation, the sheet is the artefact, and a screen that had to expand ranges itself would be a
 * second place the serial arithmetic lived.
 *
 * `secretKey` is passed in rather than read from a module-level config, for the same reason
 * `makeBadgeToken` takes one: this function is pure over its inputs and a test can sign with a key
 * of its own choosing — which is exactly what Book V15's tamper case needs.
 */
export async function getKitPrintPayload(
  db: Db,
  secretKey: Buffer,
  kitId: string,
): Promise<KitPrintPayload> {
  const kits = await db.select().from(downtimeKits).where(eq(downtimeKits.id, kitId));
  const kit = kits[0];
  if (kit === undefined) throw new DowntimeKitError("downtime_kit_not_found", `no downtime kit ${kitId}`);

  const rangeRows = await db
    .select()
    .from(downtimeKitRanges)
    .where(eq(downtimeKitRanges.kitId, kitId))
    .orderBy(asc(downtimeKitRanges.seq));

  const ranges: KitPrintRange[] = rangeRows.map((row) => {
    const range = toRange(row);
    const forms: KitPrintForm[] = [];
    for (let serial = range.startSerial; serial <= range.endSerial; serial += 1) {
      const body = qrBody(kitId, range.formKind, serial);
      forms.push({ formKind: range.formKind, serial, qr: `${body}.${hmacSign(secretKey, body)}` });
    }
    return { ...range, forms };
  });

  return {
    kitId: kit.id,
    note: kit.note,
    generatedBy: kit.generatedBy,
    generatedAt: kit.generatedAt.toISOString(),
    totalForms: ranges.reduce((a, r) => a + r.count, 0),
    ranges,
  };
}

export type VerifiedKitSerial = { kitId: string; formKind: DowntimeFormKind; serial: number };

/**
 * READ A SCANNED SHEET BACK (D9, Book V15) — the parsed triple, or `null`.
 *
 * `parseBadgeToken` is the shape this follows exactly, including the order of the checks: the
 * SIGNATURE IS VERIFIED BEFORE ANY FIELD IS TRUSTED, so a payload whose serial was altered is
 * rejected because the mac no longer matches and not because the number looked wrong. That order
 * is what Book V15 discriminates: a verifier that parsed first and checked the mac afterwards —
 * or never — would happily return the tampered triple.
 *
 * `null` rather than a throw, for the same reason `parseBadgeToken` returns null: a bad scan at a
 * recovery desk is an ordinary event, not an exception, and the caller renders "this sheet does
 * not belong to any kit" rather than a stack trace.
 */
export function verifyKitSerial(key: Buffer, qr: string): VerifiedKitSerial | null {
  const parts = qr.split(".");
  if (parts.length !== 5) return null;
  const [prefix, kitId, formKind, serialPart, sig] = parts as [string, string, string, string, string];
  if (prefix !== KIT_QR_PREFIX) return null;
  if (!hmacVerify(key, `${prefix}.${kitId}.${formKind}.${serialPart}`, sig)) return null;

  if (kitId === "") return null;
  if (!(DOWNTIME_FORM_KINDS as readonly string[]).includes(formKind)) return null;
  const serial = Number(serialPart);
  if (!Number.isInteger(serial) || serial < 1) return null;
  return { kitId, formKind: formKind as DowntimeFormKind, serial };
}
