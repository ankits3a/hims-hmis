import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { labAnalytes, labCriticalCalls, labResults, orderItems, orders } from "../../kernel/db/schema";
import { hasPermission } from "../../kernel/auth/permissions";
import type { Actor } from "@hmis/contracts";
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
      // Verified only, as the doctor's results reader (`patient-results.ts`).
      eq(labResults.verificationStatus, "verified"),
      gte(labResults.verifiedAt, since),
      // Keyed on the ordering clinician, so the restricted-test rule (DD11) is met by construction:
      // every row is the asker's own order.
      inArray(orders.orderingClinicianId, [...userIds]),
      sql`not exists (select 1 from lab_results s where s.supersedes_result_id = ${labResults.id})`,
    ))
    .orderBy(desc(labResults.verifiedAt));
  return rows.filter((r) => r.at !== null)
    .map((r) => ({ ...r, at: r.at!, orderingClinicianId: r.orderingClinicianId!, value: valueOf(r) }));
}

/**
 * DD-0.8 — "SINCE YOU SAW HIM": the patient's verified results since `since`, the newest per analyte,
 * with the value it was compared against when the lab's delta check had one. Superseded rows are left
 * out. Bounded: an OPD card shows a handful.
 */
export type PatientResultSince = { analyte: string; value: string | null; unit: string | null; flag: string | null; previous: string | null; verifiedAt: Date };
export const SINCE_RESULTS_LIMIT = 8;

export async function resultsForPatientSince(exec: Db | Tx, actor: Actor, patientIds: readonly string[], since: Date): Promise<PatientResultSince[]> {
  if (patientIds.length === 0) return [];
  // The kernel's restricted-test rule (DD11, as `patient-results.ts`): a restricted test is shown only
  // to its ordering clinician or a holder of `orders.read.restricted`, and otherwise OMITTED — applied
  // BEFORE the newest-per-analyte pick and the limit, so a hidden row can neither show nor displace one.
  const canSeeRestricted = actor.type === "user" && await hasPermission(exec as Db, actor.id, "orders.read.restricted", "hospital");
  const rows = await (exec as Db)
    .select({
      restricted: orderItems.restricted, orderingClinicianId: orders.orderingClinicianId,
      analyteId: labResults.analyteId, analyte: labAnalytes.nameEn, valueNumeric: labResults.valueNumeric, valueText: labResults.valueText,
      valueCoded: labResults.valueCoded, unit: labResults.unit, flag: labResults.flag, prevId: labResults.deltaPrevResultId, verifiedAt: labResults.verifiedAt,
    })
    .from(labResults)
    .innerJoin(labAnalytes, eq(labAnalytes.id, labResults.analyteId))
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(
      // Verified only — `= 'verified'`, exactly as the doctor's results reader (`patient-results.ts`).
      inArray(orders.patientId, [...patientIds]), eq(labResults.verificationStatus, "verified"), gte(labResults.verifiedAt, since),
      sql`not exists (select 1 from lab_results s where s.supersedes_result_id = ${labResults.id})`,
    ))
    .orderBy(desc(labResults.verifiedAt));
  const seen = new Set<string>();
  const latest = rows.filter((r) => !r.restricted || canSeeRestricted || r.orderingClinicianId === actor.id).filter((r) => r.verifiedAt !== null && !seen.has(r.analyteId) && (seen.add(r.analyteId), true)).slice(0, SINCE_RESULTS_LIMIT);
  const prevIds = latest.map((r) => r.prevId).filter((x): x is string => x !== null);
  // The earlier value is a result too, so the same restricted-test rule applies: one the asker may not
  // see is dropped, and the line shows no "previous".
  const prev = prevIds.length === 0 ? [] : await (exec as Db).select({
    id: labResults.id, valueNumeric: labResults.valueNumeric, valueText: labResults.valueText, valueCoded: labResults.valueCoded,
    restricted: orderItems.restricted, orderingClinicianId: orders.orderingClinicianId,
  })
    .from(labResults)
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(inArray(labResults.id, prevIds));
  const prevById = new Map(prev
    .filter((p) => !p.restricted || canSeeRestricted || p.orderingClinicianId === actor.id)
    .map((p) => [p.id, valueOf(p)] as const));
  return latest.map((r) => ({
    analyte: r.analyte, value: valueOf(r), unit: r.unit, flag: r.flag,
    previous: r.prevId === null ? null : prevById.get(r.prevId) ?? null, verifiedAt: r.verifiedAt!,
  }));
}
