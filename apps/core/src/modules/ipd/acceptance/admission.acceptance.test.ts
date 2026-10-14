import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { withTx } from "../../../kernel/db/client";
import { events, ipdAdmissions, ipdBedStays } from "../../../kernel/db/schema";
import { addAllergy } from "../../patients";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ADMIT_RATES, mkAdmitWorld } from "../../../../test/helpers/ipd";
import {
  admit, askApproval, backfillDowntime, emergencyAdmit, planAdmission, printBand, requestAdmission, takeDeposit,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { AdmitWorld } from "../../../../test/helpers/ipd";

/**
 * E1.2 (#719) — "DONE MEANS" FOR ADMISSION (spec SPEC-ipd-core §6 Admission; decision 0072). Every check calls the
 * INTENT function, never a screen. Times are relative to the real clock (a few hours back), never a pinned date.
 */

jest.setTimeout(120_000);

const PAPER = { signedBy: "patient" as const, method: "paper" as const, witnessName: "Desk Witness" };
const key = (): string => randomUUID();

describe("E1.2 admission — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: AdmitWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkAdmitWorld(db); });

  const request = (patientId: string, over: Record<string, unknown> = {}) => requestAdmission(db, w.doctor, {
    idempotencyKey: key(), patientId, source: "direct", consultantId: w.doctor.id, requestedClass: "general",
    isolation: "none", provisionalDiagnosis: "Synthetic fever", mlc: false, ...over,
  });
  const plan = (admissionId: string, over: Record<string, unknown> = {}) => planAdmission(db, w.admitDesk, {
    idempotencyKey: key(), admissionId, payerKind: "cash", requestedClass: "general", plan: { kind: "medical" }, ...over,
  });
  const pay = (admissionId: string, amountPaise: number, over: Record<string, unknown> = {}) => takeDeposit(db, w.admitDesk, {
    idempotencyKey: key(), admissionId, amountPaise, tender: "cash", payer: { name: "Synthetic Payer", relation: "self" }, ...over,
  });

  it("(i) a second open admission for the same patient is refused and shows the first", async () => {
    const p = await w.patient("male");
    const first = await request(p);
    const refused = request(p);
    await expect(refused).rejects.toMatchObject({ code: "admission_already_open", detail: { admissionId: first.admissionId, state: "requested" } });
    // The emergency lane and the back-fill obey the same rule.
    const bed = await w.bed("T-ER1", { class: "emergency" });
    await expect(emergencyAdmit(db, w.admitDesk, {
      idempotencyKey: key(), patientId: p, bedId: bed, consultantId: w.doctor.id, isolation: "none", mlc: false,
    })).rejects.toMatchObject({ code: "admission_already_open", detail: { admissionId: first.admissionId } });
    expect(await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.patientId, p))).toHaveLength(1);
  });

  it("(ii) ICU admission without an intensivist's approval is refused; with a granted approval it admits", async () => {
    const p = await w.patient("female");
    const bed = await w.bed("T-ICU1", { class: "icu", icu: true });
    const { admissionId } = await request(p, { requestedClass: "icu" });
    await plan(admissionId, { requestedClass: "icu" });
    const required = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!.depositRequiredPaise!;
    const { receiptId } = await pay(admissionId, required, { tender: "upi", tenderRef: "UPI-SYN-1" });
    const admitInput = (approval?: string) => ({
      idempotencyKey: key(), admissionId, bedId: bed, consent: PAPER, deposit: { receiptId },
      ...(approval === undefined ? {} : { intensivistApprovalId: approval }),
    });
    await expect(admit(db, w.admitDesk, admitInput())).rejects.toMatchObject({ code: "icu_needs_intensivist" });
    const { approvalId } = await askApproval(db, w.admitDesk, admissionId, { kind: "icu", note: "Synthetic sepsis" });
    // Asked but not yet granted: still refused. The clerk alone cannot.
    await expect(admit(db, w.admitDesk, admitInput(approvalId))).rejects.toMatchObject({ code: "icu_needs_intensivist" });
    await approveRequest(db, w.ms, { approvalId, note: "ICU bed justified" });
    await expect(admit(db, w.admitDesk, admitInput(approvalId))).resolves.toMatchObject({ state: "admitted", bedId: bed });
  });

  it("(iii) a PM-JAY admission refuses a receipt unless a line is marked non-covered by an approver", async () => {
    const p = await w.patient("male");
    const { admissionId } = await request(p);
    await expect(plan(admissionId, { payerKind: "pmjay" })).resolves.toMatchObject({ depositRequiredPaise: 0, depositBasis: "scheme_zero" });
    await expect(pay(admissionId, 100_000)).rejects.toMatchObject({ code: "scheme_patient_no_deposit" });
    const { approvalId } = await askApproval(db, w.admitDesk, admissionId, { kind: "non_covered", note: "Attendant bed, not in package", amountPaise: 150_000 });
    // Requested, not decided: still refused.
    await expect(pay(admissionId, 100_000, { nonCoveredApprovalId: approvalId })).rejects.toMatchObject({ code: "scheme_patient_no_deposit" });
    await approveRequest(db, w.billingManager, { approvalId, note: "non-covered line" });
    await expect(pay(admissionId, 100_000, { nonCoveredApprovalId: approvalId })).resolves.toMatchObject({ amountPaise: 100_000 });
    // Never more than the approved line.
    await expect(pay(admissionId, 60_000, { nonCoveredApprovalId: approvalId })).rejects.toMatchObject({ code: "scheme_patient_no_deposit" });
    // Admission itself needs no money: the scheme exemption.
    const bed = await w.bed("T-G1");
    await expect(admit(db, w.admitDesk, {
      idempotencyKey: key(), admissionId, bedId: bed, consent: PAPER, deposit: { exempt: "scheme" },
    })).resolves.toMatchObject({ state: "admitted" });
  });

  it("(iv) the band print payload carries the allergy in words", async () => {
    const p = await w.patient("female", 52, "Synthetic Allergic");
    await withTx(db, (tx) => addAllergy(tx, w.admitDesk, p, { substance: "Penicillin", severity: "severe", source: "registration" }));
    const { admissionId } = await request(p);
    await plan(admissionId);
    const { receiptId } = await pay(admissionId, 3 * (ADMIT_RATES.general.room + ADMIT_RATES.general.nursing + ADMIT_RATES.general.visit));
    const bed = await w.bed("T-G2");
    await admit(db, w.admitDesk, { idempotencyKey: key(), admissionId, bedId: bed, consent: PAPER, deposit: { receiptId } });
    const band = await printBand(db, w.admitDesk, { idempotencyKey: key(), admissionId, size: "adult", site: "wrist" });
    expect(band.band.allergyWords).toEqual(["Allergy: Penicillin (severe)"]);
    expect(band.band.bedCode).toBe("T-G2");
    expect(band.band.qr).toContain(band.bandSerial);
    await expect(printBand(db, w.admitDesk, { idempotencyKey: key(), admissionId, size: "adult", site: "wrist" }))
      .rejects.toMatchObject({ code: "band_already_printed" });
  });

  it("(v) an emergency admission takes no deposit before stabilisation", async () => {
    const p = await w.patient("male");
    const bed = await w.bed("T-ER2", { class: "emergency" });
    const done = await emergencyAdmit(db, w.admitDesk, {
      idempotencyKey: key(), patientId: p, bedId: bed, consultantId: w.doctor.id, isolation: "none", mlc: true,
    });
    expect(done).toMatchObject({ state: "admitted", bedId: bed });
    expect(done.incomplete).toEqual(expect.arrayContaining(["consent", "payer", "band", "stabilised", "diagnosis"]));
    await plan(done.admissionId);
    await expect(pay(done.admissionId, 100_000)).rejects.toMatchObject({ code: "deposit_before_stabilisation" });
    const row = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, done.admissionId)))[0]!;
    expect(row).toMatchObject({ depositRequiredPaise: 0, depositBasis: "emergency_exempt", depositExemption: "emergency_not_stabilised" });
  });

  it("(vi) a downtime back-fill keeps the paper's times and refuses a reused serial", async () => {
    const p = await w.patient("female");
    const bed = await w.bed("T-G3");
    const requestedAt = new Date(Date.now() - 5 * 3_600_000);
    const admittedAt = new Date(Date.now() - 4 * 3_600_000);
    const input = (patientId: string, bedId: string) => ({
      idempotencyKey: key(), paperSerial: "DT-0042", patientId, bedId, consultantId: w.doctor.id, requestedClass: "general",
      isolation: "none", provisionalDiagnosis: "Synthetic", mlc: false, payerKind: "cash",
      requestedAt: requestedAt.toISOString(), admittedAt: admittedAt.toISOString(), consent: PAPER,
    });
    const done = await backfillDowntime(db, w.admitDesk, input(p, bed));
    expect(new Date(done.admittedAt).getTime()).toBe(admittedAt.getTime());
    const row = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, done.admissionId)))[0]!;
    expect(row.requestedAt.getTime()).toBe(requestedAt.getTime());
    expect(row.admittedAt!.getTime()).toBe(admittedAt.getTime());
    const stay = (await db.select().from(ipdBedStays).where(eq(ipdBedStays.admissionId, done.admissionId)))[0]!;
    expect(stay.startedAt.getTime()).toBe(admittedAt.getTime());
    const req = (await db.select().from(events).where(and(eq(events.name, "ipd.admission.requested"), eq(events.correlationId, done.admissionId))))[0]!;
    expect(req.occurredAt.getTime()).toBe(requestedAt.getTime());
    // The same paper serial again (another patient, another bed): refused, showing the first.
    const q = await w.patient("male");
    const bed2 = await w.bed("T-G4");
    await expect(backfillDowntime(db, w.admitDesk, { ...input(q, bed2), paperSerial: "dt-0042" }))
      .rejects.toMatchObject({ code: "downtime_serial_used", detail: { admissionId: done.admissionId } });
  });

  it("(vii) the deposit is three class days from the tariff; a missing rate refuses, naming class and component", async () => {
    const p = await w.patient("male");
    const { admissionId } = await request(p);
    const day = ADMIT_RATES.general.room + ADMIT_RATES.general.nursing + ADMIT_RATES.general.visit;
    await expect(plan(admissionId)).resolves.toMatchObject({ depositRequiredPaise: 3 * day, estimatePaise: 3 * day, depositBasis: "medical_class_days" });
    const icuDay = ADMIT_RATES.icu.room + ADMIT_RATES.icu.nursing + ADMIT_RATES.icu.visit;
    await expect(plan(admissionId, { requestedClass: "icu" })).resolves.toMatchObject({ depositRequiredPaise: 3 * icuDay, depositBasis: "icu_class_days" });
    await expect(plan(admissionId, { plan: { kind: "surgical", procedureEstimatePaise: 4_000_050 } }))
      .resolves.toMatchObject({ depositRequiredPaise: 2_000_100, depositBasis: "surgery_estimate_share" });
    await expect(plan(admissionId, { requestedClass: "private" })).rejects.toMatchObject({
      code: "rate_missing", detail: { class: "private", missing: ["room", "nursing", "visit"] },
    });
  });
});
