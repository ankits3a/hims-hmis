import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { ipdBedStays, ipdEmarNarcoticRegister, ipdNarcoticCountResolutions, ipdNarcoticCounts, ipdOrders, resources } from "../../kernel/db/schema";
import { admissionPlace } from "./admission-place";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * 2026-10-14 — THE WARD NARCOTIC LEDGER (NDPS / NABH). Pure database reads and the one seam the transfer acts call; no
 * permission here (the acts and reads in `narcotic.ts` check). Kept apart from `emar.ts` so `transfers.ts` can call
 * `followNarcoticsIn` without loading the eMAR (no load-time cycle).
 *
 * THE BALANCE (DECIDED, standard ward practice): per ward × drug (formulary medicine) × the register's base unit,
 *   expected = opening + received + transferred in + reversed − given − wasted − returned − transferred out,
 * where OPENING is the last AGREED count — a count that matched, or a mismatch a supervisor or pharmacist resolved — and the
 * movements are the register rows WRITTEN after it (`recorded_at`, the server's clock; a give's own `at` may be up to two
 * minutes earlier). An unresolved mismatch is not agreed: the next count is compared with the same balance and differs
 * again, so a discrepancy keeps surfacing until somebody closes it. Rows written before the ward column existed have no
 * ward and are not on any ward's balance (staging only; IPD is not live).
 */

const SIGN: Record<string, number> = {
  received: 1, transfer_in: 1, reversal: 1, given: -1, wasted: -1, returned: -1, transfer_out: -1,
};

/** Three decimals: half ampoules and quarter tablets add up without float noise. */
export const r3 = (x: number): number => Math.round(x * 1000) / 1000;

export type NarcoticBalance = {
  medicineId: string; name: string; unit: string;
  opening: number; openingAt: Date | null;
  received: number; given: number; wasted: number; returned: number; transferredIn: number; transferredOut: number;
  expected: number;
};

export const balanceKey = (medicineId: string, unit: string): string => `${medicineId}\u0000${unit}`;

/** The last agreed count of each drug on the ward (matched, or resolved). */
async function agreedCounts(exec: Db | Tx, wardId: string, cut: Date | null): Promise<Map<string, { counted: number; at: Date }>> {
  const counts = (await (exec as Db).select().from(ipdNarcoticCounts).where(eq(ipdNarcoticCounts.wardId, wardId)))
    .filter((c) => cut === null || c.at.getTime() <= cut.getTime());
  const resolved = counts.length === 0 ? new Set<string>() : new Set((await (exec as Db).select({ countId: ipdNarcoticCountResolutions.countId })
    .from(ipdNarcoticCountResolutions).where(inArray(ipdNarcoticCountResolutions.countId, counts.map((c) => c.id)))).map((r) => r.countId));
  const out = new Map<string, { counted: number; at: Date }>();
  for (const c of counts) {
    if (r3(c.variance) !== 0 && !resolved.has(c.id)) continue;
    const k = balanceKey(c.medicineId, c.unit);
    const had = out.get(k);
    if (had === undefined || had.at.getTime() < c.at.getTime()) out.set(k, { counted: c.countedQty, at: c.at });
  }
  return out;
}

/**
 * Every controlled drug's running balance on one ward (drugs the ward has ever held or counted). `cut` (a count's own
 * instant) leaves out every row written after it — the SAME cut the next balance uses to start from that count. Review
 * 2026-10-14: without it, a dose written after the count's instant but committed before the count read the register was
 * in the count's expected AND, once the count was agreed, taken off again (counted twice).
 */
export async function wardNarcoticBalances(exec: Db | Tx, wardId: string, opts: { cut?: Date } = {}): Promise<NarcoticBalance[]> {
  const cut = opts.cut ?? null;
  const rows = await (exec as Db).select({
    kind: ipdEmarNarcoticRegister.kind, qty: ipdEmarNarcoticRegister.qty, unit: ipdEmarNarcoticRegister.unit,
    at: ipdEmarNarcoticRegister.at, recordedAt: ipdEmarNarcoticRegister.recordedAt,
    medicineId: ipdOrders.medicineId, name: ipdOrders.medicineName,
  }).from(ipdEmarNarcoticRegister).innerJoin(ipdOrders, eq(ipdOrders.id, ipdEmarNarcoticRegister.orderId))
    .where(and(eq(ipdEmarNarcoticRegister.wardId, wardId), isNotNull(ipdOrders.medicineId)));
  const agreed = await agreedCounts(exec, wardId, cut);
  const counted = (await (exec as Db).select({ medicineId: ipdNarcoticCounts.medicineId, unit: ipdNarcoticCounts.unit, name: ipdNarcoticCounts.medicineName, at: ipdNarcoticCounts.at })
    .from(ipdNarcoticCounts).where(eq(ipdNarcoticCounts.wardId, wardId))).filter((c) => cut === null || c.at.getTime() <= cut.getTime());
  const out = new Map<string, NarcoticBalance>();
  const ensure = (medicineId: string, unit: string, name: string | null): NarcoticBalance => {
    const k = balanceKey(medicineId, unit);
    let b = out.get(k);
    if (b === undefined) {
      const base = agreed.get(k);
      b = {
        medicineId, unit, name: name ?? medicineId, opening: base?.counted ?? 0, openingAt: base?.at ?? null,
        received: 0, given: 0, wasted: 0, returned: 0, transferredIn: 0, transferredOut: 0, expected: 0,
      };
      out.set(k, b);
    } else if (name !== null && b.name === b.medicineId) {
      b.name = name;
    }
    return b;
  };
  for (const c of counted) ensure(c.medicineId, c.unit, c.name);
  for (const r of rows) {
    const b = ensure(r.medicineId!, r.unit, r.name);
    const written = r.recordedAt ?? r.at;
    if (cut !== null && written.getTime() > cut.getTime()) continue;
    if (b.openingAt !== null && written.getTime() <= b.openingAt.getTime()) continue;
    if (r.kind === "received") b.received += r.qty;
    else if (r.kind === "given") b.given += r.qty;
    else if (r.kind === "reversal") b.given -= r.qty;
    else if (r.kind === "wasted") b.wasted += r.qty;
    else if (r.kind === "returned") b.returned += r.qty;
    else if (r.kind === "transfer_in") b.transferredIn += r.qty;
    else if (r.kind === "transfer_out") b.transferredOut += r.qty;
  }
  for (const b of out.values()) {
    for (const k of ["received", "given", "wasted", "returned", "transferredIn", "transferredOut"] as const) b[k] = r3(b[k]);
    b.expected = r3(b.opening + b.received + b.transferredIn - b.given - b.wasted - b.returned - b.transferredOut);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.unit.localeCompare(b.unit));
}

/** The ward (or hall) a bed sits in: bed → (room) → ward, as `admissionPlace` walks it. */
async function wardOfBed(tx: Tx, bedId: string): Promise<string | null> {
  let cur = (await tx.select({ id: resources.id, kind: resources.kind, parentId: resources.parentId }).from(resources).where(eq(resources.id, bedId)))[0];
  for (let i = 0; i < 4 && cur !== undefined && cur.parentId !== null; i += 1) {
    cur = (await tx.select({ id: resources.id, kind: resources.kind, parentId: resources.parentId }).from(resources).where(eq(resources.id, cur.parentId)))[0];
    if (cur !== undefined && (cur.kind === "ward" || cur.kind === "hall")) return cur.id;
  }
  return null;
}

/** One ward move: the transfer's id (or the swap's), and the bed the patient left. */
export type NarcoticMove = { moveId: string; fromBedId: string };

/**
 * THE PATIENT'S UNITS GO WITH THE PATIENT — and a SHORTFALL BELONGS TO THE WARD (DECIDED, coordinator 2026-10-14, standard
 * NDPS practice; never to the patient, never to another patient). After a transfer or a bed swap puts the patient on
 * another ward, the patient's own unused units on the ward LEFT move to the new ward's cabinet — a `transfer_out` row
 * there and a `transfer_in` row here, in the move's own transaction, both keyed on the move (`act_id` = `moveId`):
 *   · moved = min(the patient's own unused units on the old ward during THIS stay there, what that ward's register still
 *     holds of the drug); a shortfall stays on the old ward's books as ITS discrepancy (its next count flags it);
 *   · "this stay there" = the patient's rows on that ward written since they last arrived on it — rows of an earlier stay
 *     were settled when they left it, so a remainder a short ward kept is never swept again by a later move;
 *   · only the ward just left (`fromBedId`'s ward), never an older one; a move within one ward moves nothing;
 *   · exactly once per move: a move whose rows exist moves nothing more (a replayed or retried transfer).
 */
export async function followNarcoticsIn(tx: Tx, actor: Actor, admissionId: string, at: Date, move: NarcoticMove): Promise<number> {
  const here = (await admissionPlace(tx, admissionId))?.wardId ?? null;
  if (here === null) return 0;
  const done = await tx.select({ id: ipdEmarNarcoticRegister.id }).from(ipdEmarNarcoticRegister).where(and(
    eq(ipdEmarNarcoticRegister.admissionId, admissionId), eq(ipdEmarNarcoticRegister.actId, move.moveId),
    inArray(ipdEmarNarcoticRegister.kind, ["transfer_out", "transfer_in"]),
  )).limit(1);
  if (done.length > 0) return 0;
  const from = await wardOfBed(tx, move.fromBedId);
  if (from === null || from === here) return 0;
  // The patient last arrived on `from` when a stay on another ward ended (stays are one after another).
  const stays = await tx.select({ bedId: ipdBedStays.bedId, endedAt: ipdBedStays.endedAt }).from(ipdBedStays)
    .where(and(eq(ipdBedStays.admissionId, admissionId), isNotNull(ipdBedStays.endedAt)));
  let arrived: number | null = null;
  for (const st of stays) {
    if (st.endedAt === null || (arrived !== null && st.endedAt.getTime() <= arrived)) continue;
    if ((await wardOfBed(tx, st.bedId)) !== from) arrived = st.endedAt.getTime();
  }
  const rows = await tx.select().from(ipdEmarNarcoticRegister)
    .where(and(eq(ipdEmarNarcoticRegister.admissionId, admissionId), eq(ipdEmarNarcoticRegister.wardId, from)));
  const held = new Map<string, { orderId: string; unit: string; qty: number }>();
  for (const r of rows) {
    if (arrived !== null && (r.recordedAt ?? r.at).getTime() < arrived) continue;
    const k = `${r.orderId}\u0000${r.unit}`;
    const h = held.get(k) ?? { orderId: r.orderId, unit: r.unit, qty: 0 };
    h.qty += (SIGN[r.kind] ?? 0) * r.qty;
    held.set(k, h);
  }
  if (held.size === 0) return 0;
  const medicineOf = new Map((await tx.select({ id: ipdOrders.id, medicineId: ipdOrders.medicineId }).from(ipdOrders)
    .where(inArray(ipdOrders.id, [...new Set([...held.values()].map((h) => h.orderId))]))).map((o) => [o.id, o.medicineId] as const));
  const left = new Map((await wardNarcoticBalances(tx, from)).map((b) => [balanceKey(b.medicineId, b.unit), b.expected] as const));
  let moved = 0;
  for (const h of held.values()) {
    const medicineId = medicineOf.get(h.orderId) ?? null;
    if (medicineId === null) continue;
    const k = balanceKey(medicineId, h.unit);
    const qty = r3(Math.min(h.qty, left.get(k) ?? 0));
    if (qty <= 0) continue;
    left.set(k, r3((left.get(k) ?? 0) - qty));
    const base = { orderId: h.orderId, admissionId, qty, unit: h.unit, actId: move.moveId, actorId: actor.id, at, recordedAt: at, reason: "Moved with the patient" };
    await tx.insert(ipdEmarNarcoticRegister).values([
      { ...base, id: newId(), kind: "transfer_out", wardId: from },
      { ...base, id: newId(), kind: "transfer_in", wardId: here },
    ]);
    moved += 1;
  }
  return moved;
}
