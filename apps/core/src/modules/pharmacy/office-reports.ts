import { and, desc, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { pharmacyDemand, stockBatches } from "../../kernel/db/schema";
import {
  NON_MOVING_PRESETS, availableQtyByItem, findStoreByCode, itemsByIds, listStores, mrpPerBaseUnit, nonMovingStock, onOrderAt, purchaseAnalysisReport,
  purchaseRegister, stockValuationAt, survivorsOf, uomsByItems, vendorDiscountReport,
} from "../materials";
import { CONTROLLED_STORE_CODE, OPD_PHARMACY_STORE_CODE, RETAIL_PHARMACY_STORE_CODE, isIsoDate } from "./config";
import { PharmacyError } from "./errors";
import { looseTraysOf } from "./loose-trays";
import { REPORTS_MARGIN, REPORTS_READ, reportRange, reportToday, requireReportPermission } from "./report-range";
import type { NonMovingReport, PurchaseAnalysisReport, PurchaseRegister, StockValuation, VendorDiscountReport } from "../materials";
import type { ReportInput } from "./sales-register";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P5 — THE OFFICE'S STOCK AND PURCHASE REPORTS ═══
 *
 * Materials owns the tables and the report shapes (`materials/reports.ts`); the office gates them on
 * `pharmacy.reports.read` — the owner's grant, who reads no stock screen — and resolves a store code.
 */

async function storeIdOf(db: Db, storeCode: string | null | undefined): Promise<string | null> {
  if (storeCode == null || storeCode === "") return null;
  const hit = (await listStores(db, { includeTransit: true })).find((s) => s.code.toLowerCase() === storeCode.toLowerCase());
  if (hit === undefined) throw new PharmacyError("store_missing", `${storeCode} is not a store here`);
  return hit.id;
}

/** Supplier bills booked as payable, our debit notes and the vendors' credit notes of the period. */
export async function officePurchaseRegister(db: Db, actor: Actor, input: ReportInput, now: Date = new Date()): Promise<PurchaseRegister & { preset: string }> {
  await requireReportPermission(db, actor, REPORTS_READ, "the purchase register");
  const range = reportRange(input.preset, reportToday(now), input);
  return { ...(await purchaseRegister(db, range.from, range.to)), preset: range.preset };
}

/** #637 — the vendors' trade discount over the period's booked supplier bills, by vendor: gross, discount, taxable, GST. */
export async function officeVendorDiscounts(db: Db, actor: Actor, input: ReportInput, now: Date = new Date()): Promise<VendorDiscountReport & { preset: string }> {
  await requireReportPermission(db, actor, REPORTS_READ, "the vendor discount report");
  const range = reportRange(input.preset, reportToday(now), input);
  return { ...(await vendorDiscountReport(db, range.from, range.to)), preset: range.preset };
}

/**
 * #1061 — PURCHASE ANALYSIS: the period's GRN lines captured more than 2% above the last purchase or the contract rate,
 * with the reason, the extra rupees and who; totals by supplier. The margin report's right: it is buying-price data.
 */
export async function officePurchaseAnalysis(db: Db, actor: Actor, input: ReportInput, now: Date = new Date()): Promise<PurchaseAnalysisReport & { preset: string }> {
  await requireReportPermission(db, actor, REPORTS_MARGIN, "the purchase analysis report");
  const range = reportRange(input.preset, reportToday(now), input);
  return { ...(await purchaseAnalysisReport(db, range.from, range.to)), preset: range.preset };
}

/** What the hospital held at the end of `asOf` (today when absent), at GRN cost and at MRP. */
export async function officeStockValuation(
  db: Db, actor: Actor, input: { asOf?: string | null; storeCode?: string | null }, now: Date = new Date(),
): Promise<StockValuation> {
  await requireReportPermission(db, actor, REPORTS_READ, "the stock valuation");
  const today = reportToday(now);
  const asOf = input.asOf == null || input.asOf === "" ? today : input.asOf;
  if (!isIsoDate(asOf)) throw new PharmacyError("invalid_day", `"${asOf}" is not a date (YYYY-MM-DD)`);
  if (asOf > today) throw new PharmacyError("invalid_day", `the valuation is of a day that has happened; ${asOf} is after today (${today})`);
  return stockValuationAt(db, asOf, { storeResourceId: await storeIdOf(db, input.storeCode) });
}

/** Stock whose item has not left its store in 30 / 60 / 90 / 180 days, with the agent's suggestion. */
export async function officeNonMoving(
  db: Db, actor: Actor, input: { days?: number | string | null; storeCode?: string | null }, now: Date = new Date(),
): Promise<NonMovingReport> {
  await requireReportPermission(db, actor, REPORTS_READ, "the non-moving stock report");
  const days = Number(input.days ?? 90);
  if (!(NON_MOVING_PRESETS as readonly number[]).includes(days)) {
    throw new PharmacyError("invalid_range", `non-moving stock is read over ${NON_MOVING_PRESETS.join(", ")} days, not ${String(input.days)}`);
  }
  return nonMovingStock(db, now, days, { storeResourceId: await storeIdOf(db, input.storeCode) });
}

// ═══════════════════════════════════ spec #1064 — missed sales ═══════════════════════════════════

export type MissedSalesRow = {
  itemId: string; itemCode: string; itemName: string; baseUom: string;
  timesAsked: number;
  /** Base units asked for and not supplied, summed. */
  qtyBase: number;
  /** The item's latest batch MRP per base unit (loose-MRP rounding, 0008); null when no batch carries an MRP. */
  mrpUnitPaise: number | null;
  /** `qtyBase` x `mrpUnitPaise`; null when the MRP is unknown. */
  estimatedValuePaise: number | null;
  /** What can be sold now (expired, recalled, reserved and frozen excluded) at every pharmacy store and its loose tray. */
  stockNow: number;
  /** Still owed on approved, sent and part-received purchase orders to the pharmacy stores (base units). */
  openPoBase: number;
  lastAskedAt: string;
};
/** A name the catalogue does not carry: a new-item request. */
export type MissedSalesTypedRow = { name: string; medicineId: string | null; timesAsked: number; qtyBase: number; lastAskedAt: string };
export type MissedSalesReport = {
  from: string; to: string; preset: string;
  rows: MissedSalesRow[];
  typed: MissedSalesTypedRow[];
  totals: { timesAsked: number; qtyBase: number; estimatedValuePaise: number };
};

const atIso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();

/**
 * SPEC #1064 — MISSED SALES: every medicine asked for and not supplied in the range (IST days, inclusive), from
 * `pharmacy_demand` — desk declines as not in stock, the walk-in counter's notes, balances owed. By item: times asked,
 * quantity, estimated value at the latest batch MRP (blank when unknown), stock now and on order. Names the catalogue
 * does not carry are listed apart. Most asked first. No patient: the rows carry none. The sales report's right.
 */
export async function officeMissedSales(db: Db, actor: Actor, input: ReportInput, now: Date = new Date()): Promise<MissedSalesReport> {
  await requireReportPermission(db, actor, REPORTS_READ, "the missed sales report");
  const range = reportRange(input.preset ?? "month", reportToday(now), input);
  const { start } = istDayWindow(new Date(`${range.from}T12:00:00+05:30`));
  const { end } = istDayWindow(new Date(`${range.to}T12:00:00+05:30`));
  const within = and(gte(pharmacyDemand.notedAt, start), lt(pharmacyDemand.notedAt, end));

  const byItem = await db.select({
    itemId: pharmacyDemand.itemId,
    times: sql<string>`count(*)`,
    qty: sql<string>`sum(${pharmacyDemand.qtyAskedBase})`,
    last: sql<unknown>`max(${pharmacyDemand.notedAt})`,
  }).from(pharmacyDemand).where(and(within, isNotNull(pharmacyDemand.itemId))).groupBy(pharmacyDemand.itemId);
  // A typed name is stored trimmed with its spaces collapsed (`recordDemand`): one name in any case is one row, spelt as first said.
  const key = sql`lower(${pharmacyDemand.typedName})`;
  const typedRows = await db.select({
    name: sql<string>`(array_agg(${pharmacyDemand.typedName} order by ${pharmacyDemand.notedAt}, ${pharmacyDemand.id}))[1]`,
    medicineId: sql<string | null>`(array_agg(${pharmacyDemand.medicineId} order by ${pharmacyDemand.notedAt}) filter (where ${pharmacyDemand.medicineId} is not null))[1]`,
    times: sql<string>`count(*)`,
    qty: sql<string>`sum(${pharmacyDemand.qtyAskedBase})`,
    last: sql<unknown>`max(${pharmacyDemand.notedAt})`,
  }).from(pharmacyDemand).where(and(within, isNull(pharmacyDemand.itemId))).groupBy(key);

  // An item merged since it was asked for is its survivor's.
  const survivors = await survivorsOf(db, byItem.map((r) => r.itemId!));
  const folded = new Map<string, { times: number; qty: number; last: string }>();
  for (const r of byItem) {
    const id = survivors.get(r.itemId!) ?? r.itemId!;
    const cur = folded.get(id) ?? { times: 0, qty: 0, last: "" };
    const last = atIso(r.last);
    folded.set(id, { times: cur.times + Number(r.times), qty: cur.qty + Number(r.qty), last: last > cur.last ? last : cur.last });
  }
  const ids = [...folded.keys()];
  const [itemRows, uoms, latest, stores] = await Promise.all([
    itemsByIds(db, ids),
    uomsByItems(db, ids),
    ids.length === 0 ? Promise.resolve([]) : db.selectDistinctOn([stockBatches.itemId], { itemId: stockBatches.itemId, mrpPaise: stockBatches.mrpPaise, mrpUom: stockBatches.mrpUom })
      .from(stockBatches).where(and(inArray(stockBatches.itemId, ids), isNotNull(stockBatches.mrpPaise)))
      .orderBy(stockBatches.itemId, desc(stockBatches.createdAt), desc(stockBatches.id)),
    pharmacyStoreIds(db),
  ]);
  const stockNow = new Map<string, number>();
  for (const id of [...stores.counters, ...stores.trays]) {
    for (const [itemId, n] of await availableQtyByItem(db, id, ids, now)) stockNow.set(itemId, (stockNow.get(itemId) ?? 0) + n);
  }
  const onOrder = new Map<string, number>();
  for (const id of stores.counters) {
    for (const [itemId, o] of await onOrderAt(db, id, ids)) onOrder.set(itemId, (onOrder.get(itemId) ?? 0) + o.onOrderBase);
  }
  const mrpOf = new Map(latest.map((b) => {
    let unit: number | null = null;
    try { unit = mrpPerBaseUnit(uoms.get(b.itemId) ?? [], b.mrpPaise, b.mrpUom); } catch { unit = null; }
    return [b.itemId, unit] as const;
  }));

  const rows: MissedSalesRow[] = ids.map((id) => {
    const f = folded.get(id)!;
    const item = itemRows.get(id);
    const mrpUnitPaise = mrpOf.get(id) ?? null;
    return {
      itemId: id, itemCode: item?.code ?? "", itemName: item?.name ?? id, baseUom: item?.baseUom ?? "",
      timesAsked: f.times, qtyBase: f.qty, mrpUnitPaise, estimatedValuePaise: mrpUnitPaise === null ? null : mrpUnitPaise * f.qty,
      stockNow: stockNow.get(id) ?? 0, openPoBase: onOrder.get(id) ?? 0, lastAskedAt: f.last,
    };
  }).sort((a, b) => b.timesAsked - a.timesAsked || b.qtyBase - a.qtyBase || a.itemName.localeCompare(b.itemName));
  const typed: MissedSalesTypedRow[] = typedRows.map((r) => ({
    name: r.name, medicineId: r.medicineId ?? null, timesAsked: Number(r.times), qtyBase: Number(r.qty), lastAskedAt: atIso(r.last),
  })).sort((a, b) => b.timesAsked - a.timesAsked || b.qtyBase - a.qtyBase || a.name.localeCompare(b.name));

  return {
    from: range.from, to: range.to, preset: range.preset, rows, typed,
    totals: {
      timesAsked: rows.reduce((n, r) => n + r.timesAsked, 0) + typed.reduce((n, r) => n + r.timesAsked, 0),
      qtyBase: rows.reduce((n, r) => n + r.qtyBase, 0),
      estimatedValuePaise: rows.reduce((n, r) => n + (r.estimatedValuePaise ?? 0), 0),
    },
  };
}

/** The pharmacy's stores: the two counters and the controlled cabinet (those that exist), and the counters' loose trays. */
async function pharmacyStoreIds(db: Db): Promise<{ counters: string[]; trays: string[] }> {
  const counters: string[] = [];
  for (const code of [OPD_PHARMACY_STORE_CODE, RETAIL_PHARMACY_STORE_CODE, CONTROLLED_STORE_CODE]) {
    const store = await findStoreByCode(db, code);
    if (store !== undefined && store.status !== "retired") counters.push(store.id);
  }
  const trays: string[] = [];
  for (const id of counters) {
    const loose = (await looseTraysOf(db, id)).loose;
    if (loose !== undefined) trays.push(loose);
  }
  return { counters, trays };
}
