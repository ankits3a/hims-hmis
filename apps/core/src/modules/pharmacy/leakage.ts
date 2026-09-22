import { and, eq, gte, inArray, lt, or } from "drizzle-orm";
import { invoices, pharmacyDispenseLines, pharmacyDispenses, pharmacyRetailSaleLines, pharmacyRetailSales, users } from "../../kernel/db/schema";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { creditedInvoiceLineIdsBetween, invoiceLineCredits } from "../billing";
import {
  consumptionRowsAt, countVariancesBetween, findStoreByCode, getBatch, itemsByIds, ledgerQtyByIds, refIdsWithMovementBetween,
  returnedQtyByRef,
} from "../materials";
import {
  OPD_PHARMACY_STORE_CODE, RETAIL_PHARMACY_STORE_CODE, RETAIL_REF_TYPE, RETAIL_RETURN_REF_TYPE, RETURN_REF_TYPE, isIsoDate,
} from "./config";
import { PharmacyError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P12 — THE LEAKAGE TRIANGLE: ISSUED, BILLED, COUNTED ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-pharmacy-p12-leakage.md`. Doc 16 §11.10 and I1,
 * the Pharmacy Leakage Auditor (T0, a SQL report, reviewed by the billing supervisor). For one
 * counter's store (the OPD counter's, or since P19b the walk-in counter's) and one IST day:
 *
 *   - **Issued vs billed, per sold line.** A sold line is a counter dispense's line or (P19b) a
 *     walk-in sale's or paper dispense's line, at this store. The lines examined are those that left
 *     that day, plus any line whose invoice line a live credit note credited that day, plus any line
 *     returned that day. For each: issued = what its `consume` row moved, less returns; billed = the
 *     invoice line's quantity, less live credits. A difference is a mismatch. The counter cannot
 *     bill what it did not issue, so a mismatch is money or stock that moved around it: typically a
 *     refund at the billing desk with nothing returned.
 *   - **Consumption outside a sale.** Every `consume` row at the store that is neither a dispense's
 *     nor a sale's: a ward's emergency borrowing, a correction, a leak. Listed with its reference and
 *     the login that posted it. (Before P19b a paper dispense at the OPD counter was listed here.)
 *   - **Counted.** The variance lines of the blind counts whose sheet time fell that day (14c).
 *
 * No patient is named: a dispense number or a bill number is enough for the reviewer to open it at
 * the counter, where the read is logged.
 */
export type LeakageMismatch = {
  /** P19b — which kind of sold line: a counter dispense, a walk-in sale, a paper dispense. */
  source: "dispense" | "walk_in" | "downtime";
  dispenseId: string | null;
  dispenseNo: string | null;
  /** P19b — the sale and its bill number, for a walk-in sale or a paper dispense. */
  saleId: string | null;
  invoiceNo: string | null;
  itemCode: string;
  batchNo: string;
  issued: number;
  returned: number;
  billed: number;
  credited: number;
  /** (issued − returned) − (billed − credited): units that left the shelf and are not paid for. */
  unbilledUnits: number;
  unbilledPaise: number;
};

export type LeakageReport = {
  day: string;
  store: { code: string; name: string };
  dispensed: { lines: number; units: number };
  mismatches: LeakageMismatch[];
  otherConsumption: { itemCode: string; batchNo: string; units: number; refType: string | null; refId: string | null; actorId: string; actorName: string; occurredAt: string }[];
  counted: { counts: number; varianceUnits: number; variancePaise: number; lines: { countId: string; itemCode: string; batchNo: string; varianceQty: number; variancePaise: number }[] };
  summary: { unbilledUnits: number; unbilledPaise: number; otherUnits: number; countVarianceUnits: number; countVariancePaise: number };
};

export const LEAKAGE_STORE_CODES = [OPD_PHARMACY_STORE_CODE, RETAIL_PHARMACY_STORE_CODE] as const;
export type LeakageStoreCode = (typeof LEAKAGE_STORE_CODES)[number];

const DISPENSE_REF_TYPE = "pharmacy_dispense";

type SoldLine = {
  source: LeakageMismatch["source"];
  lineId: string;
  returnRefType: string;
  dispenseId: string | null;
  dispenseNo: string | null;
  saleId: string | null;
  invoiceNo: string | null;
  leftAt: Date;
  itemId: string;
  batchId: string;
  ledgerEntryId: string;
  invoiceLineId: string;
};

export async function pharmacyLeakage(db: Db, day: string, storeCode: string = OPD_PHARMACY_STORE_CODE): Promise<LeakageReport> {
  if (!isIsoDate(day)) throw new PharmacyError("invalid_day", `"${day}" is not a date (YYYY-MM-DD)`);
  const store = (LEAKAGE_STORE_CODES as readonly string[]).includes(storeCode) ? await findStoreByCode(db, storeCode) : undefined;
  if (store === undefined) {
    throw new PharmacyError("store_missing", `${storeCode} is not a pharmacy counter's store here — the report reads ${LEAKAGE_STORE_CODES.join(" or ")}, which seed:pharmacy creates`);
  }
  const { start, end } = istDayWindow(new Date(`${day}T12:00:00+05:30`));

  const [creditedToday, dispenseReturnsToday, saleReturnsToday] = await Promise.all([
    creditedInvoiceLineIdsBetween(db, start, end),
    refIdsWithMovementBetween(db, "return", RETURN_REF_TYPE, start, end),
    refIdsWithMovementBetween(db, "return", RETAIL_RETURN_REF_TYPE, start, end),
  ]);
  const dispenseRows = await db.select({
    lineId: pharmacyDispenseLines.id, dispenseId: pharmacyDispenses.id, dispenseNo: pharmacyDispenses.dispenseNo,
    handedOverAt: pharmacyDispenses.handedOverAt, itemId: pharmacyDispenseLines.itemId, batchId: pharmacyDispenseLines.batchId,
    ledgerEntryId: pharmacyDispenseLines.ledgerEntryId, invoiceLineId: pharmacyDispenseLines.invoiceLineId,
  })
    .from(pharmacyDispenseLines)
    .innerJoin(pharmacyDispenses, eq(pharmacyDispenses.id, pharmacyDispenseLines.dispenseId))
    .where(and(
      eq(pharmacyDispenses.status, "handed_over"),
      eq(pharmacyDispenses.storeResourceId, store.id),
      or(
        and(gte(pharmacyDispenses.handedOverAt, start), lt(pharmacyDispenses.handedOverAt, end)),
        creditedToday.length === 0 ? undefined : inArray(pharmacyDispenseLines.invoiceLineId, creditedToday),
        dispenseReturnsToday.length === 0 ? undefined : inArray(pharmacyDispenseLines.id, dispenseReturnsToday),
      ),
    ));
  const saleRows = await db.select({
    lineId: pharmacyRetailSaleLines.id, saleId: pharmacyRetailSales.id, channel: pharmacyRetailSales.channel,
    invoiceNo: invoices.invoiceNo, soldAt: pharmacyRetailSales.soldAt, itemId: pharmacyRetailSaleLines.itemId,
    batchId: pharmacyRetailSaleLines.batchId, ledgerEntryId: pharmacyRetailSaleLines.ledgerEntryId,
    invoiceLineId: pharmacyRetailSaleLines.invoiceLineId,
  })
    .from(pharmacyRetailSaleLines)
    .innerJoin(pharmacyRetailSales, eq(pharmacyRetailSales.id, pharmacyRetailSaleLines.saleId))
    .innerJoin(invoices, eq(invoices.id, pharmacyRetailSales.invoiceId))
    .where(and(
      eq(pharmacyRetailSales.storeResourceId, store.id),
      or(
        and(gte(pharmacyRetailSales.soldAt, start), lt(pharmacyRetailSales.soldAt, end)),
        creditedToday.length === 0 ? undefined : inArray(pharmacyRetailSaleLines.invoiceLineId, creditedToday),
        saleReturnsToday.length === 0 ? undefined : inArray(pharmacyRetailSaleLines.id, saleReturnsToday),
      ),
    ));
  const lines: SoldLine[] = [];
  for (const r of dispenseRows) {
    if (r.ledgerEntryId === null || r.invoiceLineId === null || r.itemId === null || r.batchId === null || r.handedOverAt === null) continue;
    lines.push({
      source: "dispense", lineId: r.lineId, returnRefType: RETURN_REF_TYPE, dispenseId: r.dispenseId, dispenseNo: r.dispenseNo,
      saleId: null, invoiceNo: null, leftAt: r.handedOverAt, itemId: r.itemId, batchId: r.batchId,
      ledgerEntryId: r.ledgerEntryId, invoiceLineId: r.invoiceLineId,
    });
  }
  for (const r of saleRows) {
    lines.push({
      source: r.channel === "downtime" ? "downtime" : "walk_in", lineId: r.lineId, returnRefType: RETAIL_RETURN_REF_TYPE,
      dispenseId: null, dispenseNo: null, saleId: r.saleId, invoiceNo: r.invoiceNo, leftAt: r.soldAt, itemId: r.itemId,
      batchId: r.batchId, ledgerEntryId: r.ledgerEntryId, invoiceLineId: r.invoiceLineId,
    });
  }

  const [moved, dispenseReturns, saleReturns, billing, items, consumption, counted] = await Promise.all([
    ledgerQtyByIds(db, lines.map((l) => l.ledgerEntryId)),
    returnedQtyByRef(db, RETURN_REF_TYPE, lines.filter((l) => l.source === "dispense").map((l) => l.lineId)),
    returnedQtyByRef(db, RETAIL_RETURN_REF_TYPE, lines.filter((l) => l.source !== "dispense").map((l) => l.lineId)),
    invoiceLineCredits(db, lines.map((l) => l.invoiceLineId)),
    itemsByIds(db, lines.map((l) => l.itemId)),
    consumptionRowsAt(db, store.id, start, end),
    countVariancesBetween(db, store.id, start, end),
  ]);
  const batchNoOf = new Map(consumption.map((c) => [c.batchId, c.batchNo] as const));
  const missingBatches = lines.map((l) => l.batchId).filter((b) => !batchNoOf.has(b));
  if (missingBatches.length > 0) {
    // A line that left on another day moved no stock today; its batch number comes from its own row.
    for (const id of new Set(missingBatches)) batchNoOf.set(id, (await getBatch(db, id))?.batchNo ?? id);
  }

  let dispensedLines = 0;
  let dispensedUnits = 0;
  const mismatches: LeakageMismatch[] = [];
  for (const l of lines) {
    const issued = -(moved.get(l.ledgerEntryId) ?? 0);
    const back = (l.source === "dispense" ? dispenseReturns : saleReturns).get(l.lineId) ?? 0;
    const bill = billing.get(l.invoiceLineId) ?? { qty: 0, unitPaise: 0, creditedQty: 0 };
    if (l.leftAt >= start && l.leftAt < end) {
      dispensedLines += 1;
      dispensedUnits += issued;
    }
    const unbilledUnits = (issued - back) - (bill.qty - bill.creditedQty);
    if (unbilledUnits === 0) continue;
    mismatches.push({
      source: l.source, dispenseId: l.dispenseId, dispenseNo: l.dispenseNo, saleId: l.saleId, invoiceNo: l.invoiceNo,
      itemCode: items.get(l.itemId)?.code ?? "",
      batchNo: batchNoOf.get(l.batchId) ?? "",
      issued, returned: back, billed: bill.qty, credited: bill.creditedQty,
      unbilledUnits, unbilledPaise: unbilledUnits * bill.unitPaise,
    });
  }
  mismatches.sort((a, b) => b.unbilledPaise - a.unbilledPaise || (a.dispenseNo ?? a.invoiceNo ?? "").localeCompare(b.dispenseNo ?? b.invoiceNo ?? ""));

  const outside = consumption.filter((c) => c.refType !== DISPENSE_REF_TYPE && c.refType !== RETAIL_REF_TYPE);
  const posters = [...new Set(outside.map((c) => c.actorId))];
  const nameOf = new Map((posters.length === 0 ? [] : await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, posters)))
    .map((u) => [u.id, u.fullName] as const));
  const otherConsumption = outside.map((c) => ({
    itemCode: c.itemCode, batchNo: c.batchNo, units: c.units, refType: c.refType, refId: c.refId,
    actorId: c.actorId, actorName: nameOf.get(c.actorId) ?? c.actorId, occurredAt: c.occurredAt.toISOString(),
  }));
  const varianceUnits = counted.lines.reduce((s, l) => s + l.varianceQty, 0);
  const variancePaise = counted.lines.reduce((s, l) => s + l.variancePaise, 0);

  return {
    day,
    store: { code: store.code, name: store.name },
    dispensed: { lines: dispensedLines, units: dispensedUnits },
    mismatches,
    otherConsumption,
    counted: { counts: counted.counts, varianceUnits, variancePaise, lines: counted.lines },
    summary: {
      unbilledUnits: mismatches.reduce((s, m) => s + m.unbilledUnits, 0),
      unbilledPaise: mismatches.reduce((s, m) => s + m.unbilledPaise, 0),
      otherUnits: otherConsumption.reduce((s, c) => s + c.units, 0),
      countVarianceUnits: varianceUnits,
      countVariancePaise: variancePaise,
    },
  };
}
