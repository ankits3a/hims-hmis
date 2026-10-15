import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  approvals, itemStockLevels, itemUoms, items, resources, stockAdjustments, stockBatches, stockLedger, stockWriteOffLines, stockWriteOffs,
} from "../../kernel/db/schema";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { istDay } from "./grn";
import { itemFactsThroughMerge } from "./reports";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY GAP CLOSURE, STAGE C — THREE MORE READS OF WHAT MATERIALS KNOWS ═══
 *
 * Plan `docs/superpowers/plans/2026-09-28-pharmacy-gap-closure.md`, stage C. READ-ONLY, no actor: the
 * gate is the caller's (`pharmacy.reports.read`), as for `stockValuationAt` beside them.
 *
 *   - `stockMovementSummary`: per item, the stock at the start of a range of IST days, what came in and
 *     went out during it by kind, and the stock at its end — all from the LEDGER, so any past range can
 *     be asked. The closing is summed on its own (every movement before the range's end), not derived:
 *     opening + in − out = closing is then a property the report can be checked against, not a tautology.
 *   - `lossBookings`: every quantity booked out as lost — a posted destruction write-off (expiry,
 *     damage, recall; the BMW handover) and a posted count variance written off for shrinkage, damage
 *     or expiry — with its value at landed cost and who approved it.
 *   - `itemCatalogue`: every active item with its master facts, its packs and its stock levels.
 */

const ROW_LIMIT = 20_000;
const istDayStart = (day: string): Date => istDayWindow(new Date(`${day}T12:00:00+05:30`)).start;
const istDayEnd = (day: string): Date => istDayWindow(new Date(`${day}T12:00:00+05:30`)).end;

// ═══════════════════════════════════ daily stock: opening, in, out, closing ═══════════════════════════════════

/**
 * How a ledger movement is counted, by its DD6 reason and its sign. Every movement lands in exactly one
 * bucket (the two `adjust` buckets take whatever reason the others do not), so the sums close.
 *   - in:  `grn` (a receipt, incl. opening stock); `issue`/`receive` + (a transfer in); `return`/`consume` +
 *          (a patient's return to the shelf); anything else + (a count's found stock, an item merge's in).
 *   - out: `consume` − (a sale, a dispense, a ward/OT use); `issue`/`receive` − (a transfer out); `return` −
 *          (back to the supplier); anything else − (a write-off, a shrinkage, an item merge's out).
 */
export const STOCK_IN_KINDS = ["grn", "transferIn", "saleReturn", "adjustIn"] as const;
export const STOCK_OUT_KINDS = ["sale", "transferOut", "supplierReturn", "writeOff"] as const;
export type StockInKind = (typeof STOCK_IN_KINDS)[number];
export type StockOutKind = (typeof STOCK_OUT_KINDS)[number];

export type StockMovementRow = {
  itemId: string; itemCode: string; itemName: string; baseUom: string;
  openingQty: number;
  in: Record<StockInKind, number>; inQty: number;
  out: Record<StockOutKind, number>; outQty: number;
  closingQty: number;
};
export type StockMovementSummary = {
  from: string; to: string; rows: StockMovementRow[];
  totals: { items: number; openingQty: number; inQty: number; outQty: number; closingQty: number };
  truncated: boolean;
};

export async function stockMovementSummary(
  db: Db | Tx, from: string, to: string, opts: { storeResourceId?: string | null } = {},
): Promise<StockMovementSummary> {
  const start = istDayStart(from);
  const end = istDayEnd(to);
  const q = stockLedger.qtyDelta;
  const inRange = sql`${stockLedger.occurredAt} >= ${start}`;
  const sumWhere = (cond: ReturnType<typeof sql>) => sql<string>`coalesce(sum(${q}) filter (where ${inRange} and ${cond}), 0)`;
  const r = stockLedger.reason;
  const grouped = await db.select({
    itemId: stockLedger.itemId,
    opening: sql<string>`coalesce(sum(${q}) filter (where ${stockLedger.occurredAt} < ${start}), 0)`,
    closing: sql<string>`sum(${q})`,
    moves: sql<string>`count(*) filter (where ${inRange})`,
    grn: sumWhere(sql`${q} > 0 and ${r} = 'grn'`),
    transferIn: sumWhere(sql`${q} > 0 and ${r} in ('issue', 'receive')`),
    saleReturn: sumWhere(sql`${q} > 0 and ${r} in ('return', 'consume')`),
    adjustIn: sumWhere(sql`${q} > 0 and ${r} not in ('grn', 'issue', 'receive', 'return', 'consume')`),
    sale: sumWhere(sql`${q} < 0 and ${r} = 'consume'`),
    transferOut: sumWhere(sql`${q} < 0 and ${r} in ('issue', 'receive')`),
    supplierReturn: sumWhere(sql`${q} < 0 and ${r} = 'return'`),
    writeOff: sumWhere(sql`${q} < 0 and ${r} not in ('consume', 'issue', 'receive', 'return')`),
  }).from(stockLedger)
    .where(and(lt(stockLedger.occurredAt, end), ...(opts.storeResourceId == null ? [] : [eq(stockLedger.resourceId, opts.storeResourceId)])))
    .groupBy(stockLedger.itemId);
  const live = grouped.filter((g) => Number(g.opening) !== 0 || Number(g.moves) > 0);
  const facts = await itemFactsThroughMerge(db, live.map((g) => g.itemId));
  const byItem = new Map<string, StockMovementRow>();
  for (const g of live) {
    const f = facts.get(g.itemId);
    const id = f?.id ?? g.itemId;
    const row = byItem.get(id) ?? {
      itemId: id, itemCode: f?.code ?? "—", itemName: f?.name ?? g.itemId, baseUom: f?.baseUom ?? "",
      openingQty: 0, in: { grn: 0, transferIn: 0, saleReturn: 0, adjustIn: 0 }, inQty: 0,
      out: { sale: 0, transferOut: 0, supplierReturn: 0, writeOff: 0 }, outQty: 0, closingQty: 0,
    };
    row.openingQty += Number(g.opening);
    row.closingQty += Number(g.closing);
    for (const k of STOCK_IN_KINDS) row.in[k] += Number(g[k]);
    for (const k of STOCK_OUT_KINDS) row.out[k] += -Number(g[k]);
    byItem.set(id, row);
  }
  const rows = [...byItem.values()].map((x) => ({
    ...x, inQty: STOCK_IN_KINDS.reduce((s, k) => s + x.in[k], 0), outQty: STOCK_OUT_KINDS.reduce((s, k) => s + x.out[k], 0),
  })).sort((a, b) => a.itemName.localeCompare(b.itemName) || a.itemCode.localeCompare(b.itemCode));
  const shown = rows.slice(0, ROW_LIMIT);
  return {
    from, to, rows: shown,
    totals: {
      items: rows.length, openingQty: rows.reduce((s, x) => s + x.openingQty, 0), inQty: rows.reduce((s, x) => s + x.inQty, 0),
      outQty: rows.reduce((s, x) => s + x.outQty, 0), closingQty: rows.reduce((s, x) => s + x.closingQty, 0),
    },
    truncated: rows.length > ROW_LIMIT,
  };
}

// ═══════════════════════════════════ the loss-booking register ═══════════════════════════════════

/** The count-variance reasons that are a LOSS (an entry error is a correction; found stock is a gain). */
export const LOSS_ADJUSTMENT_REASONS = ["shrinkage", "damage", "expiry"] as const;

export type LossBooking = {
  source: "write_off" | "count"; docId: string; docNo: string | null;
  date: string; at: string; storeCode: string; storeName: string;
  itemId: string; itemCode: string; itemName: string; batchId: string; batchNo: string; expiryDate: string | null;
  qtyBase: number; valuePaise: number; reason: string;
  requestedBy: string; approvedBy: string | null; postedBy: string | null;
  disposalAgency: string | null; manifestNo: string | null; note: string | null;
};

/** Posted losses whose posting falls on `from`..`to` (IST days, inclusive), oldest first. */
export async function lossBookings(
  db: Db | Tx, from: string, to: string, opts: { storeResourceId?: string | null } = {},
): Promise<{ rows: LossBooking[]; truncated: boolean }> {
  const start = istDayStart(from);
  const end = istDayEnd(to);
  const writeOffs = await db.select({
    docId: stockWriteOffs.id, docNo: stockWriteOffs.writeOffNo, postedAt: stockWriteOffs.postedAt, reason: stockWriteOffs.reason,
    storeCode: resources.code, storeName: resources.name, itemId: stockWriteOffLines.itemId, itemCode: items.code, itemName: items.name,
    batchId: stockBatches.id, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate, qtyBase: stockWriteOffLines.qtyBase,
    valuePaise: stockWriteOffLines.valuePaise, requestedBy: stockWriteOffs.requestedBy, approvedBy: approvals.decidedBy, postedBy: stockWriteOffs.postedBy,
    disposalAgency: stockWriteOffs.disposalAgency, manifestNo: stockWriteOffs.manifestNo, note: stockWriteOffs.note,
  }).from(stockWriteOffLines)
    .innerJoin(stockWriteOffs, eq(stockWriteOffs.id, stockWriteOffLines.writeOffId))
    .innerJoin(resources, eq(resources.id, stockWriteOffs.storeResourceId))
    .innerJoin(items, eq(items.id, stockWriteOffLines.itemId))
    .innerJoin(stockBatches, eq(stockBatches.id, stockWriteOffLines.batchId))
    .leftJoin(approvals, eq(approvals.id, stockWriteOffs.approvalId))
    .where(and(
      eq(stockWriteOffs.status, "posted"), gte(stockWriteOffs.postedAt, start), lt(stockWriteOffs.postedAt, end),
      ...(opts.storeResourceId == null ? [] : [eq(stockWriteOffs.storeResourceId, opts.storeResourceId)]),
    ))
    .orderBy(asc(stockWriteOffs.postedAt), asc(stockWriteOffs.writeOffNo), asc(items.name))
    .limit(ROW_LIMIT + 1);
  const counted = await db.select({
    docId: stockAdjustments.id, countId: stockAdjustments.countId, postedAt: stockAdjustments.postedAt, reason: stockAdjustments.reasonCode,
    storeCode: resources.code, storeName: resources.name, itemId: stockAdjustments.itemId, itemCode: items.code, itemName: items.name,
    batchId: stockBatches.id, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate, qtyDelta: stockAdjustments.qtyDelta,
    valuePaise: stockAdjustments.valuePaise, requestedBy: stockAdjustments.requestedBy, approvedBy: approvals.decidedBy, postedBy: stockAdjustments.postedBy,
    note: stockAdjustments.note,
  }).from(stockAdjustments)
    .innerJoin(resources, eq(resources.id, stockAdjustments.resourceId))
    .innerJoin(items, eq(items.id, stockAdjustments.itemId))
    .innerJoin(stockBatches, eq(stockBatches.id, stockAdjustments.batchId))
    .leftJoin(approvals, eq(approvals.id, stockAdjustments.approvalId))
    .where(and(
      eq(stockAdjustments.status, "posted"), lt(stockAdjustments.qtyDelta, 0), inArray(stockAdjustments.reasonCode, [...LOSS_ADJUSTMENT_REASONS]),
      gte(stockAdjustments.postedAt, start), lt(stockAdjustments.postedAt, end),
      ...(opts.storeResourceId == null ? [] : [eq(stockAdjustments.resourceId, opts.storeResourceId)]),
    ))
    .orderBy(asc(stockAdjustments.postedAt), asc(items.name))
    .limit(ROW_LIMIT + 1);
  const rows: LossBooking[] = [
    ...writeOffs.map((w): LossBooking => ({
      source: "write_off", docId: w.docId, docNo: w.docNo, date: istDay(w.postedAt!), at: w.postedAt!.toISOString(), storeCode: w.storeCode, storeName: w.storeName,
      itemId: w.itemId, itemCode: w.itemCode, itemName: w.itemName, batchId: w.batchId, batchNo: w.batchNo, expiryDate: w.expiryDate,
      qtyBase: w.qtyBase, valuePaise: w.valuePaise, reason: w.reason, requestedBy: w.requestedBy, approvedBy: w.approvedBy, postedBy: w.postedBy,
      disposalAgency: w.disposalAgency, manifestNo: w.manifestNo, note: w.note,
    })),
    ...counted.map((c): LossBooking => ({
      source: "count", docId: c.docId, docNo: null, date: istDay(c.postedAt!), at: c.postedAt!.toISOString(), storeCode: c.storeCode, storeName: c.storeName,
      itemId: c.itemId, itemCode: c.itemCode, itemName: c.itemName, batchId: c.batchId, batchNo: c.batchNo, expiryDate: c.expiryDate,
      qtyBase: -c.qtyDelta, valuePaise: Math.abs(c.valuePaise), reason: c.reason, requestedBy: c.requestedBy, approvedBy: c.approvedBy, postedBy: c.postedBy,
      disposalAgency: null, manifestNo: null, note: c.note,
    })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : (a.docNo ?? "").localeCompare(b.docNo ?? "") || a.itemName.localeCompare(b.itemName)));
  return { rows: rows.slice(0, ROW_LIMIT), truncated: rows.length > ROW_LIMIT };
}

// ═══════════════════════════════════ the item catalogue ═══════════════════════════════════

export type CatalogueItem = {
  id: string; code: string; name: string; class: string; hsnCode: string | null; gstRateBps: number | null; baseUom: string;
  storageClass: string; manufacturer: string | null; marketedBy: string | null;
  mfgLicenceNo: string | null; pharmacopoeia: string | null; lasaNote: string | null; storageMaxC: number | null; leadTimeDays: number | null; lasa: boolean; highAlert: boolean;
  formularyMedicineId: string | null;
  packs: { uom: string; toBase: number }[];
  levels: { storeResourceId: string; storeCode: string; minBase: number; reorderBase: number; maxBase: number }[];
};

/** Every active item (merged duplicates are not items any more), by name, with its packs (the base unit itself left out) and each store's levels. */
export async function itemCatalogue(db: Db | Tx, opts: { storeResourceId?: string | null } = {}): Promise<{ rows: CatalogueItem[]; truncated: boolean }> {
  const all = await db.select({
    id: items.id, code: items.code, name: items.name, class: items.class, hsnCode: items.hsnCode, gstRateBps: items.gstRateBps, baseUom: items.baseUom,
    storageClass: items.storageClass, manufacturer: items.manufacturer, marketedBy: items.marketedBy,
    mfgLicenceNo: items.mfgLicenceNo, pharmacopoeia: items.pharmacopoeia, lasaNote: items.lasaNote, storageMaxC: items.storageMaxC, leadTimeDays: items.leadTimeDays, lasa: items.lasa, highAlert: items.highAlert,
    formularyMedicineId: items.formularyMedicineId,
  }).from(items).where(and(eq(items.active, true), isNull(items.mergedIntoItemId))).orderBy(asc(items.name), asc(items.code)).limit(ROW_LIMIT + 1);
  const shown = all.slice(0, ROW_LIMIT);
  const ids = shown.map((i) => i.id);
  const packs = new Map<string, { uom: string; toBase: number }[]>();
  const levels = new Map<string, CatalogueItem["levels"]>();
  for (let i = 0; i < ids.length; i += 5_000) {
    const chunk = ids.slice(i, i + 5_000);
    for (const u of await db.select({ itemId: itemUoms.itemId, uom: itemUoms.uom, toBase: itemUoms.toBaseMultiplier }).from(itemUoms)
      .where(and(inArray(itemUoms.itemId, chunk), sql`${itemUoms.toBaseMultiplier} > 1`)).orderBy(asc(itemUoms.toBaseMultiplier))) {
      packs.set(u.itemId, [...(packs.get(u.itemId) ?? []), { uom: u.uom, toBase: u.toBase }]);
    }
    for (const l of await db.select({
      itemId: itemStockLevels.itemId, storeResourceId: itemStockLevels.storeResourceId, storeCode: resources.code,
      minBase: itemStockLevels.minBase, reorderBase: itemStockLevels.reorderBase, maxBase: itemStockLevels.maxBase,
    }).from(itemStockLevels).innerJoin(resources, eq(resources.id, itemStockLevels.storeResourceId))
      .where(and(inArray(itemStockLevels.itemId, chunk), ...(opts.storeResourceId == null ? [] : [eq(itemStockLevels.storeResourceId, opts.storeResourceId)])))
      .orderBy(asc(resources.code))) {
      const { itemId, ...rest } = l;
      levels.set(itemId, [...(levels.get(itemId) ?? []), rest]);
    }
  }
  return {
    rows: shown.map((i) => ({ ...i, packs: packs.get(i.id) ?? [], levels: levels.get(i.id) ?? [] })),
    truncated: all.length > ROW_LIMIT,
  };
}
