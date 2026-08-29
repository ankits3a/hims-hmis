import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { opdDoctors, opdEncounters, opdPrescriptions, opdVitals } from "../../kernel/db/schema";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { getPatient, listMergedLoserIds } from "../patients";
import { OpdError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 07d T1 — **WHAT THE DOCTOR HAS TODAY, AND WHY IT IS NOT ENOUGH.**
 *
 * Measured at kickoff and unchanged: the consult screen shows ONE LINE PER PAST VISIT — date,
 * department, doctor, diagnosis, ICD-10 and a prescription COUNT. There is **no way to read a prior
 * prescription at all**: the only cross-encounter prescription query in the tree is the private one
 * inside `runRxChecks`, used for interaction checking and never exposed as a browse surface. There
 * is no cross-visit vitals history endpoint either. A doctor who wants to know what this patient was
 * last given, or whether their blood pressure has been climbing for a year, cannot find out from
 * this system.
 *
 * ═══ EVERY LINE OF THIS FILE IS A NEW PHI READ PATH, AND IT INHERITS 07a AT THE TIME IT IS WRITTEN ═══
 *
 * DD5 is explicit that a phase which widens record access without widening the audit is the defect
 * 07a exists to close. So both readers below do exactly what `patientTimeline` does, in the same
 * order, and none of it is re-implemented:
 *
 *   1. `getPatient` — NOT `resolvePatientId`, whose own docstring says "no gate". A sealed patient
 *      is refused with the SAME `patient_not_found` an absent id produces, so the refusal cannot
 *      confirm that the person exists (07a DD2).
 *   2. `recordPhiAccess` on the SUCCESSFUL read only. A refusal produced no PHI, and a row naming a
 *      patient the reader was refused would be a leak inside the audit log.
 *   3. The MERGE CHAIN. A patient merged since their last visit has history under the loser id, and
 *      a history that silently truncates at a merge is worse than no history: the doctor sees a
 *      shorter list and has no reason to doubt it.
 *
 * The two surfaces are named `opd.rx_history` and `opd.vitals_history` rather than reusing the
 * encounter-scoped names — see `PhiSurface` for why the distinction is the audit log's whole job.
 */
export type RxHistoryItem = {
  prescriptionId: string;
  encounterId: string;
  serviceDate: string;
  issuedAt: Date;
  doctorId: string | null;
  doctorName: string | null;
  status: string;
  version: number;
  /** The persisted lines, verbatim. The shape is the prescription writer's, not this reader's. */
  lines: unknown;
};

export type VitalsHistoryItem = {
  vitalsId: string;
  encounterId: string;
  serviceDate: string;
  recordedAt: Date;
  sbp: number | null;
  dbp: number | null;
  pulse: number | null;
  rr: number | null;
  spo2: number | null;
  tempC: number | null;
  band: string;
  /** `DangerFlag[]` as persisted — a reading that tripped a rule stays flagged in the history. */
  dangerFlags: unknown;
};

/** The merge chain for a patient the actor may see, or a refusal indistinguishable from absence. */
async function chainFor(
  db: Db, actor: Actor, patientId: string, surface: "opd.rx_history" | "opd.vitals_history",
): Promise<string[]> {
  const visible = await getPatient(db, actor, patientId);
  if (!visible) throw new OpdError("patient_not_found", `unknown patient ${patientId}`);
  const canonical = visible.patient.id;
  await recordPhiAccess(db, {
    actor, patientId: canonical, surface,
    sealed: visible.patient.isConfidential, reason: visible.breakGlass?.reason ?? null,
  });
  return [canonical, ...(await listMergedLoserIds(db, canonical))];
}

/**
 * Every prescription this patient has ever been issued, newest first.
 *
 * SUPERSEDED VERSIONS ARE INCLUDED, deliberately. A prescription is versioned per encounter and a
 * re-issue supersedes — but "what was this patient actually given in March" is a clinical question
 * whose answer may be the superseded row, and a history that showed only the live version would
 * quietly rewrite the past. `status` is returned so the screen can say which is which.
 */
export async function patientRxHistory(
  db: Db, actor: Actor, patientId: string, limit = 50,
): Promise<RxHistoryItem[]> {
  const chain = await chainFor(db, actor, patientId, "opd.rx_history");
  const rows = await db
    .select({
      rx: opdPrescriptions,
      serviceDate: opdEncounters.serviceDate,
      doctorId: opdEncounters.doctorId,
      doctorName: opdDoctors.displayName,
    })
    .from(opdPrescriptions)
    .innerJoin(opdEncounters, eq(opdPrescriptions.encounterId, opdEncounters.id))
    .leftJoin(opdDoctors, eq(opdEncounters.doctorId, opdDoctors.id))
    .where(inArray(opdPrescriptions.patientId, chain))
    .orderBy(desc(opdPrescriptions.issuedAt))
    .limit(limit);

  return rows.map((r) => ({
    prescriptionId: r.rx.id,
    encounterId: r.rx.encounterId,
    serviceDate: r.serviceDate,
    issuedAt: r.rx.issuedAt,
    doctorId: r.doctorId,
    doctorName: r.doctorName,
    status: r.rx.status,
    version: r.rx.version,
    lines: r.rx.lines,
  }));
}

/**
 * Every vitals reading this patient has, OLDEST FIRST — the opposite order to the prescriptions,
 * and on purpose. A prescription list is read as "what are they on now", so the newest belongs at
 * the top. A vitals history is read as a TREND, and a trend read backwards is a trend nobody sees.
 */
export async function patientVitalsHistory(
  db: Db, actor: Actor, patientId: string, limit = 100,
): Promise<VitalsHistoryItem[]> {
  const chain = await chainFor(db, actor, patientId, "opd.vitals_history");
  const rows = await db
    .select({ v: opdVitals, serviceDate: opdEncounters.serviceDate })
    .from(opdVitals)
    .innerJoin(opdEncounters, eq(opdVitals.encounterId, opdEncounters.id))
    .where(and(inArray(opdVitals.patientId, chain)))
    .orderBy(asc(opdVitals.recordedAt))
    .limit(limit);

  return rows.map((r) => ({
    vitalsId: r.v.id,
    encounterId: r.v.encounterId,
    serviceDate: r.serviceDate,
    recordedAt: r.v.recordedAt,
    sbp: r.v.sbp, dbp: r.v.dbp, pulse: r.v.pulse, rr: r.v.rr, spo2: r.v.spo2, tempC: r.v.tempC,
    band: r.v.band,
    dangerFlags: r.v.dangerFlags,
  }));
}
