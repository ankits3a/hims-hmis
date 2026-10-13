import { and, asc, eq, isNull } from "drizzle-orm";
import { istDayString } from "../../kernel/approvals/cumulative";
import { ipdChargeLines, ipdFinalBills } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * #763 — WHICH RUNNING-BILL LINES A SETTLED BILL HAS ALREADY TAKEN. An admission may carry a final bill (seq 0) and
 * supplementary bills (seq 1, 2…); a voided bill keeps its row but covers nothing. Each live bill records the lines it
 * composed (`line_ids`, a reversed pair included), so the next bill composes exactly the rest — no line is billed twice
 * and none is lost. A bill written before #763 has no list: it covers every line posted at or before its settlement.
 *
 * DECIDED $ (#763, review #762 RED 4 kept): the IST day a bill was settled is CLOSED by that bill (the bill is final at
 * settlement; the presumed exit is the settle instant). Posting resumes from the next IST day under the ordinary day rule
 * — a patient still in a bed through that day, or leaving after 14:00 on it, is charged for it, and those lines are the
 * supplementary bill's. A void reopens everything the bill closed.
 *
 * A leaf file (schema reads only): `charges.ts` and `discharge-bill.ts` both need it, and `discharge-bill.ts` imports
 * `charges.ts`.
 */
export type BillRow = typeof ipdFinalBills.$inferSelect;

/** The admission's live (not voided) bills, final first. */
export async function liveBills(db: Db | Tx, admissionId: string): Promise<BillRow[]> {
  return db.select().from(ipdFinalBills).where(and(eq(ipdFinalBills.admissionId, admissionId), isNull(ipdFinalBills.voidedAt)))
    .orderBy(asc(ipdFinalBills.seq));
}

/** The line ids the live bills have taken (see the header for a bill written before #763). */
export function coveredLineIds(bills: readonly BillRow[], lines: readonly { id: string; postedAt: Date }[]): Set<string> {
  const out = new Set<string>();
  for (const b of bills) {
    if (b.lineIds.length > 0) { for (const id of b.lineIds) out.add(id); continue; }
    for (const l of lines) if (l.postedAt.getTime() <= b.settledAt.getTime()) out.add(l.id);
  }
  return out;
}

/** The last IST day a live bill closed (its settlement day), or null when no bill is live. */
export function closedThroughOf(bills: readonly BillRow[]): string | null {
  let out: string | null = null;
  for (const b of bills) {
    const d = istDayString(b.settledAt);
    if (out === null || d > out) out = d;
  }
  return out;
}

/** True when a live bill has taken this line (a reversal of it would leave the bill wrong: void the bill first). */
export async function lineIsBilled(db: Db | Tx, admissionId: string, lineId: string): Promise<boolean> {
  const bills = await liveBills(db, admissionId);
  if (bills.length === 0) return false;
  const lines = await db.select({ id: ipdChargeLines.id, postedAt: ipdChargeLines.postedAt }).from(ipdChargeLines)
    .where(eq(ipdChargeLines.admissionId, admissionId));
  return coveredLineIds(bills, lines).has(lineId);
}

/** True when a live final bill exists and a non-reversed line waits that no live bill has taken (the supplementary bill's). */
export async function hasUnbilledLines(db: Db | Tx, admissionId: string): Promise<boolean> {
  const bills = await liveBills(db, admissionId);
  if (!bills.some((b) => b.kind === "final")) return false;
  const lines = await db.select({ id: ipdChargeLines.id, postedAt: ipdChargeLines.postedAt, reversalOf: ipdChargeLines.reversalOf })
    .from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, admissionId));
  const covered = coveredLineIds(bills, lines);
  const reversed = new Set(lines.flatMap((l) => (l.reversalOf === null ? [] : [l.reversalOf])));
  return lines.some((l) => !covered.has(l.id) && l.reversalOf === null && !reversed.has(l.id));
}
