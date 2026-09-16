import { and, eq, gte, inArray, lt, or } from "drizzle-orm";
import { pharmacyDispenseLines, pharmacyDispenses } from "../../kernel/db/schema";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { creditedInvoiceLineIdsBetween, invoiceLineCredits } from "../billing";
import {
  consumptionRowsAt, countVariancesBetween, findStoreByCode, getBatch, itemsByIds, ledgerQtyByIds, refIdsWithMovementBetween,
  returnedQtyByRef,
} from "../materials";
import { OPD_PHARMACY_STORE_CODE, RETURN_REF_TYPE, isIsoDate } from "./config";
import { PharmacyError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P12 — THE LEAKAGE TRIANGLE: ISSUED, BILLED, COUNTED ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-pharmacy-p12-leakage.md`. Doc 16 §11.10 and I1,
 * the Pharmacy Leakage Auditor (T0, a SQL report, reviewed by the billing supervisor). For the OPD
 * counter's store and one IST day:
 *
 *   - **Issued vs billed, per dispense line.** The lines examined are those handed over that day,
 *     plus any line whose invoice line a live credit note credited that day, plus any line returned
 *     that day. For each: issued = what its `consume` row moved, less P6 returns; billed = the
 *     invoice line's quantity, less live credits. A difference is a mismatch. The counter cannot
 *     bill what it did not issue, so a mismatch is money or stock that moved around it: typically a
 *     refund at the billing desk with nothing returned.
 *   - **Consumption outside a dispense.** Every `consume` row at the store that is not a pharmacy
 *     dispense's: a ward's emergency borrowing, a correction, a leak. Listed with its reference and
 *     the login that posted it.
 *   - **Counted.** The variance lines of the blind counts whose sheet time fell that day (14c).
 *
 * No patient is named: a dispense number is enough for the reviewer to open it at the counter,
 * where the read is logged.
 */
export type LeakageMismatch = {
  dispenseId: string;
  dispenseNo: string | null;
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
  otherConsumption: { itemCode: string; batchNo: string; units: number; refType: string | null; refId: string | null; actorId: string; occurredAt: string }[];
  counted: { counts: number; varianceUnits: number; variancePaise: number; lines: { countId: string; itemCode: string; batchNo: string; varianceQty: number; variancePaise: number }[] };
  summary: { unbilledUnits: number; unbilledPaise: number; otherUnits: number; countVarianceUnits: number; countVariancePaise: number };
};

const DISPENSE_REF_TYPE = "pharmacy_dispense";

export async function pharmacyLeakage(db: Db, day: string): Promise<LeakageReport> {
  if (!isIsoDate(day)) throw new PharmacyError("invalid_day", `"${day}" is not a date (YYYY-MM-DD)`);
  const store = await findStoreByCode(db, OPD_PHARMACY_STORE_CODE);
  if (store === undefined) throw new PharmacyError("store_missing", `the OPD pharmacy store ${OPD_PHARMACY_STORE_CODE} does not exist — run seed:pharmacy`);
  const { start, end } = istDayWindow(new Date(`${day}T12:00:00+05:30`));

  const [creditedToday, returnedToday] = await Promise.all([
    creditedInvoiceLineIdsBetween(db, start, end),
    refIdsWithMovementBetween(db, "return", RETURN_REF_TYPE, start, end),
  ]);
  const handedOverToday = and(gte(pharmacyDispenses.handedOverAt, start), lt(pharmacyDispenses.handedOverAt, end));
  const rows = await db.select({
    lineId: pharmacyDispenseLines.id, dispenseId: pharmacyDispenses.id, dispenseNo: pharmacyDispenses.dispenseNo,
    handedOverAt: pharmacyDispenses.handedOverAt, itemId: pharmacyDispenseLines.itemId, batchId: pharmacyDispenseLines.batchId,
    ledgerEntryId: pharmacyDispenseLines.ledgerEntryId, invoiceLineId: pharmacyDispenseLines.invoiceLineId,
  })
    .from(pharmacyDispenseLines)
    .innerJoin(pharmacyDispenses, eq(pharmacyDispenses.id, pharmacyDispenseLines.dispenseId))
    .where(and(
      eq(pharmacyDispenses.status, "handed_over"),
      or(
        handedOverToday,
        creditedToday.length === 0 ? undefined : inArray(pharmacyDispenseLines.invoiceLineId, creditedToday),
        returnedToday.length === 0 ? undefined : inArray(pharmacyDispenseLines.id, returnedToday),
      ),
    ));
  const lines = rows.filter((r) => r.ledgerEntryId !== null && r.invoiceLineId !== null);

  const [moved, returned, billing, items, consumption, counted] = await Promise.all([
    ledgerQtyByIds(db, lines.map((l) => l.ledgerEntryId!)),
    returnedQtyByRef(db, RETURN_REF_TYPE, lines.map((l) => l.lineId)),
    invoiceLineCredits(db, lines.map((l) => l.invoiceLineId!)),
    itemsByIds(db, lines.map((l) => l.itemId).filter((x): x is string => x !== null)),
    consumptionRowsAt(db, store.id, start, end),
    countVariancesBetween(db, store.id, start, end),
  ]);
  const batchNoOf = new Map(consumption.map((c) => [c.batchId, c.batchNo] as const));
  const missingBatches = lines.map((l) => l.batchId).filter((b): b is string => b !== null && !batchNoOf.has(b));
  if (missingBatches.length > 0) {
    // A line handed over on another day moved no stock today; its batch number comes from its own row.
    for (const id of new Set(missingBatches)) batchNoOf.set(id, (await getBatch(db, id))?.batchNo ?? id);
  }

  let dispensedLines = 0;
  let dispensedUnits = 0;
  const mismatches: LeakageMismatch[] = [];
  for (const l of lines) {
    const issued = -(moved.get(l.ledgerEntryId!) ?? 0);
    const back = returned.get(l.lineId) ?? 0;
    const bill = billing.get(l.invoiceLineId!) ?? { qty: 0, unitPaise: 0, creditedQty: 0 };
    if (l.handedOverAt !== null && l.handedOverAt >= start && l.handedOverAt < end) {
      dispensedLines += 1;
      dispensedUnits += issued;
    }
    const unbilledUnits = (issued - back) - (bill.qty - bill.creditedQty);
    if (unbilledUnits === 0) continue;
    mismatches.push({
      dispenseId: l.dispenseId, dispenseNo: l.dispenseNo,
      itemCode: (l.itemId === null ? undefined : items.get(l.itemId))?.code ?? "",
      batchNo: l.batchId === null ? "" : batchNoOf.get(l.batchId) ?? "",
      issued, returned: back, billed: bill.qty, credited: bill.creditedQty,
      unbilledUnits, unbilledPaise: unbilledUnits * bill.unitPaise,
    });
  }
  mismatches.sort((a, b) => b.unbilledPaise - a.unbilledPaise || (a.dispenseNo ?? "").localeCompare(b.dispenseNo ?? ""));

  const otherConsumption = consumption
    .filter((c) => c.refType !== DISPENSE_REF_TYPE)
    .map((c) => ({ itemCode: c.itemCode, batchNo: c.batchNo, units: c.units, refType: c.refType, refId: c.refId, actorId: c.actorId, occurredAt: c.occurredAt.toISOString() }));
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
