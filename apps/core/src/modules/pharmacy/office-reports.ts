import { NON_MOVING_PRESETS, listStores, nonMovingStock, purchaseRegister, stockValuationAt } from "../materials";
import { isIsoDate } from "./config";
import { PharmacyError } from "./errors";
import { REPORTS_READ, reportRange, reportToday, requireReportPermission } from "./report-range";
import type { NonMovingReport, PurchaseRegister, StockValuation } from "../materials";
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
