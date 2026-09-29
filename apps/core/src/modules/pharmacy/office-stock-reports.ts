import { inArray } from "drizzle-orm";
import { pharmacyShelfLocations, resources } from "../../kernel/db/schema";
import { medicinesByIds } from "../formulary";
import { itemCatalogue, listStores, lossBookings, stockMovementSummary } from "../materials";
import { PharmacyError } from "./errors";
import { userNames } from "./queue";
import { REPORTS_READ, reportRange, reportToday, requireReportPermission } from "./report-range";
import { salesRegister } from "./sales-register";
import type { CatalogueItem, LossBooking, StockMovementSummary } from "../materials";
import type { ReportInput } from "./sales-register";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY GAP CLOSURE, STAGE C — THE REPORTS STILL MISSING ═══
 *
 * Plan `docs/superpowers/plans/2026-09-28-pharmacy-gap-closure.md`, stage C. Every one READS, under
 * `pharmacy.reports.read` (asserted here whatever the route checked); materials owns the stock tables
 * and is read through its index.
 *
 *   - `topSellingItems`: the period's items ranked by units and by value, from the SALES REGISTER's own
 *     item grouping (so net of refunds, exactly as the register and the day book count it), each with
 *     its share and an ABC class by cumulative value.
 *   - `lossRegister`: every loss booked in the period — destruction write-offs and count variances
 *     written off — with totals by reason.
 *   - `dailyStock`: per item, opening + in − out = closing over a range, from the ledger.
 *   - `itemCatalogue`: the item master as one sheet, for an inspector or the CA.
 */

async function storeIdOf(db: Db, storeCode: string | null | undefined): Promise<string | null> {
  if (storeCode == null || storeCode === "") return null;
  const hit = (await listStores(db, { includeTransit: true })).find((s) => s.code.toLowerCase() === storeCode.toLowerCase());
  if (hit === undefined) throw new PharmacyError("store_missing", `${storeCode} is not a store here`);
  return hit.id;
}

// ═══════════════════════════════════ top-selling items ═══════════════════════════════════

export const TOP_SELLING_LIMIT = 50;
export type AbcClass = "A" | "B" | "C";
export type TopSellingRow = {
  rank: number; itemId: string; itemCode: string; itemName: string;
  qtyBase: number; valuePaise: number;
  /** This item's share of the period's units / value, in basis points. */
  unitShareBps: number | null; valueShareBps: number | null;
  /** The value share of every item ranked at or above this one (by value). */
  cumulativeValueBps: number | null;
  abc: AbcClass;
};
export type TopSelling = {
  from: string; to: string; preset: string; storeCode: string | null;
  byValue: TopSellingRow[]; byUnits: TopSellingRow[];
  totals: { items: number; qtyBase: number; valuePaise: number };
  classes: Record<AbcClass, { items: number; valuePaise: number }>;
};

const bpsOf = (part: number, whole: number): number | null => (whole <= 0 ? null : Math.round((part * 10_000) / whole));

/**
 * ABC by cumulative value: ranked by value, an item is A while the running total (itself included) is
 * at most 70% of the period's value, B to 90%, C after — and the top seller is A whatever its share
 * (one item that is 80% of the sales is the first one to watch, not a B). An item whose sales were
 * wholly refunded (net value ≤ 0) is C.
 */
export async function topSellingItems(db: Db, actor: Actor, input: ReportInput, now: Date = new Date()): Promise<TopSelling> {
  await requireReportPermission(db, actor, REPORTS_READ, "the top-selling items");
  const reg = await salesRegister(db, actor, { ...input, groupBy: "item" }, now);
  const items = reg.groups.map((g) => ({ itemId: g.key, itemCode: g.sub ?? "", itemName: g.label, qtyBase: g.qtyBase ?? 0, valuePaise: g.netPaise }));
  const valuePaise = items.reduce((s, i) => s + Math.max(0, i.valuePaise), 0);
  const qtyBase = items.reduce((s, i) => s + Math.max(0, i.qtyBase), 0);
  const byValue = [...items].sort((a, b) => b.valuePaise - a.valuePaise || b.qtyBase - a.qtyBase || a.itemName.localeCompare(b.itemName));
  const abc = new Map<string, { abc: AbcClass; cumulative: number }>();
  let running = 0;
  byValue.forEach((i, k) => {
    if (i.valuePaise <= 0) { abc.set(i.itemId, { abc: "C", cumulative: running }); return; }
    running += i.valuePaise;
    const cls: AbcClass = k === 0 || running * 100 <= valuePaise * 70 ? "A" : running * 100 <= valuePaise * 90 ? "B" : "C";
    abc.set(i.itemId, { abc: cls, cumulative: running });
  });
  const row = (i: (typeof items)[number], rank: number): TopSellingRow => ({
    rank, ...i, unitShareBps: bpsOf(i.qtyBase, qtyBase), valueShareBps: bpsOf(i.valuePaise, valuePaise),
    cumulativeValueBps: bpsOf(abc.get(i.itemId)!.cumulative, valuePaise), abc: abc.get(i.itemId)!.abc,
  });
  const byUnits = [...items].filter((i) => i.qtyBase > 0)
    .sort((a, b) => b.qtyBase - a.qtyBase || b.valuePaise - a.valuePaise || a.itemName.localeCompare(b.itemName));
  const classes: TopSelling["classes"] = { A: { items: 0, valuePaise: 0 }, B: { items: 0, valuePaise: 0 }, C: { items: 0, valuePaise: 0 } };
  for (const i of items) { const c = classes[abc.get(i.itemId)!.abc]; c.items += 1; c.valuePaise += i.valuePaise; }
  return {
    from: reg.from, to: reg.to, preset: reg.preset, storeCode: reg.storeCode,
    byValue: byValue.filter((i) => i.valuePaise > 0).slice(0, TOP_SELLING_LIMIT).map((i, k) => row(i, k + 1)),
    byUnits: byUnits.slice(0, TOP_SELLING_LIMIT).map((i, k) => row(i, k + 1)),
    totals: { items: items.length, qtyBase, valuePaise },
    classes,
  };
}

// ═══════════════════════════════════ the loss-booking register ═══════════════════════════════════

export type LossRow = Omit<LossBooking, "requestedBy" | "approvedBy" | "postedBy"> & {
  requestedBy: string; approvedBy: string | null; postedBy: string | null;
};
export type LossRegister = {
  from: string; to: string; preset: string; storeCode: string | null;
  rows: LossRow[];
  byReason: { reason: string; lines: number; qtyBase: number; valuePaise: number }[];
  totals: { lines: number; qtyBase: number; valuePaise: number };
  truncated: boolean;
};

export async function lossRegister(db: Db, actor: Actor, input: ReportInput, now: Date = new Date()): Promise<LossRegister> {
  await requireReportPermission(db, actor, REPORTS_READ, "the loss-booking register");
  const range = reportRange(input.preset, reportToday(now), input);
  const storeResourceId = await storeIdOf(db, input.storeCode);
  const { rows, truncated } = await lossBookings(db, range.from, range.to, { storeResourceId });
  const names = await userNames(db, rows.flatMap((r) => [r.requestedBy, r.approvedBy, r.postedBy]));
  const nameOf = (id: string | null): string | null => (id === null ? null : names.get(id) ?? id);
  const byReason = new Map<string, LossRegister["byReason"][number]>();
  for (const r of rows) {
    const g = byReason.get(r.reason) ?? { reason: r.reason, lines: 0, qtyBase: 0, valuePaise: 0 };
    g.lines += 1; g.qtyBase += r.qtyBase; g.valuePaise += r.valuePaise;
    byReason.set(r.reason, g);
  }
  return {
    from: range.from, to: range.to, preset: range.preset, storeCode: input.storeCode == null || input.storeCode === "" ? null : input.storeCode,
    rows: rows.map((r) => ({ ...r, requestedBy: nameOf(r.requestedBy)!, approvedBy: nameOf(r.approvedBy), postedBy: nameOf(r.postedBy) })),
    byReason: [...byReason.values()].sort((a, b) => b.valuePaise - a.valuePaise || a.reason.localeCompare(b.reason)),
    totals: { lines: rows.length, qtyBase: rows.reduce((s, r) => s + r.qtyBase, 0), valuePaise: rows.reduce((s, r) => s + r.valuePaise, 0) },
    truncated,
  };
}

// ═══════════════════════════════════ daily stock ═══════════════════════════════════

export async function dailyStock(
  db: Db, actor: Actor, input: ReportInput, now: Date = new Date(),
): Promise<StockMovementSummary & { preset: string; storeCode: string | null }> {
  await requireReportPermission(db, actor, REPORTS_READ, "the daily stock report");
  const range = reportRange(input.preset, reportToday(now), input);
  const storeResourceId = await storeIdOf(db, input.storeCode);
  return {
    ...(await stockMovementSummary(db, range.from, range.to, { storeResourceId })),
    preset: range.preset, storeCode: input.storeCode == null || input.storeCode === "" ? null : input.storeCode,
  };
}

// ═══════════════════════════════════ the item catalogue ═══════════════════════════════════

export type CatalogueRow = Omit<CatalogueItem, "formularyMedicineId"> & {
  /** The Drugs and Cosmetics Rules schedule, the formulary medicine's (`H`, `H1`, `X`, `OTC`); null when unclassified or not a drug. */
  schedule: string | null;
  racks: { storeCode: string; location: string }[];
};
export type ItemCatalogueReport = { storeCode: string | null; rows: CatalogueRow[]; truncated: boolean };

export async function itemCatalogueReport(db: Db, actor: Actor, input: { storeCode?: string | null }): Promise<ItemCatalogueReport> {
  await requireReportPermission(db, actor, REPORTS_READ, "the item catalogue");
  const storeResourceId = await storeIdOf(db, input.storeCode);
  const { rows, truncated } = await itemCatalogue(db, { storeResourceId });
  const medIds = [...new Set(rows.map((r) => r.formularyMedicineId).filter((m): m is string => m !== null))];
  const schedules = new Map<string, string | null>();
  for (let i = 0; i < medIds.length; i += 500) {
    for (const [id, m] of await medicinesByIds(db, medIds.slice(i, i + 500))) schedules.set(id, m.scheduleFlag);
  }
  const racks = new Map<string, { storeCode: string; location: string }[]>();
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 5_000) {
    const shelf = await db.select({ itemId: pharmacyShelfLocations.itemId, storeResourceId: pharmacyShelfLocations.storeResourceId, location: pharmacyShelfLocations.location })
      .from(pharmacyShelfLocations).where(inArray(pharmacyShelfLocations.itemId, ids.slice(i, i + 5_000)));
    const storeIds = [...new Set(shelf.map((s) => s.storeResourceId))];
    const codes = new Map(storeIds.length === 0 ? [] : (await db.select({ id: resources.id, code: resources.code }).from(resources).where(inArray(resources.id, storeIds))).map((s) => [s.id, s.code] as const));
    for (const s of shelf) {
      if (storeResourceId !== null && s.storeResourceId !== storeResourceId) continue;
      racks.set(s.itemId, [...(racks.get(s.itemId) ?? []), { storeCode: codes.get(s.storeResourceId) ?? "—", location: s.location }]);
    }
  }
  return {
    storeCode: input.storeCode == null || input.storeCode === "" ? null : input.storeCode,
    rows: rows.map(({ formularyMedicineId, ...r }) => ({
      ...r, schedule: formularyMedicineId === null ? null : schedules.get(formularyMedicineId) ?? null,
      racks: (racks.get(r.id) ?? []).sort((a, b) => a.storeCode.localeCompare(b.storeCode)),
    })),
    truncated,
  };
}
