import { and, eq, gte, inArray, lt, notInArray } from "drizzle-orm";
import { istDayString } from "../../kernel/approvals/cumulative";
import { grnLines, grns, purchaseOrderLines, purchaseOrders, storesQuotes, storesRfqSteps, storesRfqs, vendors } from "../../kernel/db/schema";
import { STORES_BUYING_MANAGE, STORES_MASTERS, holds } from "./access";
import { ex } from "./buying-common";
import { StoresError } from "./errors";
import type { Actor, WireSupplierScorecard } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S5c (#1115, decision 13; D23) — THE SUPPLIER'S SCORECARD, READ FROM ROWS, NEVER TYPED AND NEVER FROM A MODEL.
 *
 * For one calendar quarter (`2026-Q4` = October to December, IST dates):
 *   on time   GRNs dated in the quarter (the challan date the storekeeper typed: the delivery day) against a PO with an
 *             expected date, whose date is on or before it. The capture instant is the database's clock, so it is not
 *             the date (DECIDED).
 *   fill      over the POs ordered (sent, part or wholly received) whose expected date falls in the quarter: base units
 *             received ÷ base units ordered.
 *   rejected  over the lines of those GRNs: base units rejected at QC ÷ base units delivered.
 *   drift     over the ACCEPTED lines of those GRNs: Σ qty × GRN cost per base unit against Σ qty × the PO's net rate per
 *             base unit, in basis points (+ = paid above the order). The PO's rate is the contract or awarded rate, so
 *             this is decision 13's "GRN rate vs contract" for every ordered line.
 *   response  RFQ invitations sent in the quarter that were answered with a quote.
 * Every figure is a numerator and a denominator, so a screen says "2 of 3", never a bare percentage of nothing.
 * Pharmacy's own receipts of the same supplier count too: one supplier list (decision 0099), read only.
 */
export type Share = { num: number; den: number };

const QUARTER_RE = /^(\d{4})-Q([1-4])$/;

export function quarterBounds(quarter: string): { from: string; to: string } {
  const m = QUARTER_RE.exec(quarter);
  if (m === null) throw new StoresError("bad_month", "a quarter is YYYY-Qn", { quarter });
  const y = Number(m[1]);
  const q = Number(m[2]);
  const from = `${String(y)}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`;
  const to = q === 4 ? `${String(y + 1)}-01-01` : `${String(y)}-${String(q * 3 + 1).padStart(2, "0")}-01`;
  return { from, to };
}

/** The quarter an instant falls in (IST). */
export function quarterOf(now: Date): string {
  const day = istDayString(now);
  return `${day.slice(0, 4)}-Q${String(Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1)}`;
}

const ORDERED = ["sent", "part_received", "received"] as const;

/** The figures alone (no permission check): the RFQ draft's supplier order and the comparative's tie use them. */
export async function scorecardFigures(db: Db | Tx, vendorId: string, quarter: string): Promise<Omit<WireSupplierScorecard, "vendorId" | "name" | "quarter" | "from" | "to">> {
  const { from, to } = quarterBounds(quarter);
  const lines = await ex(db).select({
    day: grns.challanDate, expected: purchaseOrders.expectedDate, grnId: grns.id, itemId: grnLines.itemId, qty: grnLines.qtyBase,
    rejected: grnLines.qtyRejectedBase, cost: grnLines.unitCostPaise, free: grnLines.freeGoods, poId: purchaseOrders.id,
  }).from(grns).innerJoin(grnLines, eq(grnLines.grnId, grns.id)).innerJoin(purchaseOrders, eq(purchaseOrders.id, grns.purchaseOrderId))
    .where(and(eq(grns.vendorId, vendorId), notInArray(grns.status, ["draft", "cancelled"]), gte(grns.challanDate, from), lt(grns.challanDate, to)));

  // On time: one verdict per GRN.
  const byGrn = new Map<string, { day: string; expected: string | null }>();
  for (const l of lines) byGrn.set(l.grnId, { day: l.day, expected: l.expected });
  const dated = [...byGrn.values()].filter((g) => g.expected !== null);
  const onTime: Share = { num: dated.filter((g) => g.day <= g.expected!).length, den: dated.length };

  const rejected: Share = { num: lines.reduce((a, l) => a + l.rejected, 0), den: lines.reduce((a, l) => a + l.qty, 0) };

  // Drift on accepted, paid lines, against the PO line of the same item.
  const poIds = [...new Set(lines.map((l) => l.poId))];
  const poLines = poIds.length === 0 ? [] : await ex(db).select().from(purchaseOrderLines).where(inArray(purchaseOrderLines.purchaseOrderId, poIds));
  let paid = 0;
  let ref = 0;
  for (const l of lines) {
    if (l.rejected > 0 || l.free) continue;
    const pl = poLines.find((p) => p.purchaseOrderId === l.poId && p.itemId === l.itemId);
    if (pl === undefined) continue;
    paid += l.qty * l.cost;
    ref += l.qty * (pl.ratePaise / pl.multiplier);
  }
  const priceDriftBps = ref > 0 ? Math.round(((paid - ref) * 10_000) / ref) : null;

  const ordered = await ex(db).select({ qty: purchaseOrderLines.qtyPacks, mult: purchaseOrderLines.multiplier, got: purchaseOrderLines.receivedBase })
    .from(purchaseOrders).innerJoin(purchaseOrderLines, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
    .where(and(eq(purchaseOrders.vendorId, vendorId), inArray(purchaseOrders.status, [...ORDERED]), gte(purchaseOrders.expectedDate, from), lt(purchaseOrders.expectedDate, to)));
  const fill: Share = { num: ordered.reduce((a, o) => a + o.got, 0), den: ordered.reduce((a, o) => a + o.qty * o.mult, 0) };

  // RFQ response: each sending names its invitees; a quote from one of them on that RFQ answers it.
  const fromAt = new Date(`${from}T00:00:00+05:30`);
  const toAt = new Date(`${to}T00:00:00+05:30`);
  const sends = await ex(db).select({ rfqId: storesRfqSteps.rfqId, vendorIds: storesRfqSteps.vendorIds }).from(storesRfqSteps)
    .innerJoin(storesRfqs, eq(storesRfqs.id, storesRfqSteps.rfqId))
    .where(and(eq(storesRfqSteps.kind, "sent"), gte(storesRfqSteps.at, fromAt), lt(storesRfqSteps.at, toAt)));
  const asked = [...new Set(sends.filter((s) => (s.vendorIds ?? []).includes(vendorId)).map((s) => s.rfqId))];
  const answered = asked.length === 0 ? 0 : new Set((await ex(db).select({ rfqId: storesQuotes.rfqId }).from(storesQuotes)
    .where(and(eq(storesQuotes.vendorId, vendorId), inArray(storesQuotes.rfqId, asked)))).map((r) => r.rfqId)).size;
  const rfqResponse: Share = { num: answered, den: asked.length };

  return { onTime, fill, rejected, priceDriftBps, rfqResponse, score: scoreOf({ onTime, fill, rejected, rfqResponse }) };
}

/**
 * ONE NUMBER, FOR ORDERING ONLY (the RFQ draft's suggestions, a price tie in the comparative): the mean of the shares
 * that have a denominator, rejected counted as its complement. Never shown as a grade, never a weight in the ranks
 * (decision 8: humans judge). Null with no history: such a supplier sorts after those with one.
 */
export function scoreOf(f: { onTime: Share; fill: Share; rejected: Share; rfqResponse: Share }): number | null {
  const parts: number[] = [];
  if (f.onTime.den > 0) parts.push(f.onTime.num / f.onTime.den);
  if (f.fill.den > 0) parts.push(Math.min(1, f.fill.num / f.fill.den));
  if (f.rejected.den > 0) parts.push(1 - f.rejected.num / f.rejected.den);
  if (f.rfqResponse.den > 0) parts.push(f.rfqResponse.num / f.rfqResponse.den);
  return parts.length === 0 ? null : Math.round((parts.reduce((a, p) => a + p, 0) / parts.length) * 1000) / 1000;
}

/** `supplierScorecard(vendorId, quarter)` for the buying desk and the materials head. Read only: writes nothing. */
export async function supplierScorecard(db: Db, actor: Actor, vendorId: string, quarter: string, now: Date = new Date()): Promise<WireSupplierScorecard> {
  void now;
  if (!(await holds(db, actor, STORES_BUYING_MANAGE)) && !(await holds(db, actor, STORES_MASTERS))) {
    throw new StoresError("not_permitted", "the scorecard is the buying desk's", { permission: STORES_BUYING_MANAGE });
  }
  const [v] = await db.select({ id: vendors.id, legal: vendors.legalName, trade: vendors.tradeName }).from(vendors).where(eq(vendors.id, vendorId));
  if (v === undefined) throw new StoresError("unknown_vendor", "no such supplier", { vendorId });
  const { from, to } = quarterBounds(quarter);
  return { vendorId, name: v.trade ?? v.legal, quarter, from, to, ...(await scorecardFigures(db, vendorId, quarter)) };
}
