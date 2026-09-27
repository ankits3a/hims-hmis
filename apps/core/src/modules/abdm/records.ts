import { completedVisitsForRelease, loadOpdConfig } from "../opd";
import { ABDM_ACTOR, getPatient } from "../patients";
import { verifiedLabTestsForRelease } from "../lab";
import { signedImagingReportsForRelease } from "../radiology";
import { imagingReportBundle, labReportBundle, opConsultBundle, prescriptionBundle } from "./fhir-records";
import type { HiType, RecordContext, RecordPatient } from "./fhir-records";
import type { OpdReleaseVisit } from "../opd";
import type { LabReleaseTest } from "../lab";
import type { ImagingReleaseReport } from "../radiology";
import type { PatientRow } from "../patients";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ ABDM S2 — ONE CARE CONTEXT'S RELEASABLE RECORDS, AND THE BUNDLES THEY BECOME ═══
 *
 * A care context is one completed OPD visit (`abdm_care_contexts`). Its records are read ONLY
 * through the owning modules' release readers — `completedVisitsForRelease` (opd),
 * `verifiedLabTestsForRelease` (lab), `signedImagingReportsForRelease` (radiology) — and each of
 * those states what it holds back (unverified, superseded, restricted, foetal sex, unsigned). This
 * file adds nothing to those rules and removes nothing from them.
 *
 * Every bundle carries its RECORD DATE — the consult's completion, the prescription's issue, the
 * lab test's last verification, the imaging report's signature — which is what a consent's date
 * range is matched against (`health-information.ts`).
 */
export type CareContextRecords = {
  careContextReference: string;
  visit: OpdReleaseVisit;
  lab: LabReleaseTest[];
  imaging: ImagingReleaseReport[];
};

export type BuiltRecord = { careContextReference: string; hiType: HiType; date: Date; bundle: Record<string, unknown> };

/** The care contexts' records, keyed by care-context reference. A visit not (or no longer) completed is absent. */
export async function loadCareContextRecords(
  db: Db, contexts: readonly { referenceNumber: string; encounterId: string }[],
): Promise<Map<string, CareContextRecords>> {
  const visits = await completedVisitsForRelease(db, contexts.map((c) => c.encounterId));
  const byEncounter = new Map(visits.map((v) => [v.encounterId, v]));
  const visitNos = visits.map((v) => v.visitNo);
  const [lab, imaging] = await Promise.all([
    verifiedLabTestsForRelease(db, visitNos),
    signedImagingReportsForRelease(db, visitNos),
  ]);
  const out = new Map<string, CareContextRecords>();
  for (const c of contexts) {
    const visit = byEncounter.get(c.encounterId);
    if (visit === undefined) continue;
    out.set(c.referenceNumber, {
      careContextReference: c.referenceNumber,
      visit,
      // A lab order or study is the visit's when it names the visit's number AND the visit's patient.
      lab: lab.filter((t) => t.encounterNo === visit.visitNo && t.patientId === visit.patientId),
      imaging: imaging.filter((r) => r.encounterNo === visit.visitNo && r.patientId === visit.patientId),
    });
  }
  return out;
}

/** What a care context carries: always the consult; the prescription when one was issued; reports when any are releasable. */
export function hiTypesOf(r: CareContextRecords): HiType[] {
  const types: HiType[] = ["OPConsultation"];
  if (r.visit.prescription !== null && r.visit.prescription.lines.length > 0) types.push("Prescription");
  if (r.lab.length > 0 || r.imaging.length > 0) types.push("DiagnosticReport");
  return types;
}

/** Every bundle of `hiTypes` this care context can release, each with its record date. */
export function buildRecords(ctx: RecordContext, r: CareContextRecords, hiTypes: ReadonlySet<string>): BuiltRecord[] {
  const out: BuiltRecord[] = [];
  const ref = r.careContextReference;
  if (hiTypes.has("OPConsultation")) {
    out.push({ careContextReference: ref, hiType: "OPConsultation", date: r.visit.consultCompletedAt, bundle: opConsultBundle(ctx, r.visit) });
  }
  if (hiTypes.has("Prescription")) {
    const b = prescriptionBundle(ctx, r.visit);
    if (b !== null) out.push({ careContextReference: ref, hiType: "Prescription", date: r.visit.prescription!.issuedAt, bundle: b });
  }
  if (hiTypes.has("DiagnosticReport")) {
    for (const t of r.lab) out.push({ careContextReference: ref, hiType: "DiagnosticReport", date: t.issuedAt, bundle: labReportBundle(ctx, r.visit, t) });
    for (const i of r.imaging) out.push({ careContextReference: ref, hiType: "DiagnosticReport", date: i.signedAt, bundle: imagingReportBundle(ctx, r.visit, i) });
  }
  return out;
}

const GENDER: Record<string, RecordPatient["gender"]> = { male: "male", female: "female", other: "other" };

/** The patient as a document names them — ABDM-verified demographics once verified (S1), administrative gender. */
export function recordPatientOf(p: PatientRow): RecordPatient {
  const dob = p.dob === null ? null : p.dob.toISOString().slice(0, 10);
  return {
    uhid: p.uhid,
    name: p.name,
    gender: GENDER[p.administrativeGender] ?? "unknown",
    birthDate: p.dobEstimated ? null : dob,
    phone: p.phone,
    abhaNumber: p.abhaVerificationStatus === "verified" ? p.abhaNumber : null,
  };
}

/** The canonical patient row (the merge chain followed), read as the ABDM system actor. */
export async function patientRow(db: Db, patientId: string): Promise<PatientRow | null> {
  const found = await getPatient(db, ABDM_ACTOR, patientId);
  return found === null ? null : found.patient;
}

/** The facility as documents name it: the letterhead's name, or the HFR id when no letterhead is configured. */
export async function hipOrganization(db: Db, hipId: string): Promise<{ id: string; name: string }> {
  try {
    const cfg = await loadOpdConfig(db);
    const name = cfg.letterhead.name.trim();
    return { id: hipId, name: name === "" ? hipId : name };
  } catch {
    return { id: hipId, name: hipId };
  }
}
