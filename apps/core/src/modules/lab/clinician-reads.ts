import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { labAnalytes, labCriticalCalls, labResults, orderItems, orders } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * DOCTOR DESK DD-0.2 (#626, plan §4.4) — THE LAB'S ROWS FOR ONE CLINICIAN, as rows, not counts.
 *
 * `waiting.ts` answers "how many" for the morning card; the Doctor Desk's Needs Your Attention needs
 * the rows themselves, each with the record it came from. Both readers key on the RESPONSIBLE
 * clinician (`orders.ordering_clinician_id`, DD6), never the login that typed the order, so the two
 * cannot disagree about whose a critical is. Read-only; the caller is the scope (a list of user ids
 * the Desk has already decided the asker may see — their own, in DD-0).
 */

export type ClinicianLabRow = {
  /** `lab_critical_calls.id` for a critical, `lab_results.id` for a delta. */
  id: string;
  resultId: string;
  orderId: string;
  patientId: string;
  /** The visit the order was placed in (`orders.encounter_no`) — the Desk asks opd whether it is closed. */
  encounterNo: string;
  orderingClinicianId: string;
  analyte: string;
  value: string | null;
  unit: string | null;
  flag: string | null;
  /** When the call opened (critical) or the result was verified (delta). */
  at: Date;
};

const valueOf = (r: { valueNumeric: string | null; valueText: string | null; valueCoded: string | null }): string | null =>
  r.valueNumeric ?? r.valueText ?? r.valueCoded;

const COLUMNS = {
  resultId: labResults.id, orderId: orders.id, patientId: orders.patientId, encounterNo: orders.encounterNo,
  orderingClinicianId: orders.orderingClinicianId, analyte: labAnalytes.nameEn,
  valueNumeric: labResults.valueNumeric, valueText: labResults.valueText, valueCoded: labResults.valueCoded,
  unit: labResults.unit, flag: labResults.flag,
};

/** Critical calls still open on orders these clinicians are responsible for, oldest first. */
export async function openCriticalsForClinician(exec: Db | Tx, userIds: readonly string[]): Promise<ClinicianLabRow[]> {
  if (userIds.length === 0) return [];
  const rows = await (exec as Db)
    .select({ id: labCriticalCalls.id, at: labCriticalCalls.openedAt, ...COLUMNS })
    .from(labCriticalCalls)
    .innerJoin(labResults, eq(labResults.id, labCriticalCalls.resultId))
    .innerJoin(labAnalytes, eq(labAnalytes.id, labResults.analyteId))
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(isNull(labCriticalCalls.closedAt), inArray(orders.orderingClinicianId, [...userIds])))
    .orderBy(labCriticalCalls.openedAt);
  return rows.map((r) => ({ ...r, orderingClinicianId: r.orderingClinicianId!, value: valueOf(r) }));
}

/**
 * Verified results on these clinicians' orders that the lab's own delta check flagged (`delta_flag`,
 * set at entry against the patient's previous verified value), verified since `since` — the Desk's
 * "Clinical change" in OPD mode (plan D-D: lab delta rules only). Newest first; superseded rows are
 * left out (a correction is a new row that supersedes, and it carries its own flag).
 */
export async function deltaResultsForClinician(exec: Db | Tx, userIds: readonly string[], since: Date): Promise<ClinicianLabRow[]> {
  if (userIds.length === 0) return [];
  const rows = await (exec as Db)
    .select({ id: labResults.id, at: labResults.verifiedAt, ...COLUMNS })
    .from(labResults)
    .innerJoin(labAnalytes, eq(labAnalytes.id, labResults.analyteId))
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(
      eq(labResults.deltaFlag, true),
      inArray(labResults.verificationStatus, ["verified", "autoverified"]),
      gte(labResults.verifiedAt, since),
      inArray(orders.orderingClinicianId, [...userIds]),
      sql`not exists (select 1 from lab_results s where s.supersedes_result_id = ${labResults.id})`,
    ))
    .orderBy(desc(labResults.verifiedAt));
  return rows.filter((r) => r.at !== null)
    .map((r) => ({ ...r, at: r.at!, orderingClinicianId: r.orderingClinicianId!, value: valueOf(r) }));
}
