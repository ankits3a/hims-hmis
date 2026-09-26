import { newId } from "@hmis/contracts";
import { opdDoctors } from "../../src/kernel/db/schema";
import { AbdmRuntime } from "../../src/modules/abdm/runtime";
import { labReportBundle, opConsultBundle, prescriptionBundle } from "../../src/modules/abdm/fhir-records";
import { ABHA_ADDRESS, hipConfig, seedHipFixture } from "./abdm-hip";
import type { AbdmRuntimeOptions } from "../../src/modules/abdm/runtime";
import type { FakeAbdmGateway } from "./abdm-fake-gateway";
import type { HipFixture } from "./abdm-hip";
import type { OpdReleaseVisit } from "../../src/modules/opd";
import type { LabReleaseTest } from "../../src/modules/lab";
import type { Db } from "../../src/kernel/db/client";

/**
 * ABDM S3 — the HIU fixture. The S2 HIP fixture already holds what M3 needs on OUR side — Sunita
 * Sharma with an ABDM-VERIFIED ABHA and an OPEN consultation (visit C, `in_consultation`) with Dr. Anil
 * Verma (user `u-doctor`), and Ravi Kumar whose ABHA is only self-declared — so this adds a SECOND
 * doctor who is not treating her, and the documents ANOTHER facility ("Fortis Escorts Jaipur") holds
 * for her, built with the hospital's own NRCeS builders so they are real IG-shaped documents.
 */
export const HIU_ID = "HIU-CRKMCH-01";
export const REMOTE_CC_1 = "FORTIS-OP-7781";
export const REMOTE_CC_2 = "FORTIS-OP-7790";
/** The fidelius-cli README REQUESTER key — our HIU half, injected so a test knows the private key to look for. */
export const README_REQUESTER = {
  priv: "DMxHPri8d7IT23KgLk281zZenMfVHSdeamq0RhwlIBk=",
  nonce: "6uj1RdDUbcpI3lVMZvijkMC8Te20O4Bcyz0SyivX8Eg=",
  x509: "MIIBMTCB6gYHKoZIzj0CATCB3gIBATArBgcqhkjOPQEBAiB/////////////////////////////////////////7TBEBCAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqYSRShRAQge0Je0Je0Je0Je0Je0Je0Je0Je0Je0Je0JgtenHcQyGQEQQQqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0kWiCuGaG4oIa04B7dLHdI0UySPU1+bXxhsinpxaJ+ztPZAiAQAAAAAAAAAAAAAAAAAAAAFN753qL3nNZYEmMaXPXT7QIBCANCAAQIXg+a1Kk8uFecUeP+h1pmKaKbuQjvijvARAktLnTalE0jaPdUyKiCMtQOFYfhfeHPp/bwHMF1NmxnH7COX+vW",
};
/** The README's ciphertext of `README_PLAINTEXT`, sender → requester. */
export const README_ENCRYPTED = "pzMvVZNNVtJzqPkkxcCbBUWgDEBy/mBXIeT2dJWI16ZAQnnXUb9lI+S4k8XK6mgZSKKSRIHkcNvJpllnBg548wUgavBa0vCRRwdL6kY6Yw==";
export const README_PLAINTEXT = "Wormtail should never have been Potter cottage's secret keeper.";

export type HiuFixture = HipFixture & { otherDoctorUserId: string };

export function hiuRuntime(db: Db, fake: FakeAbdmGateway, now: () => Date, opts: AbdmRuntimeOptions = {}, env: Record<string, string> = {}): AbdmRuntime {
  return new AbdmRuntime(hipConfig(fake, { ABDM_HIU_ID: HIU_ID, ...env }), db, fake.fetch, now, opts);
}

export async function seedHiuFixture(db: Db): Promise<HiuFixture> {
  const fx = await seedHipFixture(db);
  const [doc] = await db.select().from(opdDoctors);
  await db.insert(opdDoctors).values({
    id: newId(), userId: "u-doctor-2", displayName: "Dr. Meera Iyer", code: "DR002", registrationNo: "BMC-67890",
    departmentId: doc!.departmentId, createdBy: "fixture", updatedBy: "fixture",
  });
  return { ...fx, otherDoctorUserId: "u-doctor-2" };
}

const remoteVisit = (visitNo: string, day: string, over: Partial<OpdReleaseVisit> = {}): OpdReleaseVisit => ({
  encounterId: `REMOTE-${visitNo}`, visitNo, patientId: "REMOTE-PATIENT", serviceDate: day,
  consultStartedAt: new Date(`${day}T05:00:00.000Z`), consultCompletedAt: new Date(`${day}T05:20:00.000Z`),
  departmentName: "Cardiology",
  doctor: { id: "RD1", displayName: "Dr. Kavya Rao", code: "FRT-11", registrationNo: "RMC-4455" },
  chiefComplaint: "Chest discomfort on exertion",
  diagnosisKind: "final",
  diagnoses: [{ text: "Stable angina", icd10Code: "I20.8", icd10Display: "Other forms of angina pectoris", laterality: null }],
  advisedTests: ["Treadmill test"],
  prescription: {
    id: "RRX1", version: 1, issuedAt: new Date(`${day}T05:18:00.000Z`),
    lines: [{ drug: "Atorvastatin 20 mg tablet", dose: "1 tab", route: "oral", frequency: "HS", durationDays: 30, instructions: null, noSubstitution: false }],
  },
  ...over,
});

const remoteLab = (day: string): LabReleaseTest => ({
  orderItemId: "ROI1", orderNo: "FLO-0091", encounterNo: "FORTIS-OP-7781", patientId: "REMOTE-PATIENT", testName: "Lipid profile", testCode: "LIPID",
  issuedAt: new Date(`${day}T09:00:00.000Z`),
  values: [{ resultId: "RR1", analyteName: "LDL cholesterol", loincCode: "13457-7", valueNumeric: "162.0000", valueText: null, unit: "mg/dL", flag: "H", refLow: null, refHigh: "130.0000", refText: null, verifiedAt: new Date(`${day}T09:00:00.000Z`), remarks: null }],
});

/** The other facility's documents for Sunita: an OP consult + prescription + lab report on one visit, a consult on another. */
export function remoteBundles(fake: FakeAbdmGateway): { careContextReference: string; hiType: string; bundle: Record<string, unknown> }[] {
  let n = 0;
  const ctx = {
    hip: { id: fake.remoteHip.id, name: fake.remoteHip.name },
    patient: { uhid: "FORTIS-88812", name: "Sunita Sharma", gender: "female" as const, birthDate: "1986-03-14", phone: "9876543210", abhaNumber: "91-2345-6789-0123" },
    now: new Date("2026-08-01T06:00:00.000Z"),
    uuid: () => `10000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  };
  const v1 = remoteVisit(REMOTE_CC_1, "2026-07-14");
  const v2 = remoteVisit(REMOTE_CC_2, "2026-08-01", { chiefComplaint: "Follow-up, breathless on stairs", prescription: null, diagnoses: [] });
  return [
    { careContextReference: REMOTE_CC_1, hiType: "OPConsultation", bundle: opConsultBundle(ctx, v1) },
    { careContextReference: REMOTE_CC_1, hiType: "Prescription", bundle: prescriptionBundle(ctx, v1)! },
    { careContextReference: REMOTE_CC_1, hiType: "DiagnosticReport", bundle: labReportBundle(ctx, v1, remoteLab("2026-07-14")) },
    { careContextReference: REMOTE_CC_2, hiType: "OPConsultation", bundle: opConsultBundle(ctx, v2) },
  ];
}

// ——— the callbacks ABDM would send the HIU ———

export const onInitBody = (requestId: string, consentRequestId: string): Record<string, unknown> =>
  ({ consentRequest: { id: consentRequestId }, response: { requestId } });

export const notifyBody = (status: string, consentRequestId: string | null, artefactIds: string[]): Record<string, unknown> => ({
  notification: {
    ...(consentRequestId === null ? {} : { consentRequestId }), status,
    consentArtefacts: artefactIds.map((id) => ({ id })),
  },
});

export function consentDetail(fake: FakeAbdmGateway, over: {
  consentId?: string; hiuId?: string; patient?: string; hiTypes?: string[]; careContexts?: string[]; from?: string; to?: string; eraseAt?: string;
} = {}): Record<string, unknown> {
  return {
    schemaVersion: "v3", consentId: over.consentId ?? "artefact-1", createdAt: "2026-09-26T06:01:00.000Z",
    patient: { id: over.patient ?? ABHA_ADDRESS },
    careContexts: (over.careContexts ?? [REMOTE_CC_1, REMOTE_CC_2]).map((careContextReference) => ({ patientReference: "FORTIS-88812", careContextReference })),
    purpose: { text: "Care Management", code: "CAREMGT", refUri: "http://terminology.hl7.org/ValueSet/v3-PurposeOfUse" },
    hip: { id: fake.remoteHip.id, name: fake.remoteHip.name },
    hiu: { id: over.hiuId ?? HIU_ID },
    consentManager: { id: "sbx" },
    requester: { name: "Dr. Anil Verma", identifier: { value: "BMC-12345", type: "REGNO", system: "https://www.mciindia.org" } },
    hiTypes: over.hiTypes ?? ["OPConsultation", "Prescription", "DiagnosticReport"],
    permission: {
      accessMode: "VIEW",
      // The PATIENT narrowed the range to 2026-07-01.. — the data request must use THIS, not the doctor's (ABDM-1063).
      dateRange: { from: over.from ?? "2026-07-01T00:00:00.000Z", to: over.to ?? "2026-09-26T00:00:00.000Z" },
      dataEraseAt: over.eraseAt ?? "2026-10-10T00:00:00.000Z",
      frequency: { unit: "HOUR", value: 1, repeats: 0 },
    },
  };
}

export const onFetchBody = (requestId: string, detail: Record<string, unknown>, status = "GRANTED"): Record<string, unknown> =>
  ({ consent: { status, consentDetail: detail, signature: "fake-cm-signature" }, response: { requestId } });

export const onHiRequestBody = (requestId: string, transactionId: string): Record<string, unknown> =>
  ({ hiRequest: { transactionId, sessionStatus: "REQUESTED" }, response: { requestId } });
