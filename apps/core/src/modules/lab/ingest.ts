import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  labInstruments, labParkedResults, labSpecimenItems, labSpecimens, labTransmissions,
  orderItems,
} from "../../kernel/db/schema";
import { LabError } from "./errors";
import { instrumentCodeMap } from "./instruments";
import { closeRunSheet, openRunSheetFor } from "./run-sheets";
import { enterResult, LAB_RESULTS_INTERFACE } from "./results";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PLAN 17-E T3 — THE BLOCK ARRIVES, AND EVERY ROW FINDS ITS PATIENT OR PARKS ═══
 *
 * The board's Autolab ESR sends ten positions in one transmission and the header reads *"9 matched ·
 * 1 waiting"*. That sentence is the whole specification: **a transmission is received whole and
 * attached one row at a time.**
 *
 * ═══ D3 — ONE UNREADABLE ROW PARKS THAT ROW, AND THE OTHER NINE GO ON ═══
 *
 * The ten positions are ten different patients. Rejecting the block because one tube did not scan
 * would cost nine people their results for a reason none of them had anything to do with — and the
 * analyser has already consumed those samples, so "send it again" is not available. Each row is
 * therefore resolved and written on its OWN transaction; nothing about row 4 can roll back row 3.
 *
 * ═══ D4 — NEVER ATTACH BY GUESS ═══
 *
 * No fuzzy matching, no nearest-sequence, no "it must be the only unmatched tube on the bench". A
 * row that cannot be named is PARKED with its payload raw, and a human either names the tube or
 * discards it with a reason. This is the rule the phase exists to enforce and no later task may
 * weaken it to make something pass.
 *
 * ═══ THE GUARDS APPLY TO MACHINE VALUES EXACTLY AS TO TYPED ONES ═══
 *
 * The write goes through `enterResult`, the same function the bench keys into, so 17d T1's
 * applicability control and 02 H1's absurd envelope run on every machine value. Both refuse unless a
 * SECOND PAIR OF HANDS vouches — and a machine has none — so a refused row parks as
 * `guard_refused` rather than being entered or dropped. An interface is a faster way to key a
 * number, never a way around the controls on keying one.
 *
 * ═══ D5 — TWO CLOCKS ═══
 *
 * `arrivedAt` is ours. `instrumentAt` is theirs, stored beside it and never read for turnaround.
 * Analyser clocks drift, are set wrong at install, and survive a power cut as 00:00.
 */
export { LAB_RESULTS_INTERFACE };

export type IngestRow = {
  /** The rack slot, strip number or plate well — the instrument's own ordinal within this run. */
  position: number;
  /** How the machine named the sample. Absent for a sequence-only instrument (T4/T5 resolve those). */
  sampleId?: string | null;
  /** The instrument's OWN test code, verbatim and case-sensitive. */
  code: string;
  value: string;
  unit?: string | null;
  /** THEIR clock. Kept, never trusted. */
  instrumentAt?: Date | null;
};

export type ParkReason =
  | "unmapped_code" | "unknown_sample" | "sample_not_received" | "no_open_item" | "guard_refused"
  | "no_run_sheet";

export type IngestOutcome = {
  transmissionId: string;
  arrivedAt: Date;
  /** True when this exact `transmissionRef` had already been received — a bridge retry. */
  duplicate: boolean;
  attached: { position: number; resultId: string }[];
  parked: { position: number; reason: ParkReason; detail?: string }[];
};

async function assertMayIngest(db: Db, actor: Actor): Promise<void> {
  /**
   * A `user` actor by TYPE before permission. The bridge is a service USER holding `lab_bridge`
   * (D2, corrected at T2): `guards.ts` refuses any non-user actor before `hasPermission` is reached,
   * so an agent could never pass this anyway — and handing `hasPermission` an agent id returns
   * false, which would report "this user lacks the grant" about something that is not a user.
   */
  if (actor.type !== "user") {
    throw new LabError("user_actor_required", "an instrument transmission is posted by the bridge account");
  }
  if (!(await hasPermission(db, actor.id, LAB_RESULTS_INTERFACE, "hospital"))) {
    throw new LabError("permission_denied", `posting instrument results needs ${LAB_RESULTS_INTERFACE}`);
  }
}

/** Resolves the sample the machine named, for the two modes that name one directly. */
async function resolveSample(
  db: Db, sampleId: string | null | undefined,
): Promise<{ specimenId: string } | { park: ParkReason }> {
  if (sampleId === null || sampleId === undefined || sampleId.trim() === "") return { park: "unknown_sample" };
  const [specimen] = await db
    .select({ id: labSpecimens.id, status: labSpecimens.status })
    .from(labSpecimens).where(eq(labSpecimens.specimenNo, sampleId.trim()));
  if (!specimen) return { park: "unknown_sample" };
  /** A tube the bench has not received is in transit or was rejected — its rack slot is not ours. */
  if (specimen.status !== "received") return { park: "sample_not_received" };
  return { specimenId: specimen.id };
}

export async function ingestResults(
  db: Db,
  actor: Actor,
  input: { instrumentId: string; transmissionRef: string; rows: readonly IngestRow[] },
  now: Date = new Date(),
): Promise<IngestOutcome> {
  await assertMayIngest(db, actor);

  const [instrument] = await db.select().from(labInstruments).where(eq(labInstruments.id, input.instrumentId));
  if (!instrument) throw new LabError("unknown_instrument", `no laboratory instrument ${input.instrumentId}`);
  if (!instrument.active) {
    throw new LabError("unknown_instrument", `laboratory instrument ${input.instrumentId} is not active`);
  }

  /**
   * ═══ A RETRY IS NOT A SECOND SET OF RESULTS ═══
   *
   * A bench PC that times out waiting for our response and re-sends is the ordinary case: the
   * analyser has already aspirated the sample and the bridge has nothing else to do. Writing the
   * block twice would duplicate every value in it, and `lab_results` has no natural key that would
   * catch it. The unique `(instrument, transmission_ref)` is what makes the retry a no-op, and it
   * is checked HERE as well as enforced there so the answer is an outcome rather than a 500.
   */
  const [prior] = await db
    .select({ id: labTransmissions.id, arrivedAt: labTransmissions.arrivedAt })
    .from(labTransmissions)
    .where(and(
      eq(labTransmissions.instrumentId, input.instrumentId),
      eq(labTransmissions.transmissionRef, input.transmissionRef),
    ));
  if (prior) {
    const parked = await db
      .select({ position: labParkedResults.position, reason: labParkedResults.reason })
      .from(labParkedResults).where(eq(labParkedResults.transmissionId, prior.id));
    return {
      transmissionId: prior.id, arrivedAt: prior.arrivedAt, duplicate: true,
      attached: [], parked: parked.map((p) => ({ position: p.position, reason: p.reason as ParkReason })),
    };
  }

  const transmissionId = newId();
  await db.insert(labTransmissions).values({
    id: transmissionId,
    instrumentId: input.instrumentId,
    transmissionRef: input.transmissionRef,
    arrivedAt: now,
    rowCount: input.rows.length,
    receivedByType: actor.type,
    receivedById: actor.id,
  });

  /**
   * ═══ T4 — A MACHINE THAT CAN ONLY COUNT RESOLVES BY THE SHEET, NOT BY A NAME ═══
   *
   * The EL-120 and the U120 send a POSITION. It names a result only inside the run that produced
   * it, so the sheet the bench scanned before loading is the only thing that can turn it into a
   * patient. No open sheet means no run was loaded, and every row parks — the alternative is
   * reading positions against YESTERDAY's map, which is a swapped tube by construction.
   */
  const sheet = instrument.sampleIdMode === "run_sheet"
    ? await openRunSheetFor(db, input.instrumentId)
    : null;

  const codeMap = await instrumentCodeMap(db, input.instrumentId);
  const attached: IngestOutcome["attached"] = [];
  const parked: IngestOutcome["parked"] = [];

  const park = async (row: IngestRow, reason: ParkReason, detail?: string): Promise<void> => {
    await db.insert(labParkedResults).values({
      id: newId(), transmissionId, instrumentId: input.instrumentId,
      position: row.position, sampleId: row.sampleId ?? null, instrumentCode: row.code,
      rawValue: row.value, rawUnit: row.unit ?? null, instrumentAt: row.instrumentAt ?? null,
      reason,
    });
    parked.push(detail === undefined ? { position: row.position, reason } : { position: row.position, reason, detail });
  };

  for (const row of input.rows) {
    /** Each row on its own, so one unreadable position cannot cost the other nine theirs (D3). */
    const mapped = codeMap.get(row.code);
    if (mapped === undefined) { await park(row, "unmapped_code"); continue; }

    let sample: { specimenId: string } | { park: ParkReason };
    if (instrument.sampleIdMode === "run_sheet") {
      /**
       * **A GAP PARKS THAT POSITION AND ONLY THAT POSITION.** There is deliberately nothing to fall
       * back to: no nearest-filled, no next-in-sequence, no "the only unscanned cup". A sheet with a
       * hole at strip 43 means nobody scanned strip 43, and the tube physically in that slot is
       * unknown — reading it as strip 44's patient is exactly the swap the sheet exists to prevent.
       */
      const specimenId = sheet?.positions.get(row.position);
      sample = specimenId === undefined ? { park: "no_run_sheet" } : { specimenId };
    } else {
      sample = await resolveSample(db, row.sampleId);
    }
    if ("park" in sample) { await park(row, sample.park); continue; }

    /** The open item on THIS tube for THIS analyte. An absent one is not an error, it is a park. */
    const items = await db
      .select({ orderItemId: labSpecimenItems.orderItemId })
      .from(labSpecimenItems)
      .innerJoin(orderItems, eq(orderItems.id, labSpecimenItems.orderItemId))
      .where(and(
        eq(labSpecimenItems.specimenId, sample.specimenId),
        eq(labSpecimenItems.active, true),
        inArray(orderItems.status, ["in_progress"]),
      ));
    if (items.length === 0) { await park(row, "no_open_item"); continue; }

    /**
     * The instrument's unit becomes ours by a stored factor, applied ONCE, here. A non-numeric
     * value (a urine strip's `++`) is passed through — a factor cannot multiply a symbol.
     */
    const asNumber = Number(row.value);
    const converted = Number.isFinite(asNumber) && mapped.factor !== "1"
      ? String(asNumber * Number(mapped.factor))
      : row.value;

    let wrote = false;
    for (const item of items) {
      try {
        const out = await enterResult(db, actor, {
          orderItemId: item.orderItemId,
          analyteId: mapped.analyteId,
          value: converted,
          unit: mapped.unit,
          entryMode: "interface",
          analyzerId: input.instrumentId,
        }, now);
        attached.push({ position: row.position, resultId: out.resultId });
        wrote = true;
        break;
      } catch (e) {
        /**
         * A guard refused. 17d T1's applicability control and the absurd envelope both need a
         * SECOND PAIR OF HANDS, and a machine has none — so the row parks for a human rather than
         * being entered or dropped. `enterResult` has already evented the near-miss on its own
         * transaction, which is what makes this safe to swallow HERE and only here.
         */
        if (e instanceof LabError) { await park(row, "guard_refused", e.code); wrote = true; break; }
        throw e;
      }
    }
    if (!wrote) await park(row, "no_open_item");
  }

  /**
   * ═══ THE BLOCK CONSUMES THE SHEET ═══
   *
   * Once this run has landed, the sheet's positions describe cups that are no longer on the machine.
   * A SECOND block is therefore not a retry — it is a new run whose sheet nobody built — and with
   * the sheet closed it finds none and parks whole, rather than resolving against a stale map.
   *
   * Closed even when every row parked: the sheet was still the one this run was loaded against, and
   * leaving it open would offer it to the next block.
   */
  if (sheet !== null) await closeRunSheet(db, sheet.id, transmissionId, now);

  return { transmissionId, arrivedAt: now, duplicate: false, attached, parked };
}

/** The inbox's read: what is waiting for a human to name (T6 renders this). */
export async function parkedResults(db: Db, opts: { instrumentId?: string } = {}): Promise<unknown[]> {
  const rows = await db
    .select().from(labParkedResults)
    .where(opts.instrumentId === undefined
      ? eq(labParkedResults.status, "parked")
      : and(eq(labParkedResults.status, "parked"), eq(labParkedResults.instrumentId, opts.instrumentId)));
  return rows;
}
