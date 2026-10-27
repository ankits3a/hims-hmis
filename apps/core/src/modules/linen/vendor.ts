import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import {
  addLinenVendorInput, checkVendorBillInput, decideBillInput, decideRecoveryInput, LINEN_LOST_AFTER_DAYS, linenBelowPar, newId,
  raiseRecoveryInput, recordChallanReturnInput, setLinenItemCostInput, setVendorRateInput,
} from "@hmis/contracts";
import { istDayString, istDayWindow } from "../../kernel/approvals/cumulative";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  linenChallanReturns, linenChallans, linenCondemnRequests, linenItems, linenLaundryBatches, linenMovements, linenRecoveries,
  linenVendorBills, linenVendorRates, linenVendors,
} from "../../kernel/db/schema";
import { lastPurchaseByItem } from "../materials";
import { LinenError } from "./errors";
import { lock, movement, parse, requireItems, stamp, tx } from "./intents";
import { LINEN_BILL_APPROVE, LINEN_RECOVERY_APPROVE } from "./manifest";
import type {
  Actor, LinenBillCard, LinenChallanCard, LinenChallanLine, LinenRecoveryLineView, LinenReversal, LinenVendorCard,
  LinenVendorMonthReport,
} from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { LinenRecoveryLine } from "../../kernel/db/schema";
import type { BatchRow, Exec, Line } from "./intents";

/**
 * ═══ VENDOR LAUNDRY (LD-2, #979, decisions 0087 and 0092, D1 D2 D3 D4) ═══
 *
 * Vendor laundry is LIVE once one active `linen_vendors` row exists. From then on a vendor batch leaves only on an
 * outward challan (vendor + dock weight; items and counts are the batch's own lines), and comes back against it: each
 * piece accepted (to the store), refused damaged (to the store, then a four-eyes condemn request), or refused stained
 * (back to the vendor for a free rewash: still out on the challan). Before any vendor exists the LD-1 hand receipt
 * stands, so a hospital without a vendor is not blocked (DECIDED).
 *
 * Money is paise. The monthly report is computed on read; a recovery freezes its lines when raised, and is approved
 * (possibly edited) or rejected by the owner or finance (`linen.recovery.approve`), never by its proposer. A piece of an
 * approved recovery's lost line that comes back later is reversed on a later month's report and its next recovery.
 * The bill check pays accepted pieces × the rate in force on each return date + GST − approved recoveries; a bill above
 * that holds the excess until stores (`linen.bill.approve`) approves it, never the person who checked the bill.
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* ═══════════════════════════════ IST months ═══════════════════════════════ */

/** The IST calendar day of an instant, `YYYY-MM-DD`. */
export const istDayOf = (at: Date): string => istDayString(at);
/** The IST month of an instant, `YYYY-MM`. */
export const istMonthOf = (at: Date): string => istDayString(at).slice(0, 7);
/** The instant the IST month of `at` begins. */
export function istMonthStart(at: Date): Date {
  const day = Number(istDayString(at).slice(8, 10));
  return istDayWindow(new Date(at.getTime() - (day - 1) * DAY)).start;
}
/** [start, end) of an IST month `YYYY-MM`. */
export function istMonthWindow(month: string): { start: Date; end: Date } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  // The 15th at noon UTC is inside the same IST month whatever the offset.
  return { start: istMonthStart(new Date(Date.UTC(y, m - 1, 15, 12))), end: istMonthStart(new Date(Date.UTC(y, m, 15, 12))) };
}

/* ═══════════════════════════════ vendors, rates, item cost ═══════════════════════════════ */

export type VendorRow = typeof linenVendors.$inferSelect;
export type ChallanRow = typeof linenChallans.$inferSelect;
export type RecoveryRow = typeof linenRecoveries.$inferSelect;
export type BillRow = typeof linenVendorBills.$inferSelect;

export async function vendorLaundryLive(exec: Exec): Promise<boolean> {
  return (await exec.select({ id: linenVendors.id }).from(linenVendors).where(eq(linenVendors.active, true)).limit(1)).length > 0;
}

async function vendorFor(exec: Exec, id: string): Promise<VendorRow> {
  const v = (await exec.select().from(linenVendors).where(eq(linenVendors.id, id)))[0];
  if (v === undefined || !v.active) throw new LinenError("unknown_vendor", { linenVendorId: id });
  return v;
}

export async function addLinenVendor(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<VendorRow> {
  const input = parse(addLinenVendorInput, raw);
  return tx(exec, async (t) => {
    await lock(t, "vendors");
    const now = await stamp(t, nowIn);
    if ((await t.select({ id: linenVendors.id }).from(linenVendors).where(eq(linenVendors.name, input.name))).length > 0) {
      throw new LinenError("vendor_taken", { name: input.name });
    }
    const routine = input.turnaroundHours ?? 24;
    return (await t.insert(linenVendors).values({
      id: newId(), name: input.name, vendorId: input.vendorId ?? null, turnaroundHours: routine,
      rushTurnaroundHours: Math.min(input.rushTurnaroundHours ?? 12, routine), gstRateBps: input.gstRateBps ?? 1800,
      createdBy: actor.id, createdAt: now,
    }).returning())[0]!;
  });
}

export async function setVendorRate(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<{ id: string }> {
  const input = parse(setVendorRateInput, raw);
  return tx(exec, async (t) => {
    await vendorFor(t, input.linenVendorId);
    await requireItems(t, [{ itemCode: input.itemCode, qty: 1 }]);
    const now = await stamp(t, nowIn);
    const row = (await t.insert(linenVendorRates).values({
      id: newId(), linenVendorId: input.linenVendorId, itemCode: input.itemCode, ratePaise: input.ratePaise,
      effectiveFrom: input.effectiveFrom, setBy: actor.id, setAt: now,
    }).onConflictDoUpdate({
      target: [linenVendorRates.linenVendorId, linenVendorRates.itemCode, linenVendorRates.effectiveFrom],
      set: { ratePaise: input.ratePaise, setBy: actor.id, setAt: now },
    }).returning())[0]!;
    return { id: row.id };
  });
}

/** The rate card of one vendor, newest first per item; `rateOn` picks the row in force on a day. */
async function rateCard(exec: Exec, vendorId: string): Promise<Map<string, { from: string; paise: number }[]>> {
  const rows = await exec.select().from(linenVendorRates).where(eq(linenVendorRates.linenVendorId, vendorId))
    .orderBy(desc(linenVendorRates.effectiveFrom));
  const out = new Map<string, { from: string; paise: number }[]>();
  for (const r of rows) out.set(r.itemCode, [...(out.get(r.itemCode) ?? []), { from: r.effectiveFrom, paise: r.ratePaise }]);
  return out;
}
const rateOn = (card: Map<string, { from: string; paise: number }[]>, itemCode: string, day: string): number | null =>
  (card.get(itemCode) ?? []).find((r) => r.from <= day)?.paise ?? null;

export async function setLinenItemCost(exec: Exec, _actor: Actor, raw: unknown): Promise<{ itemCode: string }> {
  const input = parse(setLinenItemCostInput, raw);
  return tx(exec, async (t) => {
    await requireItems(t, [{ itemCode: input.itemCode, qty: 1 }]);
    const set: Partial<typeof linenItems.$inferInsert> = {};
    if (input.materialsItemId !== undefined) set.materialsItemId = input.materialsItemId;
    if (input.pricePaise !== undefined) set.pricePaise = input.pricePaise;
    if (Object.keys(set).length > 0) await t.update(linenItems).set(set).where(eq(linenItems.code, input.itemCode));
    return { itemCode: input.itemCode };
  });
}

/**
 * The replacement cost of one piece (decision 0092): the last stores goods-receipt price of the item it is bought as
 * (per base unit = per piece), else the linen item master's price; neither → unpriced (0, `priced: false`).
 */
export async function replacementCosts(exec: Exec, codes: readonly string[]): Promise<Map<string, { unitPaise: number; priced: boolean; source: "grn" | "item_master" | null }>> {
  const out = new Map<string, { unitPaise: number; priced: boolean; source: "grn" | "item_master" | null }>();
  if (codes.length === 0) return out;
  const rows = await exec.select({ code: linenItems.code, mat: linenItems.materialsItemId, price: linenItems.pricePaise })
    .from(linenItems).where(inArray(linenItems.code, [...new Set(codes)]));
  const mats = rows.map((r) => r.mat).filter((m): m is string => m !== null);
  const grn = await lastPurchaseByItem(exec as Db, mats);
  for (const r of rows) {
    const last = r.mat === null ? undefined : grn.get(r.mat);
    if (last !== undefined && last.multiplier > 0) out.set(r.code, { unitPaise: Math.round(last.ratePaise / last.multiplier), priced: true, source: "grn" });
    else if (r.price !== null) out.set(r.code, { unitPaise: r.price, priced: true, source: "item_master" });
    else out.set(r.code, { unitPaise: 0, priced: false, source: null });
  }
  return out;
}

/* ═══════════════════════════════ challans (D1) ═══════════════════════════════ */

export type ChallanInput = { linenVendorId?: string | undefined; weightGrams?: number | undefined; rush?: boolean | undefined };

/**
 * The outward challan of a vendor batch, written in the act that sends it (`sendToLaundry`, `routeToVendor`). While
 * vendor laundry is not live (no vendor set up) a batch without vendor details leaves as in LD-1; with a vendor named,
 * or once live, the vendor and the weight are required (`challan_required`).
 */
export async function writeChallan(t: Tx, actor: Actor, batch: BatchRow, input: ChallanInput, lines: readonly Line[], now: Date): Promise<ChallanRow | null> {
  const live = await vendorLaundryLive(t);
  if (!live && input.linenVendorId === undefined) return null;
  if (input.linenVendorId === undefined || input.weightGrams === undefined) throw new LinenError("challan_required", { batchId: batch.id });
  const v = await vendorFor(t, input.linenVendorId);
  const merged = new Map<string, number>();
  for (const l of lines) merged.set(l.itemCode, (merged.get(l.itemCode) ?? 0) + l.qty);
  const rush = input.rush === true || batch.stream === "theatre";
  return (await t.insert(linenChallans).values({
    id: newId(), challanNo: `CH-${batch.batchNo}`, batchId: batch.id, linenVendorId: v.id,
    lines: [...merged].map(([itemCode, qty]) => ({ itemCode, qty })), pieces: [...merged.values()].reduce((n, q) => n + q, 0),
    weightGrams: input.weightGrams, rush, sentAt: now, dueAt: new Date(now.getTime() + (rush ? v.rushTurnaroundHours : v.turnaroundHours) * HOUR),
    sentBy: actor.id,
  }).returning())[0]!;
}

export async function challanFor(exec: Exec, batchId: string): Promise<ChallanRow | null> {
  return (await exec.select().from(linenChallans).where(eq(linenChallans.batchId, batchId)))[0] ?? null;
}

type ReturnRow = typeof linenChallanReturns.$inferSelect;

function challanLines(c: ChallanRow, returns: readonly ReturnRow[]): LinenChallanLine[] {
  return c.lines.map((l) => {
    const mine = returns.filter((r) => r.challanId === c.id && r.itemCode === l.itemCode);
    const accepted = mine.reduce((n, r) => n + r.accepted, 0);
    const damaged = mine.reduce((n, r) => n + r.damaged, 0);
    const stained = mine.reduce((n, r) => n + r.stained, 0);
    return { itemCode: l.itemCode, sent: l.qty, accepted, damaged, stained, missing: l.qty - accepted - damaged };
  });
}

/**
 * Late (DECIDED, spec #979): any of it came back after its turnaround. Pieces that never come back are lost, counted
 * apart; a piece that comes back late makes the batch late then.
 */
function challanLate(c: ChallanRow, returns: readonly ReturnRow[]): boolean {
  return returns.some((r) => r.challanId === c.id && r.returnedAt > c.dueAt);
}
/** For the desk: late, or still out past its due instant (overdue). */
function challanOverdue(c: ChallanRow, returns: readonly ReturnRow[], now: Date): boolean {
  return challanLate(c, returns) || (now > c.dueAt && challanLines(c, returns).some((l) => l.missing > 0));
}

/**
 * At the dock, against a challan, per item: accepted (to the store), refused damaged (to the store and a condemn request
 * a second person decides), refused stained (back to the vendor; still out). Never more than is still out
 * (`more_than_sent`). When nothing is out any more the challan closes and the batch is received.
 */
export async function recordChallanReturn(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<{
  challanId: string; lines: LinenChallanLine[]; condemnRequests: number; movements: number; closed: boolean;
}> {
  const input = parse(recordChallanReturnInput, raw);
  return tx(exec, async (t) => {
    const c = (await t.select().from(linenChallans).where(eq(linenChallans.id, input.challanId)).for("update"))[0];
    if (c === undefined) throw new LinenError("unknown_challan", { challanId: input.challanId });
    if (c.closedAt !== null) throw new LinenError("challan_closed", { challanId: c.id });
    const now = await stamp(t, nowIn);
    const before = await t.select().from(linenChallanReturns).where(eq(linenChallanReturns.challanId, c.id));
    const out = challanLines(c, before);
    const seen = new Set<string>();
    for (const l of input.lines) {
      if (seen.has(l.itemCode)) throw new LinenError("duplicate_item", { itemCode: l.itemCode });
      seen.add(l.itemCode);
      const line = out.find((o) => o.itemCode === l.itemCode);
      if (line === undefined) throw new LinenError("not_in_batch", { itemCode: l.itemCode });
      if (l.accepted + l.damaged + l.stained > line.missing) throw new LinenError("more_than_sent", { itemCode: l.itemCode, out: line.missing });
    }
    const batch = (await t.select().from(linenLaundryBatches).where(eq(linenLaundryBatches.id, c.batchId)))[0]!;
    let requests = 0;
    let moved = 0;
    for (const l of input.lines) {
      if (l.accepted + l.damaged + l.stained === 0) continue;
      let condemnRequestId: string | null = null;
      if (l.damaged > 0) {
        condemnRequestId = (await t.insert(linenCondemnRequests).values({
          id: newId(), wardResourceId: null, itemCode: l.itemCode, qty: l.damaged, reason: `Damaged by the laundry vendor, challan ${c.challanNo}`,
          state: "requested", requestedBy: actor.id, requestedAt: now,
        }).returning())[0]!.id;
        requests += 1;
      }
      await t.insert(linenChallanReturns).values({
        id: newId(), challanId: c.id, itemCode: l.itemCode, accepted: l.accepted, damaged: l.damaged, stained: l.stained,
        condemnRequestId, returnedAt: now, recordedBy: actor.id,
      });
      const back = l.accepted + l.damaged;
      if (back > 0) {
        await t.insert(linenMovements).values(movement("laundry_in", { itemCode: l.itemCode, qty: back }, actor, now, { batchId: c.batchId }));
        moved += 1;
      }
    }
    const after = await t.select().from(linenChallanReturns).where(eq(linenChallanReturns.challanId, c.id));
    const lines = challanLines(c, after);
    const closed = lines.every((l) => l.missing === 0);
    if (closed) {
      await t.update(linenChallans).set({ closedAt: now }).where(eq(linenChallans.id, c.id));
      await t.update(linenLaundryBatches).set({
        state: "received", receivedAt: now, receivedBy: actor.id, piecesReceived: lines.reduce((n, l) => n + l.accepted, 0),
      }).where(and(eq(linenLaundryBatches.id, batch.id), eq(linenLaundryBatches.state, "sent")));
    }
    return { challanId: c.id, lines, condemnRequests: requests, movements: moved, closed };
  });
}

export async function challanCards(exec: Exec, now: Date, where: { open?: boolean; vendorId?: string; limit?: number } = {}): Promise<LinenChallanCard[]> {
  const conds = [
    ...(where.open === true ? [isNull(linenChallans.closedAt)] : []),
    ...(where.vendorId === undefined ? [] : [eq(linenChallans.linenVendorId, where.vendorId)]),
  ];
  const rows = await exec.select({ c: linenChallans, name: linenVendors.name }).from(linenChallans)
    .innerJoin(linenVendors, eq(linenVendors.id, linenChallans.linenVendorId))
    .where(conds.length === 0 ? undefined : and(...conds)).orderBy(asc(linenChallans.dueAt)).limit(where.limit ?? 100);
  if (rows.length === 0) return [];
  const returns = await exec.select().from(linenChallanReturns).where(inArray(linenChallanReturns.challanId, rows.map((r) => r.c.id)));
  return rows.map(({ c, name }) => ({
    id: c.id, challanNo: c.challanNo, batchId: c.batchId, linenVendorId: c.linenVendorId, vendorName: name, pieces: c.pieces,
    weightGrams: c.weightGrams, rush: c.rush, sentAt: c.sentAt.toISOString(), dueAt: c.dueAt.toISOString(),
    late: challanOverdue(c, returns, now), open: c.closedAt === null, lines: challanLines(c, returns),
  }));
}

/* ═══════════════════════════════ the monthly report and recovery (D2, D3) ═══════════════════════════════ */

const toView = (l: LinenRecoveryLine): LinenRecoveryLineView => ({ ...l });

/** Pieces of an earlier approved recovery's lost lines that came back since it was raised, not yet reversed. */
async function pendingReversals(exec: Exec, vendorId: string, month: string, now: Date): Promise<LinenReversal[]> {
  const recs = await exec.select().from(linenRecoveries).where(and(
    eq(linenRecoveries.linenVendorId, vendorId), lt(linenRecoveries.month, month), ne(linenRecoveries.state, "rejected"),
  ));
  const approved = recs.filter((r) => r.state === "approved");
  if (approved.length === 0) return [];
  const all = await exec.select().from(linenRecoveries).where(and(eq(linenRecoveries.linenVendorId, vendorId), ne(linenRecoveries.state, "rejected")));
  const reversed = new Map<string, number>();
  for (const r of all) {
    for (const l of r.lines) {
      if (l.kind !== "reversal" || l.reversesRecoveryId === undefined) continue;
      const k = `${l.reversesRecoveryId}|${l.challanId}|${l.itemCode}`;
      reversed.set(k, (reversed.get(k) ?? 0) + l.qty);
    }
  }
  const out: LinenReversal[] = [];
  for (const rec of approved) {
    const lost = rec.lines.filter((l) => l.kind === "lost");
    if (lost.length === 0) continue;
    const returns = await exec.select().from(linenChallanReturns).where(and(
      inArray(linenChallanReturns.challanId, [...new Set(lost.map((l) => l.challanId))]),
      sql`${linenChallanReturns.returnedAt} > ${rec.proposedAt}`, lte(linenChallanReturns.returnedAt, now),
    ));
    for (const l of lost) {
      const back = returns.filter((r) => r.challanId === l.challanId && r.itemCode === l.itemCode).reduce((n, r) => n + r.accepted + r.damaged, 0);
      const qty = Math.min(l.qty, back) - (reversed.get(`${rec.id}|${l.challanId}|${l.itemCode}`) ?? 0);
      if (qty > 0) out.push({ recoveryId: rec.id, challanId: l.challanId, itemCode: l.itemCode, qty, amountPaise: -qty * l.unitPaise });
    }
  }
  return out;
}

/**
 * The month's vendor report (D2), computed on read: pieces sent on challans that month, pieces lost (still out 7 days
 * after the batch was due), damaged (refused damaged at the dock), batches and late batches; below par by the rule of
 * decisions 0087 and 0092 (`linenBelowPar`). Below par → a proposed recovery at replacement cost per piece; reversals
 * of earlier approved recoveries ride along (negative). Within par and nothing to reverse → none.
 */
export async function vendorMonthReport(exec: Exec, vendorId: string, month: string, now: Date): Promise<LinenVendorMonthReport> {
  const v = (await exec.select().from(linenVendors).where(eq(linenVendors.id, vendorId)))[0];
  if (v === undefined) throw new LinenError("unknown_vendor", { linenVendorId: vendorId });
  const w = istMonthWindow(month);
  const challans = await exec.select().from(linenChallans).where(and(
    eq(linenChallans.linenVendorId, vendorId), gte(linenChallans.sentAt, w.start), lt(linenChallans.sentAt, w.end),
  ));
  const returns = challans.length === 0 ? [] : await exec.select().from(linenChallanReturns).where(and(
    inArray(linenChallanReturns.challanId, challans.map((c) => c.id)), lte(linenChallanReturns.returnedAt, now),
  ));
  const lost: { challanId: string; itemCode: string; qty: number }[] = [];
  const damaged: { challanId: string; itemCode: string; qty: number }[] = [];
  let late = 0;
  for (const c of challans) {
    const lines = challanLines(c, returns);
    if (challanLate(c, returns)) late += 1;
    const isLost = now.getTime() >= c.dueAt.getTime() + LINEN_LOST_AFTER_DAYS * DAY;
    for (const l of lines) {
      if (isLost && l.missing > 0) lost.push({ challanId: c.id, itemCode: l.itemCode, qty: l.missing });
      if (l.damaged > 0) damaged.push({ challanId: c.id, itemCode: l.itemCode, qty: l.damaged });
    }
  }
  const facts = {
    piecesSent: challans.reduce((n, c) => n + c.pieces, 0), lost: lost.reduce((n, l) => n + l.qty, 0),
    damaged: damaged.reduce((n, l) => n + l.qty, 0), batches: challans.length, lateBatches: late,
  };
  const par = linenBelowPar(facts);
  const reversals = await pendingReversals(exec, vendorId, month, now);
  let proposed: LinenVendorMonthReport["proposed"] = null;
  if (par.belowPar || reversals.length > 0) {
    const costs = await replacementCosts(exec, [...lost, ...damaged].map((l) => l.itemCode));
    const priced = (kind: "lost" | "damaged", l: { challanId: string; itemCode: string; qty: number }): LinenRecoveryLine => {
      const c = costs.get(l.itemCode) ?? { unitPaise: 0, priced: false };
      return { kind, challanId: l.challanId, itemCode: l.itemCode, qty: l.qty, unitPaise: c.unitPaise, amountPaise: l.qty * c.unitPaise, priced: c.priced };
    };
    const lines: LinenRecoveryLine[] = [
      ...(par.belowPar ? [...lost.map((l) => priced("lost", l)), ...damaged.map((l) => priced("damaged", l))] : []),
      ...reversals.map((r): LinenRecoveryLine => ({
        kind: "reversal", challanId: r.challanId, itemCode: r.itemCode, qty: r.qty, unitPaise: r.qty === 0 ? 0 : -r.amountPaise / r.qty,
        amountPaise: r.amountPaise, priced: true, reversesRecoveryId: r.recoveryId,
      })),
    ];
    proposed = { lines: lines.map(toView), totalPaise: lines.reduce((n, l) => n + l.amountPaise, 0) };
  }
  const rec = (await exec.select().from(linenRecoveries).where(and(
    eq(linenRecoveries.linenVendorId, vendorId), eq(linenRecoveries.month, month), ne(linenRecoveries.state, "rejected"),
  )))[0];
  return {
    linenVendorId: v.id, vendorName: v.name, month, ...facts, belowPar: par.belowPar, lossBelowPar: par.loss, lateBelowPar: par.late,
    monthOver: now >= w.end, proposed, reversals,
    recovery: rec === undefined ? null : {
      id: rec.id, state: rec.state, proposedPaise: rec.proposedPaise, approvedPaise: rec.approvedPaise, proposedBy: rec.proposedBy,
    },
  };
}

/** Raise the month's recovery as the report proposes it (lines frozen). Once per vendor and month unless rejected. */
export async function raiseRecovery(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<RecoveryRow> {
  const input = parse(raiseRecoveryInput, raw);
  return tx(exec, async (t) => {
    await vendorFor(t, input.linenVendorId);
    await lock(t, `vendor:${input.linenVendorId}`);
    const now = await stamp(t, nowIn);
    if (now < istMonthWindow(input.month).end) throw new LinenError("month_open", { month: input.month });
    const report = await vendorMonthReport(t, input.linenVendorId, input.month, now);
    if (report.recovery !== null) throw new LinenError("recovery_exists", { recoveryId: report.recovery.id });
    if (report.proposed === null) throw new LinenError("within_par", { month: input.month });
    return (await t.insert(linenRecoveries).values({
      id: newId(), linenVendorId: input.linenVendorId, month: input.month, state: "proposed", lines: report.proposed.lines,
      proposedPaise: report.proposed.totalPaise, proposedBy: actor.id, proposedAt: now,
    }).returning())[0]!;
  });
}

async function decideRecovery(exec: Exec, actor: Actor, raw: unknown, nowIn: Date | undefined, approve: boolean): Promise<RecoveryRow> {
  const input = parse(decideRecoveryInput, raw);
  return tx(exec, async (t) => {
    const rec = (await t.select().from(linenRecoveries).where(eq(linenRecoveries.id, input.recoveryId)).for("update"))[0];
    if (rec === undefined) throw new LinenError("unknown_recovery", { recoveryId: input.recoveryId });
    if (rec.state !== "proposed") throw new LinenError("request_closed", { recoveryId: rec.id, state: rec.state });
    if (rec.proposedBy === actor.id) throw new LinenError("approver_is_requester", { recoveryId: rec.id });
    if (!(await hasPermission(t as unknown as Db, actor.id, LINEN_RECOVERY_APPROVE, "hospital"))) throw new LinenError("not_approver");
    const now = await stamp(t, nowIn);
    return (await t.update(linenRecoveries).set({
      state: approve ? "approved" : "rejected", approvedPaise: approve ? (input.amountPaise ?? rec.proposedPaise) : null,
      decidedBy: actor.id, decidedAt: now, note: input.note ?? null,
    }).where(eq(linenRecoveries.id, rec.id)).returning())[0]!;
  });
}

/** The owner or finance approves (optionally editing the amount); never the proposer (D3). */
export const approveRecovery = (exec: Exec, actor: Actor, raw: unknown, now?: Date): Promise<RecoveryRow> => decideRecovery(exec, actor, raw, now, true);
export const rejectRecovery = (exec: Exec, actor: Actor, raw: unknown, now?: Date): Promise<RecoveryRow> => decideRecovery(exec, actor, raw, now, false);

/* ═══════════════════════════════ the vendor bill (D4) ═══════════════════════════════ */

/** Pieces accepted per item in a month (by return date) and their value at the rate in force on each return date. */
async function acceptedInMonth(exec: Exec, vendorId: string, month: string): Promise<{ pieces: Map<string, number>; value: Map<string, number>; missingRate: string | null }> {
  const w = istMonthWindow(month);
  const rows = await exec.select({ r: linenChallanReturns }).from(linenChallanReturns)
    .innerJoin(linenChallans, eq(linenChallans.id, linenChallanReturns.challanId))
    .where(and(eq(linenChallans.linenVendorId, vendorId), gte(linenChallanReturns.returnedAt, w.start), lt(linenChallanReturns.returnedAt, w.end)));
  const card = await rateCard(exec, vendorId);
  const pieces = new Map<string, number>();
  const value = new Map<string, number>();
  let missingRate: string | null = null;
  for (const { r } of rows) {
    if (r.accepted === 0) continue;
    pieces.set(r.itemCode, (pieces.get(r.itemCode) ?? 0) + r.accepted);
    const rate = rateOn(card, r.itemCode, istDayString(r.returnedAt));
    if (rate === null) { missingRate ??= r.itemCode; continue; }
    value.set(r.itemCode, (value.get(r.itemCode) ?? 0) + r.accepted * rate);
  }
  return { pieces, value, missingRate };
}

const billCard = (b: BillRow): LinenBillCard => ({
  id: b.id, linenVendorId: b.linenVendorId, month: b.month, vendorBillNo: b.vendorBillNo, lines: b.lines, billedPaise: b.billedPaise,
  acceptedValuePaise: b.acceptedValuePaise, gstPaise: b.gstPaise, recoveryPaise: b.recoveryPaise, payablePaise: b.payablePaise,
  heldPaise: b.heldPaise, state: b.state as LinenBillCard["state"], checkedBy: b.checkedBy,
});

/**
 * Check a vendor's monthly bill against the pieces accepted that month (D4). A line billing more pieces than were
 * accepted is flagged. Payable = Σ accepted × rate on the return date + GST − approved recoveries not yet deducted
 * (decision 0092). A bill above accepted value + GST holds the difference until stores approves it.
 */
export async function checkVendorBill(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<LinenBillCard> {
  const input = parse(checkVendorBillInput, raw);
  return tx(exec, async (t) => {
    const v = await vendorFor(t, input.linenVendorId);
    await requireItems(t, input.lines.map((l) => ({ itemCode: l.itemCode, qty: 1 })));
    await lock(t, `vendor:${v.id}`);
    const now = await stamp(t, nowIn);
    if ((await t.select({ id: linenVendorBills.id }).from(linenVendorBills).where(and(
      eq(linenVendorBills.linenVendorId, v.id), eq(linenVendorBills.vendorBillNo, input.vendorBillNo),
    ))).length > 0) throw new LinenError("bill_exists", { vendorBillNo: input.vendorBillNo });
    const acc = await acceptedInMonth(t, v.id, input.month);
    if (acc.missingRate !== null) throw new LinenError("no_rate", { itemCode: acc.missingRate });
    const codes = [...new Set([...input.lines.map((l) => l.itemCode), ...acc.pieces.keys()])];
    const lines = codes.map((itemCode) => {
      const billed = input.lines.find((l) => l.itemCode === itemCode);
      const accepted = acc.pieces.get(itemCode) ?? 0;
      return {
        itemCode, billed: billed?.pieces ?? 0, accepted, flagged: (billed?.pieces ?? 0) > accepted,
        billedPaise: billed?.amountPaise ?? 0, acceptedPaise: acc.value.get(itemCode) ?? 0,
      };
    });
    const acceptedValue = lines.reduce((n, l) => n + l.acceptedPaise, 0);
    const gst = Math.round((acceptedValue * v.gstRateBps) / 10_000);
    const recs = await t.select().from(linenRecoveries).where(and(
      eq(linenRecoveries.linenVendorId, v.id), eq(linenRecoveries.state, "approved"), isNull(linenRecoveries.billId),
    ));
    const recovery = recs.reduce((n, r) => n + (r.approvedPaise ?? 0), 0);
    const held = Math.max(0, input.billedPaise - (acceptedValue + gst));
    const bill = (await t.insert(linenVendorBills).values({
      id: newId(), linenVendorId: v.id, month: input.month, vendorBillNo: input.vendorBillNo, lines, billedPaise: input.billedPaise,
      acceptedValuePaise: acceptedValue, gstPaise: gst, recoveryPaise: recovery, payablePaise: acceptedValue + gst - recovery,
      heldPaise: held, state: held > 0 ? "held" : "checked", checkedBy: actor.id, checkedAt: now,
    }).returning())[0]!;
    if (recs.length > 0) await t.update(linenRecoveries).set({ billId: bill.id }).where(inArray(linenRecoveries.id, recs.map((r) => r.id)));
    return billCard(bill);
  });
}

async function decideBill(exec: Exec, actor: Actor, raw: unknown, nowIn: Date | undefined, approve: boolean): Promise<LinenBillCard> {
  const input = parse(decideBillInput, raw);
  return tx(exec, async (t) => {
    const b = (await t.select().from(linenVendorBills).where(eq(linenVendorBills.id, input.billId)).for("update"))[0];
    if (b === undefined) throw new LinenError("unknown_bill", { billId: input.billId });
    if (b.state !== "held") throw new LinenError("bill_closed", { billId: b.id, state: b.state });
    if (b.checkedBy === actor.id) throw new LinenError("approver_is_requester", { billId: b.id });
    if (!(await hasPermission(t as unknown as Db, actor.id, LINEN_BILL_APPROVE, "hospital"))) throw new LinenError("not_approver");
    const now = await stamp(t, nowIn);
    return billCard((await t.update(linenVendorBills).set({
      state: approve ? "approved" : "refused", payablePaise: approve ? b.payablePaise + b.heldPaise : b.payablePaise,
      decidedBy: actor.id, decidedAt: now, note: input.note ?? null,
    }).where(eq(linenVendorBills.id, b.id)).returning())[0]!);
  });
}

/** Stores approves a held excess: it joins the payable. Never the person who checked the bill. */
export const approveBillExcess = (exec: Exec, actor: Actor, raw: unknown, now?: Date): Promise<LinenBillCard> => decideBill(exec, actor, raw, now, true);
/** Stores refuses it: the payable stays at accepted value + GST − recoveries. */
export const refuseBillExcess = (exec: Exec, actor: Actor, raw: unknown, now?: Date): Promise<LinenBillCard> => decideBill(exec, actor, raw, now, false);

/* ═══════════════════════════════ reads for the desk ═══════════════════════════════ */

export async function vendorCards(exec: Exec): Promise<LinenVendorCard[]> {
  return (await exec.select().from(linenVendors).where(eq(linenVendors.active, true)).orderBy(asc(linenVendors.name))).map((v) => ({
    id: v.id, name: v.name, turnaroundHours: v.turnaroundHours, rushTurnaroundHours: v.rushTurnaroundHours, gstRateBps: v.gstRateBps,
  }));
}

export async function recentBills(exec: Exec, limit = 20): Promise<LinenBillCard[]> {
  return (await exec.select().from(linenVendorBills).orderBy(desc(linenVendorBills.checkedAt)).limit(limit)).map(billCard);
}

export async function recentRecoveries(exec: Exec, limit = 20): Promise<{ id: string; vendorName: string; month: string; state: string; proposedPaise: number; approvedPaise: number | null; proposedBy: string }[]> {
  return (await exec.select({ r: linenRecoveries, name: linenVendors.name }).from(linenRecoveries)
    .innerJoin(linenVendors, eq(linenVendors.id, linenRecoveries.linenVendorId)).orderBy(desc(linenRecoveries.proposedAt)).limit(limit))
    .map(({ r, name }) => ({ id: r.id, vendorName: name, month: r.month, state: r.state, proposedPaise: r.proposedPaise, approvedPaise: r.approvedPaise, proposedBy: r.proposedBy }));
}

/** Accepted value and kg sent to one or all vendors in a month (the vendor's per-kg cost beside the plant's, D7). */
export async function vendorMonthCost(exec: Exec, month: string): Promise<{ kgSent: number; valuePaise: number }> {
  const w = istMonthWindow(month);
  const sent = await exec.select({ g: sql<string>`coalesce(sum(${linenChallans.weightGrams}), 0)` }).from(linenChallans)
    .where(and(gte(linenChallans.sentAt, w.start), lt(linenChallans.sentAt, w.end)));
  let value = 0;
  for (const v of await exec.select({ id: linenVendors.id }).from(linenVendors)) {
    const acc = await acceptedInMonth(exec, v.id, month);
    for (const p of acc.value.values()) value += p;
  }
  return { kgSent: Number(sent[0]?.g ?? 0) / 1000, valuePaise: value };
}
