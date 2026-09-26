import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  icd10Codes, opdDepartments, opdDoctors, opdEncounterDiagnoses, opdEncounters, opdPrescriptions,
} from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdvisedTest } from "./consultation";
import type { RxLine } from "./fhir";

/**
 * ═══ ABDM S2 — WHAT AN OPD VISIT RELEASES TO THE NATIONAL NETWORK, READ BY THE MODULE THAT OWNS IT ═══
 *
 * The ABDM connector (`modules/abdm`) builds the patient's OPConsultRecord and PrescriptionRecord
 * from this read and from nothing else; it never touches `opd_*` tables itself.
 *
 * WHAT IS RELEASED, AND WHAT IS NOT (plan 2026-09-25 §3 S2 — the owner's ruling on which records
 * are shared is pending, so this is the DECIDED default):
 *   · COMPLETED visits only — `status = 'completed'` with a `consult_completed_at`. An open consult is
 *     a working note, and ABDM care contexts cannot be unlinked once linked (FT FAQ Q33).
 *   · The doctor's own words: the chief complaint, the committed diagnoses (text as typed, the ICD-10
 *     code only when it was PICKED from the catalogue and the catalogue still carries it), the tests
 *     advised, and the CURRENT prescription (the highest `active` version; a superseded version is
 *     history, not the prescription).
 *   · NOT: `internal_comment`, `doctor_note`, the fee fields, the edit lease, the desk complaint, or
 *     any vitals/examination (not built in this slice — owed).
 *
 * No actor, no PHI row: the caller is the connector acting for the patient's own consent, and IT
 * writes the disclosure audit (`abdm.health_information`) once per release, against the patient.
 */
export type OpdReleaseDiagnosis = { text: string; icd10Code: string | null; icd10Display: string | null; laterality: string | null };
export type OpdReleaseVisit = {
  encounterId: string;
  visitNo: string;
  patientId: string;
  serviceDate: string;
  consultStartedAt: Date | null;
  consultCompletedAt: Date;
  departmentName: string | null;
  doctor: { id: string; displayName: string; code: string; registrationNo: string | null } | null;
  chiefComplaint: string | null;
  diagnosisKind: "provisional" | "final" | null;
  diagnoses: OpdReleaseDiagnosis[];
  advisedTests: string[];
  prescription: { id: string; version: number; issuedAt: Date; lines: RxLine[] } | null;
};

const text = (v: string | null): string | null => (v === null || v.trim() === "" ? null : v.trim());

function advisedNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((t) => (typeof t === "object" && t !== null ? (t as Partial<AdvisedTest>).name : undefined))
    .filter((n): n is string => typeof n === "string" && n.trim() !== "")
    .map((n) => n.trim());
}

/** The completed visits among `encounterIds`, each with what it releases. Unknown or open ids are absent. */
export async function completedVisitsForRelease(db: Db | Tx, encounterIds: readonly string[]): Promise<OpdReleaseVisit[]> {
  const ids = [...new Set(encounterIds)];
  if (ids.length === 0) return [];
  const rows = await db
    .select({ e: opdEncounters, departmentName: opdDepartments.name, doctor: opdDoctors })
    .from(opdEncounters)
    .leftJoin(opdDepartments, eq(opdDepartments.id, opdEncounters.departmentId))
    .leftJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .where(and(inArray(opdEncounters.id, ids), eq(opdEncounters.status, "completed"), isNotNull(opdEncounters.consultCompletedAt)))
    .orderBy(asc(opdEncounters.consultCompletedAt));
  if (rows.length === 0) return [];
  const found = rows.map((r) => r.e.id);

  const diagnoses = await db
    .select({ d: opdEncounterDiagnoses, display: icd10Codes.shortDescription })
    .from(opdEncounterDiagnoses)
    .leftJoin(icd10Codes, eq(icd10Codes.code, opdEncounterDiagnoses.icd10Code))
    .where(inArray(opdEncounterDiagnoses.encounterId, found))
    .orderBy(asc(opdEncounterDiagnoses.encounterId), asc(opdEncounterDiagnoses.seq));
  const rx = await db
    .select().from(opdPrescriptions)
    .where(and(inArray(opdPrescriptions.encounterId, found), eq(opdPrescriptions.status, "active")))
    .orderBy(asc(opdPrescriptions.encounterId), desc(opdPrescriptions.version));

  return rows.map(({ e, departmentName, doctor }) => {
    const current = rx.find((p) => p.encounterId === e.id);
    const lines = current === undefined || !Array.isArray(current.lines) ? [] : (current.lines as RxLine[]);
    return {
      encounterId: e.id,
      visitNo: e.visitNo,
      patientId: e.patientId,
      serviceDate: e.serviceDate,
      consultStartedAt: e.consultStartedAt,
      consultCompletedAt: e.consultCompletedAt!,
      departmentName,
      doctor: doctor === null ? null : { id: doctor.id, displayName: doctor.displayName, code: doctor.code, registrationNo: doctor.registrationNo },
      chiefComplaint: text(e.chiefComplaint),
      diagnosisKind: e.diagnosisKind === "provisional" || e.diagnosisKind === "final" ? e.diagnosisKind : null,
      diagnoses: diagnoses
        .filter((d) => d.d.encounterId === e.id && d.d.text.trim() !== "")
        .map((d) => ({
          text: d.d.text.trim(),
          // A code the catalogue no longer carries is sent as text only — ICD-10 coding needs a display.
          icd10Code: d.display === null ? null : d.d.icd10Code,
          icd10Display: d.display,
          laterality: d.d.laterality,
        })),
      advisedTests: advisedNames(e.advisedTests),
      prescription: current === undefined || lines.length === 0
        ? null
        : { id: current.id, version: current.version, issuedAt: current.issuedAt, lines },
    };
  });
}

/** A patient's completed visits (the merge chain's ids), oldest first — patient-initiated discovery. */
export async function completedVisitIdsOf(db: Db | Tx, patientIds: readonly string[]): Promise<{ encounterId: string; patientId: string }[]> {
  if (patientIds.length === 0) return [];
  return db
    .select({ encounterId: opdEncounters.id, patientId: opdEncounters.patientId })
    .from(opdEncounters)
    .where(and(inArray(opdEncounters.patientId, [...patientIds]), eq(opdEncounters.status, "completed"), isNotNull(opdEncounters.consultCompletedAt)))
    .orderBy(asc(opdEncounters.consultCompletedAt));
}
