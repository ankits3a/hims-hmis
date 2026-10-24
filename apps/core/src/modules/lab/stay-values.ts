import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { labAnalytes, labResults, orderItems, services } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * E5.3 (#740) — **THE SIGNED VALUES OF A SET OF ORDERS, IN A WINDOW**, for the inpatient copilot's "Since yesterday"
 * lines and the nurse's SBAR. A read; nothing is written, and no PHI-access row is logged here (the caller, which
 * reads the whole admission, logs its own disclosure).
 *
 * The caller names the ORDERS (an admission's own lab orders), not a patient: what a stay ordered is what its lines
 * may talk about. The rules are the doctor's brief's (`patient-results.ts`), applied to a window:
 *  · **`verified` only**, and the window is the signature's instant `(since, until]` — an unsigned number is a
 *    working note, never a line a doctor reads before a round.
 *  · **Superseded values are not returned** — the amendment is the value.
 *  · **Restricted items are omitted, not counted** (DD11): the copilot is no ordering-clinician screen, and for an HIV
 *    test the existence of the test is the sensitive fact.
 *  · **Free-text results carry no value here** (`value: null`, `kind: "text"`): a narrative belongs to the report,
 *    and a sentence cannot be checked number by number. Numeric values are printed to the analyte's own decimals.
 *
 * Newest first, at most `limit` rows; `truncated` says the list was cut.
 */
export type ResultedValue = {
  resultId: string;
  orderItemId: string;
  /** The ordered test's name (the tariff service: "Serum electrolytes"). */
  testName: string;
  /** The analyte's name ("Potassium"). */
  analyteName: string;
  kind: "numeric" | "coded" | "text";
  /** As the report prints it: numeric to the analyte's decimals, a coded value's code; null for free text. */
  value: string | null;
  unit: string | null;
  /** The bench's flag: `L`, `H`, `LL`, `HH`, `A`, `N`, or null. */
  flag: string | null;
  /** Outside the reference range (`L`, `H`, `A`) or the critical band. */
  abnormal: boolean;
  /** Outside the critical band (`LL`, `HH`) — the value that opened a critical call. */
  critical: boolean;
  resultedAt: Date;
};

export const RESULTED_VALUES_LIMIT = 200;

const ABNORMAL_FLAGS = new Set(["L", "H", "LL", "HH", "A"]);
const CRITICAL_FLAGS = new Set(["LL", "HH"]);

/** A numeric value as the report prints it: the analyte's decimals (0–4), never the column's four. */
export function printedNumber(raw: string, decimals: number): string {
  const d = Math.min(4, Math.max(0, Math.trunc(decimals)));
  return Number(raw).toFixed(d);
}

export async function resultedValuesForOrders(
  exec: Db | Tx,
  input: { orderIds: readonly string[]; since: Date; until: Date; limit?: number },
): Promise<{ values: ResultedValue[]; truncated: boolean }> {
  const ids = [...new Set(input.orderIds)];
  if (ids.length === 0) return { values: [], truncated: false };
  const limit = input.limit ?? RESULTED_VALUES_LIMIT;
  const superseded = sql`exists (select 1 from lab_results s where s.supersedes_result_id = ${labResults.id})`;
  const rows = await (exec as Db)
    .select({
      id: labResults.id, orderItemId: labResults.orderItemId, testName: services.name, analyteName: labAnalytes.nameEn,
      decimals: labAnalytes.decimals, valueNumeric: labResults.valueNumeric, valueCoded: labResults.valueCoded,
      unit: labResults.unit, flag: labResults.flag, verifiedAt: labResults.verifiedAt,
    })
    .from(labResults)
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(services, eq(services.id, orderItems.serviceId))
    .innerJoin(labAnalytes, eq(labAnalytes.id, labResults.analyteId))
    .where(and(
      inArray(orderItems.orderId, ids),
      eq(orderItems.restricted, false),
      eq(labResults.verificationStatus, "verified"),
      gt(labResults.verifiedAt, input.since),
      lte(labResults.verifiedAt, input.until),
      sql`not ${superseded}`,
    ))
    .orderBy(desc(labResults.verifiedAt), desc(labResults.id))
    .limit(limit + 1);
  const values = rows.slice(0, limit).map((r): ResultedValue => {
    const kind = r.valueNumeric !== null ? "numeric" : r.valueCoded !== null ? "coded" : "text";
    return {
      resultId: r.id, orderItemId: r.orderItemId, testName: r.testName, analyteName: r.analyteName, kind,
      value: kind === "numeric" ? printedNumber(r.valueNumeric!, r.decimals) : kind === "coded" ? r.valueCoded!.slice(0, 40) : null,
      unit: r.unit, flag: r.flag,
      abnormal: r.flag !== null && ABNORMAL_FLAGS.has(r.flag), critical: r.flag !== null && CRITICAL_FLAGS.has(r.flag),
      resultedAt: r.verifiedAt!,
    };
  });
  return { values, truncated: rows.length > limit };
}
