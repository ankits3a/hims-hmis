import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { ipdEmarNarcoticRegister, ipdNarcoticCountResolutions, ipdNarcoticCounts, ipdOrders } from "../../kernel/db/schema";
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

/**
 * THE PATIENT'S UNITS GO WITH THE PATIENT (DECIDED): after a transfer or a bed swap puts the patient on another ward, every
 * unit of this admission still on an earlier ward's register moves to the new ward's cabinet — a `transfer_out` row there
 * and a `transfer_in` row here, in the move's own transaction. Idempotent: a second call finds nothing left behind.
 */
export async function followNarcoticsIn(tx: Tx, actor: Actor, admissionId: string, at: Date): Promise<number> {
  const here = (await admissionPlace(tx, admissionId))?.wardId ?? null;
  if (here === null) return 0;
  const rows = await tx.select().from(ipdEmarNarcoticRegister)
    .where(and(eq(ipdEmarNarcoticRegister.admissionId, admissionId), isNotNull(ipdEmarNarcoticRegister.wardId)));
  const held = new Map<string, { wardId: string; orderId: string; unit: string; qty: number }>();
  for (const r of rows) {
    if (r.wardId === here) continue;
    const k = `${r.wardId!}\u0000${r.orderId}\u0000${r.unit}`;
    const h = held.get(k) ?? { wardId: r.wardId!, orderId: r.orderId, unit: r.unit, qty: 0 };
    h.qty += (SIGN[r.kind] ?? 0) * r.qty;
    held.set(k, h);
  }
  if (held.size === 0) return 0;
  let moved = 0;
  // Never more than the old ward's register still holds of that drug: a count a supervisor agreed below the patient's own
  // ledger (a broken ampoule) already took the difference off the ward, and must not leave that ward negative.
  const wardLeft = new Map<string, Map<string, number>>();
  const medicineOf = new Map((await tx.select({ id: ipdOrders.id, medicineId: ipdOrders.medicineId }).from(ipdOrders)
    .where(inArray(ipdOrders.id, [...new Set([...held.values()].map((h) => h.orderId))]))).map((o) => [o.id, o.medicineId] as const));
  for (const h of held.values()) {
    const medicineId = medicineOf.get(h.orderId) ?? null;
    if (medicineId === null) continue;
    let left = wardLeft.get(h.wardId);
    if (left === undefined) {
      left = new Map((await wardNarcoticBalances(tx, h.wardId)).map((b) => [balanceKey(b.medicineId, b.unit), b.expected] as const));
      wardLeft.set(h.wardId, left);
    }
    const k = balanceKey(medicineId, h.unit);
    const qty = r3(Math.min(h.qty, left.get(k) ?? 0));
    if (qty <= 0) continue;
    left.set(k, r3((left.get(k) ?? 0) - qty));
    const base = { orderId: h.orderId, admissionId, qty, unit: h.unit, actorId: actor.id, at, recordedAt: at, reason: "Moved with the patient" };
    await tx.insert(ipdEmarNarcoticRegister).values([
      { ...base, id: newId(), kind: "transfer_out", wardId: h.wardId },
      { ...base, id: newId(), kind: "transfer_in", wardId: here },
    ]);
    moved += 1;
  }
  return moved;
}
