import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { withTx } from "../../../kernel/db/client";
import { idempotencyKeys, ipdAdmissions, receipts } from "../../../kernel/db/schema";
import { recordReceipt } from "../../billing";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ADMIT_RATES, mkAdmitWorld } from "../../../../test/helpers/ipd";
import {
  admit, askApproval, askEmergencyIcuApproval, backfillDowntime, cancelAdmission, emergencyAdmit, pendingDepositChecks,
  planAdmission, recordPayerAuth, recordStabilised, registerIpdReceiptGuard, requestAdmission, takeDeposit,
} from "../index";
import { requestIpdApproval } from "../approval-types";
import type { Db } from "../../../kernel/db/client";
import type { AdmitWorld } from "../../../../test/helpers/ipd";

/**
 * E1.2 review of PR #751 — money first. Each check calls the intent (or billing's generic receipt writer), never a
 * screen. Synthetic people and amounts; times are relative to the real clock.
 */
jest.setTimeout(120_000);

const PAPER = { signedBy: "patient" as const, method: "paper" as const, witnessName: "Desk Witness" };
const key = (): string => randomUUID();
const DAY = ADMIT_RATES.general.room + ADMIT_RATES.general.nursing + ADMIT_RATES.general.visit;

describe("E1.2 admission — review fixes", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: AdmitWorld;
  let unregister: (() => void) | null = null;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkAdmitWorld(db); });
  afterEach(() => { unregister?.(); unregister = null; });

  const request = (patientId: string, over: Record<string, unknown> = {}) => requestAdmission(db, w.doctor, {
    idempotencyKey: key(), patientId, source: "direct", consultantId: w.doctor.id, requestedClass: "general",
    isolation: "none", provisionalDiagnosis: "Synthetic", mlc: false, ...over,
  });
  const plan = (admissionId: string, over: Record<string, unknown> = {}) => planAdmission(db, w.admitDesk, {
    idempotencyKey: key(), admissionId, payerKind: "cash", requestedClass: "general", plan: { kind: "medical" }, ...over,
  });
  const depositInput = (admissionId: string, amountPaise: number, over: Record<string, unknown> = {}) => ({
    idempotencyKey: key(), admissionId, amountPaise, tender: "cash", payer: { name: "Synthetic Payer", relation: "self" }, ...over,
  });
  const schemeAdmission = async (approvedPaise?: number): Promise<{ admissionId: string; patientId: string; approvalId: string | null }> => {
    const patientId = await w.patient("male");
    const { admissionId } = await request(patientId);
    await plan(admissionId, { payerKind: "pmjay" });
    if (approvedPaise === undefined) return { admissionId, patientId, approvalId: null };
    const { approvalId } = await askApproval(db, w.admitDesk, admissionId, { kind: "non_covered", note: "Attendant bed", amountPaise: approvedPaise });
    await approveRequest(db, w.billingManager, { approvalId, note: "non-covered" });
    return { admissionId, patientId, approvalId };
  };

  it("RED 1: a retry after the idempotency claim is lost never takes the money twice", async () => {
    const p = await w.patient("female");
    const { admissionId } = await request(p);
    await plan(admissionId);
    const input = depositInput(admissionId, 3 * DAY);
    const first = await takeDeposit(db, w.admitDesk, input);
    // The claim vanishes (the case where the receipt committed but the claim was dropped).
    await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, "ipd:take_deposit%"));
    const again = await takeDeposit(db, w.admitDesk, input);
    expect(again.receiptId).toBe(first.receiptId);
    expect(await db.select().from(receipts).where(eq(receipts.patientId, p))).toHaveLength(1);
  });

  it("RED 2: a non-covered line must name its amount; an approval without one never admits money", async () => {
    const { admissionId, patientId } = await schemeAdmission();
    await expect(askApproval(db, w.admitDesk, admissionId, { kind: "non_covered", note: "No amount" }))
      .rejects.toMatchObject({ code: "non_covered_amount_required" });
    const { approvalId } = await withTx(db, (tx) => requestIpdApproval(tx, w.admitDesk, { kind: "non_covered", subjectId: admissionId, patientId, note: "No amount" }));
    await approveRequest(db, w.billingManager, { approvalId, note: "granted without an amount" });
    await expect(takeDeposit(db, w.admitDesk, depositInput(admissionId, 10_000, { nonCoveredApprovalId: approvalId })))
      .rejects.toMatchObject({ code: "scheme_patient_no_deposit" });
  });

  it("RED 3: the generic billing receipt refuses a scheme inpatient beyond the approved non-covered total", async () => {
    unregister = registerIpdReceiptGuard();
    const { patientId } = await schemeAdmission();
    const generic = (amountPaise: number) => recordReceipt(db, w.admitDesk, { patientId, tenders: [{ mode: "cash", amountPaise }] });
    await expect(generic(10_000)).rejects.toMatchObject({ code: "receipt_guard_refused" });
    const q = await w.patient("female");
    const s = await request(q);
    await plan(s.admissionId, { payerKind: "pmjay" });
    const { approvalId } = await askApproval(db, w.admitDesk, s.admissionId, { kind: "non_covered", note: "Line", amountPaise: 100_000 });
    await approveRequest(db, w.billingManager, { approvalId, note: "ok" });
    const genericQ = (amountPaise: number) => recordReceipt(db, w.admitDesk, { patientId: q, tenders: [{ mode: "cash", amountPaise }] });
    await expect(genericQ(100_000)).resolves.toMatchObject({ totalPaise: 100_000 });
    await expect(genericQ(100)).rejects.toMatchObject({ code: "receipt_guard_refused" });
    // The admission desk's own deposit is held to the same total (the generic receipt already used it).
    await expect(takeDeposit(db, w.admitDesk, depositInput(s.admissionId, 100, { nonCoveredApprovalId: approvalId })))
      .rejects.toMatchObject({ code: "scheme_patient_no_deposit" });
  });

  it("#4: two simultaneous scheme deposits cannot both fit under one approved line", async () => {
    const { admissionId, approvalId } = await schemeAdmission(100_000);
    const results = await Promise.allSettled([60_000, 60_000].map((amt) =>
      takeDeposit(db, w.admitDesk, depositInput(admissionId, amt, { nonCoveredApprovalId: approvalId }))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(["scheme_patient_no_deposit"]);
  });

  it("#5: admit judges the deposit on the locked row — a payer changed while it waited is not admitted on the old basis", async () => {
    const { admissionId } = await schemeAdmission();
    const bed = await w.bed("T-R5");
    // Another desk holds the admission while switching it to cash (same ₹0 required, different basis).
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const other = withTx(db, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ipd_admission:${admissionId}`}))`);
      await tx.update(ipdAdmissions).set({ payerKind: "cash", depositBasis: "medical_class_days" }).where(eq(ipdAdmissions.id, admissionId));
      await held;
    });
    const admitting = admit(db, w.admitDesk, { idempotencyKey: key(), admissionId, bedId: bed, consent: PAPER, deposit: { exempt: "scheme" } });
    await new Promise((r) => setTimeout(r, 300));
    release();
    await other;
    await expect(admitting).rejects.toMatchObject({ code: "deposit_required" });
  });

  it("#6: the plan quotes the class actually recorded (an admitted emergency patient's bed class)", async () => {
    const p = await w.patient("male");
    const bed = await w.bed("T-ER6", { class: "emergency" });
    const done = await emergencyAdmit(db, w.admitDesk, { idempotencyKey: key(), patientId: p, bedId: bed, consultantId: w.doctor.id, isolation: "none", mlc: false });
    await recordStabilised(db, w.doctor, { idempotencyKey: key(), admissionId: done.admissionId, stabilisedAt: new Date(Date.now() - 60_000).toISOString() });
    // Asked for general (priced), but the class recorded is the emergency bay's, which carries no daily rate.
    await expect(plan(done.admissionId, { requestedClass: "general" })).rejects.toMatchObject({ code: "rate_missing", detail: { class: "emergency" } });
  });

  it("#7: a downtime back-fill is listed for the bill desk's deposit check; a scheme back-fill still refuses money", async () => {
    const mk = async (payerKind: string, serial: string) => backfillDowntime(db, w.admitDesk, {
      idempotencyKey: key(), paperSerial: serial, patientId: await w.patient("female"), bedId: await w.bed(`T-${serial}`),
      consultantId: w.doctor.id, requestedClass: "general", isolation: "none", provisionalDiagnosis: "Synthetic", mlc: false,
      payerKind, requestedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), admittedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      consent: PAPER,
    });
    const cash = await mk("cash", "DT-71");
    const row = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, cash.admissionId)))[0]!;
    expect(row).toMatchObject({ depositBasis: "downtime_backfill", depositCheckPending: true });
    expect((await pendingDepositChecks(db, w.admitDesk)).map((v) => v.id)).toEqual([cash.admissionId]);
    const scheme = await mk("pmjay", "DT-72");
    await expect(takeDeposit(db, w.admitDesk, depositInput(scheme.admissionId, 10_000))).rejects.toMatchObject({ code: "scheme_patient_no_deposit" });
    // Taking the cash patient's deposit clears the check.
    await takeDeposit(db, w.admitDesk, depositInput(cash.admissionId, 50_000));
    expect(await pendingDepositChecks(db, w.admitDesk)).toEqual([]);
  });

  it("#9: a request with a deposit still on account is not cancelled until it is refunded", async () => {
    const p = await w.patient("male");
    const { admissionId } = await request(p);
    await plan(admissionId);
    await takeDeposit(db, w.admitDesk, depositInput(admissionId, 3 * DAY));
    await expect(cancelAdmission(db, w.admitDesk, { idempotencyKey: key(), admissionId, reason: "patient_declined" }))
      .rejects.toMatchObject({ code: "deposit_not_refunded", fix: "Refund the deposit first" });
  });

  it("#10: an emergency ICU approval names the admission it was asked for", async () => {
    const p = await w.patient("female");
    const bed = await w.bed("T-ICU10", { class: "icu", icu: true });
    const input = (admissionId: string, approvalId: string) => ({
      idempotencyKey: key(), patientId: p, bedId: bed, consultantId: w.doctor.id, isolation: "none", mlc: false,
      admissionId, intensivistApprovalId: approvalId,
    });
    const asked = await askEmergencyIcuApproval(db, w.admitDesk, { patientId: p, note: "Synthetic shock" });
    await approveRequest(db, w.ms, { approvalId: asked.approvalId, note: "ICU" });
    // The approval cannot be carried to another admission id.
    await expect(emergencyAdmit(db, w.admitDesk, input("01ARZ3NDEKTSV4RRFFQ69G5FAV", asked.approvalId))).rejects.toMatchObject({ code: "icu_needs_intensivist" });
    await expect(emergencyAdmit(db, w.admitDesk, input(asked.admissionId, asked.approvalId))).resolves.toMatchObject({ admissionId: asked.admissionId, state: "admitted" });
  });

  it("#11: a payer change re-quotes the deposit from the tariff", async () => {
    const p = await w.patient("male");
    const { admissionId } = await request(p);
    await plan(admissionId);
    await recordPayerAuth(db, w.admitDesk, {
      idempotencyKey: key(), admissionId, payerKind: "pmjay", entry: "payer_change", status: "approved", provisionalCashlessSigned: false,
    });
    const row = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!;
    expect(row).toMatchObject({ payerKind: "pmjay", depositRequiredPaise: 0, depositBasis: "scheme_zero" });
  });
});
