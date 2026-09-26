import { newId } from "@hmis/contracts";
import {
  abdmMessages, icd10Codes, imagingReports, imagingStudies, labAnalytes, labOrderables, labResults,
  opdDepartments, opdDoctors, opdEncounterDiagnoses, opdEncounters, opdPrescriptions, orderItems, orders,
  patients, registrationConfig, services,
} from "../../src/kernel/db/schema";
import { loadConfig } from "../../src/kernel/config";
import { AbdmRuntime } from "../../src/modules/abdm/runtime";
import { callbackKind } from "../../src/modules/abdm/callbacks";
import { INBOUND_SECRET_KEYS, redactKeys } from "../../src/modules/abdm/redact";
import type { AbdmInboundMessage } from "../../src/modules/abdm/callbacks";
import type { AbdmRuntimeOptions } from "../../src/modules/abdm/runtime";
import type { FakeAbdmGateway } from "./abdm-fake-gateway";
import type { AppConfig } from "../../src/kernel/config";
import type { Db } from "../../src/kernel/db/client";

/**
 * ABDM S2 — the HIP fixture: one ABDM-verified patient with two completed OPD visits carrying every
 * record kind the HIP releases, AND every kind it must hold back — so a test that asserts "nothing
 * restricted / unverified / unsigned reached the HIU" is asserting against rows that exist.
 *
 *   visit A (V2609250001, 2026-09-25, General Medicine) — complaint, an ICD-10-picked diagnosis and a
 *     typed one, a prescription (v1 superseded, v2 current), advised tests; lab: a CBC with a VERIFIED
 *     haemoglobin (an older verified value SUPERSEDED by it) and an UNVERIFIED platelet count; an HIV
 *     test (RESTRICTED, verified); radiology: a SIGNED chest X-ray, a
 *     RESTRICTED signed obstetric scan, and a DRAFT report on a third study.
 *   visit B (V2609100002, 2026-09-10) — complaint and a prescription only.
 *   an open visit C (V2609250009) — not completed, never a care context.
 *   a second patient, SELF-DECLARED ABHA (not verified), with a completed visit.
 */
export const HIP = "IN0000000001";
export const SECRET = "Sbx-Secret-hip-never-stored";
export const ABHA_ADDRESS = "sunita.sharma@sbx";
export const ABHA_NUMBER = "91-2345-6789-0123";
export const VISIT_A = "V2609250001";
export const VISIT_B = "V2609100002";
export const VISIT_C = "V2609250009";

export type HipFixture = {
  patientId: string; uhid: string; otherPatientId: string;
  encA: string; encB: string; encC: string; encOther: string;
  /** Strings that exist in the database and must NEVER reach an HIU. */
  heldBack: { unverifiedAnalyte: string; restrictedTest: string; restrictedStudy: string; draftStudy: string; supersededValue: string; oldRxDrug: string; internalComment: string };
};

export function hipConfig(fake: FakeAbdmGateway, env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY!,
    ABDM_BASE_URL: fake.baseUrl, ABDM_CLIENT_ID: "SBX_0001", ABDM_CLIENT_SECRET: SECRET, ABDM_HIP_ID: HIP,
    ABDM_CALLBACK_BASE_URL: "https://hmis.example.test/api/abdm/callbacks", ...env,
  });
}

export function hipRuntime(db: Db, fake: FakeAbdmGateway, now: () => Date, opts: AbdmRuntimeOptions = {}, env: Record<string, string> = {}): AbdmRuntime {
  return new AbdmRuntime(hipConfig(fake, env), db, fake.fetch, now, opts);
}

/** What the callback route hands a handler — with the inbound row it would have written (body redacted as the route redacts it). */
export async function inbound(db: Db, path: string, cb: { headers: Record<string, string>; body: Record<string, unknown> }): Promise<AbdmInboundMessage> {
  const messageId = newId();
  const kind = callbackKind(path);
  const response = cb.body.response as { requestId?: unknown } | undefined;
  const correlationRequestId = typeof response?.requestId === "string" ? response.requestId : null;
  await db.insert(abdmMessages).values({
    id: messageId, direction: "in", kind, path, requestId: cb.headers["REQUEST-ID"]!, correlationRequestId,
    headers: {}, body: redactKeys(cb.body, INBOUND_SECRET_KEYS), httpStatus: 202, dispatch: "pending",
  });
  return {
    messageId, kind, path, requestId: cb.headers["REQUEST-ID"]!, correlationRequestId,
    hipId: cb.headers["X-HIP-ID"] ?? null, hiuId: cb.headers["X-HIU-ID"] ?? null, body: cb.body, claims: { exp: 0 },
  };
}

const by = { createdBy: "fixture", updatedBy: "fixture" };

export async function seedHipFixture(db: Db): Promise<HipFixture> {
  await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "fixture" });
  const patientId = newId();
  const uhid = "HMS00000013";
  await db.insert(patients).values({
    id: patientId, uhid, name: "Sunita Sharma", sex: "female", administrativeGender: "female",
    dob: new Date("1986-03-14T00:00:00.000Z"), phone: "9876543210",
    abhaNumber: ABHA_NUMBER, abhaAddress: ABHA_ADDRESS, abhaVerificationStatus: "verified", ...by,
  } as never);
  const otherPatientId = newId();
  await db.insert(patients).values({
    id: otherPatientId, uhid: "HMS00000021", name: "Ravi Kumar", sex: "male", administrativeGender: "male",
    dob: new Date("1990-01-01T00:00:00.000Z"), phone: "9811111111",
    abhaNumber: "91-1111-2222-3333", abhaAddress: "ravi@sbx", abhaVerificationStatus: "self_declared", ...by,
  } as never);

  const dept = newId();
  await db.insert(opdDepartments).values({ id: dept, code: "GM", name: "General Medicine", ...by });
  const doctor = newId();
  await db.insert(opdDoctors).values({ id: doctor, userId: "u-doctor", displayName: "Dr. Anil Verma", code: "DR001", registrationNo: "BMC-12345", departmentId: dept, ...by });
  await db.insert(icd10Codes).values({
    code: "A01.0", rawCode: "A010", orderNumber: 3, billable: true, shortDescription: "Typhoid fever", longDescription: "Typhoid fever",
    chapterNo: 1, chapterName: "Certain infectious and parasitic diseases",
  } as never);

  const encounter = async (visitNo: string, pid: string, completedAt: string | null, over: Record<string, unknown> = {}): Promise<string> => {
    const id = newId();
    await db.insert(opdEncounters).values({
      id, visitNo, patientId: pid, workflowInstanceId: `wf-${visitNo}`, serviceDate: (completedAt ?? "2026-09-25").slice(0, 10),
      visitType: "new", departmentId: dept, doctorId: doctor, openedBy: "fixture", updatedBy: "fixture",
      status: completedAt === null ? "in_consultation" : "completed",
      consultStartedAt: completedAt === null ? null : new Date(new Date(completedAt).getTime() - 15 * 60_000),
      consultCompletedAt: completedAt === null ? null : new Date(completedAt),
      ...over,
    } as never);
    return id;
  };
  const encA = await encounter(VISIT_A, patientId, "2026-09-25T04:25:00.000Z", {
    chiefComplaint: "Fever for 3 days", diagnosisKind: "provisional", internalComment: "INTERNAL-NOTE-never-released",
    advisedTests: [{ serviceId: "x", code: "WIDAL", name: "Widal test", pricePaise: 20000 }],
  });
  const encB = await encounter(VISIT_B, patientId, "2026-09-10T05:00:00.000Z", { chiefComplaint: "Cough" });
  const encC = await encounter(VISIT_C, patientId, null, { chiefComplaint: "open visit" });
  const encOther = await encounter("V2609250005", otherPatientId, "2026-09-25T06:00:00.000Z", { chiefComplaint: "Back pain" });
  await db.insert(opdEncounterDiagnoses).values([
    { encounterId: encA, seq: 0, text: "Enteric fever", icd10Code: "A01.0" },
    { encounterId: encA, seq: 1, text: "dehydration, mild", icd10Code: null },
  ]);
  const rx = (encounterId: string, pid: string, version: number, status: string, drug: string, issuedAt: string) => ({
    id: newId(), encounterId, patientId: pid, doctorId: doctor, version, status, issuedBy: "u-doctor", issuedAt: new Date(issuedAt),
    lines: [{ drug, dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: "after food", noSubstitution: false }],
    document: {}, allergyOverrides: [],
  });
  await db.insert(opdPrescriptions).values([
    rx(encA, patientId, 1, "superseded", "OLD-RX-Amoxicillin 500 mg", "2026-09-25T04:20:00.000Z"),
    rx(encA, patientId, 2, "active", "Paracetamol 650 mg tablet", "2026-09-25T04:24:00.000Z"),
    rx(encB, patientId, 1, "active", "Cough syrup 10 ml", "2026-09-10T04:59:00.000Z"),
  ] as never);

  // ── lab ──
  const service = async (code: string, name: string, category: string): Promise<string> => {
    const id = newId();
    await db.insert(services).values({ id, code, name, category, ...by } as never);
    return id;
  };
  const cbc = await service("CBC", "Complete blood count", "lab");
  const hiv = await service("HIV", "HIV 1 & 2 antibodies", "lab");
  await db.insert(labOrderables).values([
    { serviceId: cbc, code: "CBC", nameEn: "Complete blood count", discipline: "haematology", specimenType: "blood", container: "EDTA", tatMinutesRoutine: 60, ...by },
    { serviceId: hiv, code: "HIV", nameEn: "HIV 1 & 2 antibodies", discipline: "serology", specimenType: "serum", container: "plain", tatMinutesRoutine: 120, sensitive: true, ...by },
  ] as never);
  const analyte = async (code: string, name: string, loinc: string | null, type = "numeric"): Promise<string> => {
    const id = newId();
    await db.insert(labAnalytes).values({ id, code, nameEn: name, loincCode: loinc, resultType: type, unit: type === "numeric" ? "g/dL" : null, ...by } as never);
    return id;
  };
  const hb = await analyte("HB", "Haemoglobin", "718-7");
  const plt = await analyte("PLT", "Platelet count UNVERIFIED-ANALYTE", "777-3");
  const hivAb = await analyte("HIVAB", "HIV antibody RESTRICTED-TEST", null, "text");
  const order = async (encounterNo: string, pid: string, items: { serviceId: string; restricted?: boolean }[]): Promise<string[]> => {
    const orderId = newId();
    await db.insert(orders).values({
      id: orderId, orderNo: `LO-${orderId.slice(-8)}`, orderGroupId: orderId, kind: "lab", patientId: pid, encounterNo,
      serviceDate: "2026-09-25", priority: "routine", authority: "clinician", orderedByType: "user", orderedById: "u-doctor",
      orderingClinicianId: "u-doctor", placedAt: new Date("2026-09-25T04:22:00.000Z"),
    } as never);
    const ids: string[] = [];
    for (const it of items) {
      const id = newId();
      await db.insert(orderItems).values({ id, orderId, serviceId: it.serviceId, restricted: it.restricted ?? false, status: "completed" } as never);
      ids.push(id);
    }
    return ids;
  };
  const [cbcItem, hivItem] = await order(VISIT_A, patientId, [{ serviceId: cbc }, { serviceId: hiv, restricted: true }]);
  const result = (orderItemId: string, analyteId: string, v: { n?: string; t?: string; verified: boolean; at: string; supersedes?: string; flag?: string }) => ({
    id: newId(), orderItemId, analyteId, valueNumeric: v.n ?? null, valueText: v.t ?? null, unit: v.n === undefined ? null : "g/dL",
    flag: v.flag ?? null, refLow: v.n === undefined ? null : "12.0", refHigh: v.n === undefined ? null : "15.0",
    enteredByType: "user", enteredById: "u-tech", entryMode: "manual",
    verificationStatus: v.verified ? "verified" : "unverified", verifiedBy: v.verified ? "u-path" : null,
    verifiedAt: v.verified ? new Date(v.at) : null, supersedesResultId: v.supersedes ?? null,
  });
  const oldHb = result(cbcItem!, hb, { n: "7.7700", verified: true, at: "2026-09-25T08:00:00.000Z" });
  await db.insert(labResults).values(oldHb as never);
  await db.insert(labResults).values([
    result(cbcItem!, hb, { n: "9.1000", verified: true, at: "2026-09-25T09:00:00.000Z", supersedes: oldHb.id, flag: "L" }),
    result(cbcItem!, plt, { n: "150000", verified: false, at: "2026-09-25T09:00:00.000Z" }),
    result(hivItem!, hivAb, { t: "Reactive", verified: true, at: "2026-09-25T09:00:00.000Z" }),
  ] as never);

  // ── radiology ──
  const xr = await service("XRCHEST", "X-ray chest PA view", "radiology");
  const usg = await service("USGOBS", "Obstetric ultrasound RESTRICTED-STUDY", "radiology");
  const ct = await service("CTHEAD", "CT head DRAFT-STUDY", "radiology");
  const imagingOrder = newId();
  await db.insert(orders).values({
    id: imagingOrder, orderNo: `RO-${imagingOrder.slice(-8)}`, orderGroupId: imagingOrder, kind: "imaging", patientId, encounterNo: VISIT_A,
    serviceDate: "2026-09-25", priority: "routine", authority: "clinician", orderedByType: "user", orderedById: "u-doctor",
    orderingClinicianId: "u-doctor", placedAt: new Date("2026-09-25T04:22:00.000Z"),
  } as never);
  const study = async (serviceId: string, accession: string, restricted: boolean, report: { status: string; impression: string }): Promise<void> => {
    const itemId = newId();
    await db.insert(orderItems).values({ id: itemId, orderId: imagingOrder, serviceId, restricted, status: "completed" } as never);
    const studyId = newId();
    await db.insert(imagingStudies).values({
      id: studyId, orderItemId: itemId, orderId: imagingOrder, patientId, encounterNo: VISIT_A, studyTypeCode: "xray",
      serviceId, accessionNo: accession, priority: "routine", workflowInstanceId: `wf-${accession}`, status: "reported",
    } as never);
    const signed = report.status === "signed";
    await db.insert(imagingReports).values({
      id: newId(), studyId, version: 1, status: report.status, templateKey: "xray",
      body: { technique: "PA erect", findings: "Lung fields clear." }, impression: report.impression,
      signerId: signed ? "u-rad" : null, signedAt: signed ? new Date("2026-09-25T10:00:00.000Z") : null,
      secondFactorAt: signed ? new Date("2026-09-25T10:00:00.000Z") : null,
    } as never);
  };
  await study(xr, "RA260925001", false, { status: "signed", impression: "No active lung lesion." });
  await study(usg, "RA260925002", true, { status: "signed", impression: "RESTRICTED-IMPRESSION" });
  await study(ct, "RA260925003", false, { status: "draft", impression: "DRAFT-IMPRESSION" });

  return {
    patientId, uhid, otherPatientId, encA, encB, encC, encOther,
    heldBack: {
      unverifiedAnalyte: "UNVERIFIED-ANALYTE", restrictedTest: "RESTRICTED-TEST",
      restrictedStudy: "RESTRICTED-STUDY", draftStudy: "DRAFT-STUDY", supersededValue: "7.77", oldRxDrug: "OLD-RX",
      internalComment: "INTERNAL-NOTE",
    },
  };
}
