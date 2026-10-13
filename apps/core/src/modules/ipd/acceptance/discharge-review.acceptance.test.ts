import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  events, invoices, ipdAdmissions, ipdChargeLines, ipdFinalBills, ipdPayerClaims, patientDocuments, refundVouchers,
} from "../../../kernel/db/schema";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkDischargeWorld } from "../../../../test/helpers/ipd";
import { mkTpaDesk } from "../../../../test/helpers/ipd-payer";
import {
  IpdRefusal, askDuesApproval, assertPayerAccounted, cancelFit, confirmCharges, declareFit, issueGatePass, listBillDesk,
  postNightlyIpdCharges, prepareFinalBill, readDischargeTracker, readFinalBill, recordDuesApproval, recordLama, recordPayerAuth,
  saveSummaryDraft, scanGatePass, settleFinalBill, signSummary, takeDeposit,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { DischargeWorld } from "../../../../test/helpers/ipd";

/**
 * E3.2 review (PR #762) — the findings, each pinned. Every act runs at an EXPLICIT IST instant; nothing reads the clock.
 */

jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = () => randomUUID();

async function refusal(p: Promise<unknown>): Promise<IpdRefusal> {
  try { await p; } catch (e) { if (e instanceof IpdRefusal) return e; throw e; }
  throw new Error("expected a refusal");
}

describe("E3.2 discharge review (#762)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: DischargeWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkDischargeWorld(db); });

  const linesOf = (id: string) => db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, id));
  const fitAndReady = async (admissionId: string, at: string, sign = true) => {
    await declareFit(db, w.doctor, { idempotencyKey: key(), admissionId, when: "today", disposition: "home" }, { now: ist(`${at}T09:00:00`) });
    await confirmCharges(db, w.duty, { idempotencyKey: key(), admissionId, department: "ward" }, { now: ist(`${at}T09:05:00`) });
    await confirmCharges(db, w.cashier, { idempotencyKey: key(), admissionId, department: "billing" }, { now: ist(`${at}T09:06:00`) });
    if (!sign) return;
    const d = await saveSummaryDraft(db, w.doctor, { idempotencyKey: key(), admissionId, expectedVersion: 0, content: { diagnosis: { text: "Fever" } } }, { now: ist(`${at}T09:07:00`) });
    await signSummary(db, w.doctor, { idempotencyKey: key(), admissionId, draftId: d.summaryId, draftVersion: d.version }, { now: ist(`${at}T09:08:00`) });
  };
  const settle = async (admissionId: string, at: Date, extra: Record<string, unknown> = {}) => {
    const b = await prepareFinalBill(db, w.cashier, admissionId, { now: at });
    return settleFinalBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: b.billVersion, patientPayablePaise: b.patientPaise, settlement: "paid",
      payments: b.balancePaise > 0 ? [{ tender: "cash", amountPaise: b.balancePaise }] : [], ...extra,
    }, { now: at });
  };
  const undertaking = async (patientId: string) => {
    const id = newId();
    await db.insert(patientDocuments).values({
      id, patientId, kind: "outside_report", mimeType: "image/jpeg", byteSize: 10, storageKey: `2026/03/${id}.jpg`, sha256: "0".repeat(64),
      capturedBy: w.cashier.id,
    });
    return id;
  };

  it("RED 1 — settle posts the charges itself, up to the settle instant, before composing", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    const read = await prepareFinalBill(db, w.cashier, admissionId, { now: ist("2026-03-12T09:20:00") }); // the 12th is free before 14:00
    const stale = await refusal(settleFinalBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: read.billVersion, patientPayablePaise: read.patientPaise, settlement: "paid",
      payments: [{ tender: "cash", amountPaise: read.balancePaise }],
    }, { now: ist("2026-03-12T15:00:00") }));
    // The settle posted the 12th itself (after 14:00 the discharge day is charged), so the 09:20 read is stale; the
    // refusal rolls the posting back with everything else.
    expect([stale.code, (stale.detail as { billVersion: number }).billVersion > read.billVersion]).toEqual(["bill_changed", true]);
    const fresh = await prepareFinalBill(db, w.cashier, admissionId, { now: ist("2026-03-12T15:01:00") });
    const out = await settleFinalBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: fresh.billVersion, patientPayablePaise: fresh.patientPaise, settlement: "paid",
      payments: [{ tender: "cash", amountPaise: fresh.balancePaise }],
    }, { now: ist("2026-03-12T15:02:00") });
    const day12 = (await linesOf(admissionId)).filter((l) => l.serviceDate === "2026-03-12");
    expect(day12.length).toBeGreaterThan(0);
    expect(out.totalPaise).toBe((await linesOf(admissionId)).reduce((t, l) => t + l.netPaise, 0));
  });

  it("RED 2 / RED 4 — the nightly job skips a settled admission; not out by the next midnight is a bill-desk exception", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    await settle(admissionId, ist("2026-03-12T09:30:00"));
    const before = (await linesOf(admissionId)).length;
    await postNightlyIpdCharges(db, ist("2026-03-13T00:05:00"));
    expect((await linesOf(admissionId)).length).toBe(before);
    const desk = await listBillDesk(db, w.cashier, { now: ist("2026-03-13T08:00:00") });
    expect(desk.rows.find((r) => r.admissionId === admissionId)?.exceptions).toContain("settled_not_exited");
    // A scan the same afternoon adds nothing (the bill was final at settlement).
    const pass = await issueGatePass(db, w.cashier, { idempotencyKey: key(), admissionId }, { now: ist("2026-03-12T09:40:00") });
    await scanGatePass(db, w.duty, { idempotencyKey: key(), gatePassCode: pass.code, gateId: newId(), scannedAt: ist("2026-03-12T16:00:00").toISOString() }, { now: ist("2026-03-12T16:00:00") });
    await postNightlyIpdCharges(db, ist("2026-03-14T00:05:00"));
    expect((await linesOf(admissionId)).length).toBe(before);
  });

  it("RED 3 — cancel_fit refuses after the final bill; an ending before posted charges refuses; an ending after the bill still ends the stay and flags it", async () => {
    const a = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(a.admissionId, "2026-03-12");
    await settle(a.admissionId, ist("2026-03-12T09:30:00"));
    const r = await refusal(cancelFit(db, w.doctor, { idempotencyKey: key(), admissionId: a.admissionId, reason: "worse" }, { now: ist("2026-03-12T10:00:00") }));
    expect([r.code, r.fix]).toEqual(["final_bill_exists", "Ask billing to void the bill"]);
    // ⚖ never blocked: LAMA after the bill ends the stay, and the bill desk reconciles.
    await recordLama(db, w.doctor, {
      idempotencyKey: key(), admissionId: a.admissionId, kind: "lama", signedBy: "patient", risksExplainedBy: w.doctor.id, formDocumentId: newId(),
      at: ist("2026-03-12T11:00:00").toISOString(),
    }, { now: ist("2026-03-12T11:00:00") });
    expect((await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, a.admissionId)))[0]!.state).toBe("lama");
    const desk = await listBillDesk(db, w.cashier, { now: ist("2026-03-12T12:00:00") });
    expect(desk.rows.find((x) => x.admissionId === a.admissionId)?.exceptions).toContain("ended_after_bill");

    const b = await w.admitAt("general", ist("2026-03-10T11:00:00"));
    await postNightlyIpdCharges(db, ist("2026-03-12T00:05:00")); // posts the 10th and the 11th
    const early = await refusal(recordLama(db, w.doctor, {
      idempotencyKey: key(), admissionId: b.admissionId, kind: "lama", signedBy: "patient", risksExplainedBy: w.doctor.id, formDocumentId: newId(),
      at: ist("2026-03-11T15:00:00").toISOString(),
    }, { now: ist("2026-03-12T08:00:00") }));
    expect(early.code).toBe("time_before_charges");
  });

  it("RED 5 — one source of truth: payer + patient = total to the paisa, claim = total − invoice; the view agrees with the settle", async () => {
    const tpa = await mkTpaDesk(db);
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await recordPayerAuth(db, tpa, {
      idempotencyKey: key(), admissionId, payerKind: "insurance_cashless", entry: "initial", status: "approved", provisionalCashlessSigned: true,
      approvedAmountPaise: 10_000_000, preAuthNumber: "PA-FAKE-1", coPayBp: 333,
    }, { now: ist("2026-03-10T11:00:00") });
    await fitAndReady(admissionId, "2026-03-12");
    const view = await prepareFinalBill(db, w.cashier, admissionId, { now: ist("2026-03-12T09:20:00") });
    expect(view.payerPaise + view.patientPaise).toBe(view.totalPaise);
    const out = await settleFinalBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: view.billVersion, patientPayablePaise: view.patientPaise, settlement: "paid",
      payments: [{ tender: "cash", amountPaise: view.patientRoundedPaise }],
    }, { now: ist("2026-03-12T09:25:00") });
    const row = (await db.select().from(ipdFinalBills).where(eq(ipdFinalBills.admissionId, admissionId)))[0]!;
    const inv = (await db.select().from(invoices).where(eq(invoices.id, row.invoiceId!)))[0]!;
    const claim = (await db.select().from(ipdPayerClaims).where(eq(ipdPayerClaims.admissionId, admissionId)))[0]!;
    expect(row.payerPaise + row.patientPaise).toBe(row.totalPaise);
    expect(row.patientPaise).toBe(inv.rawTotalPaise);
    expect(claim.claimPaise).toBe(row.totalPaise - inv.rawTotalPaise);
    expect(out.patientPayablePaise).toBe(view.patientPaise);
  });

  it("RED 5 — an odd-paise line keeps payer + patient = total (the invoice's rounding is not the split)", async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    await prepareFinalBill(db, w.cashier, admissionId, { now: ist("2026-03-12T09:20:00") });
    const room = (await linesOf(admissionId)).find((l) => l.component === "room")!;
    await db.insert(ipdChargeLines).values({
      ...room, id: newId(), patientId, serviceDate: "2026-03-11", component: "visit", source: "ipd.visit", visitSeq: 0, consultantUserId: w.consultantUserId,
      unitPaise: 12_345, grossPaise: 12_345, discountPaise: 0, taxablePaise: 12_345, cgstPaise: 0, sgstPaise: 0, netPaise: 12_345, postedAt: ist("2026-03-12T09:21:00"),
    });
    await settle(admissionId, ist("2026-03-12T09:30:00"));
    const row = (await db.select().from(ipdFinalBills).where(eq(ipdFinalBills.admissionId, admissionId)))[0]!;
    expect(row.totalPaise % 100).toBe(45);
    expect(row.payerPaise + row.patientPaise).toBe(row.totalPaise);
  });

  it("RED 6 — the deposit available is the receipts less the advance refunds already issued", async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await db.update(ipdAdmissions).set({ payerKind: "cash", stabilisedAt: ist("2026-03-10T10:30:00") }).where(eq(ipdAdmissions.id, admissionId));
    await takeDeposit(db, w.admitDesk, { idempotencyKey: key(), admissionId, amountPaise: 500_000, tender: "upi", tenderRef: "UPI-1", payer: { name: "Self", relation: "self" } }, { now: ist("2026-03-10T11:00:00") });
    await db.insert(refundVouchers).values({
      id: newId(), voucherNo: "RV-FAKE-1", patientId, kind: "advance_refund", amountPaise: 100_000, method: "cash", reasonClass: "genuine", reason: "part refund",
      guardFlags: {}, approvalId: newId(), requestedBy: w.cashier.id, issuedAt: ist("2026-03-11T10:00:00"),
    });
    await fitAndReady(admissionId, "2026-03-12");
    await settle(admissionId, ist("2026-03-12T09:30:00"));
    const row = (await db.select().from(ipdFinalBills).where(eq(ipdFinalBills.admissionId, admissionId)))[0]!;
    expect(row.depositAppliedPaise).toBe(400_000);
    expect(row.refundPaise).toBe(0);
  });

  it("RED 7 / RED 8 / 9 / 15 — dues record at once against a real undertaking; the approval follows the exit; no dues word in events", async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    const b = await prepareFinalBill(db, w.cashier, admissionId, { now: ist("2026-03-12T09:20:00") });
    const base = { idempotencyKey: key(), admissionId, billVersion: b.billVersion, patientPayablePaise: b.patientPaise, settlement: "dues_recorded", payments: [{ tender: "cash", amountPaise: 100_000 }] };
    // RED 8: an id that is no document, or another patient's document, is refused.
    expect((await refusal(settleFinalBill(db, w.cashier, { ...base, undertakingDocumentId: newId() }, { now: ist("2026-03-12T09:25:00") }))).code).toBe("undertaking_invalid");
    const other = await w.patient("female", 30);
    expect((await refusal(settleFinalBill(db, w.cashier, { ...base, idempotencyKey: key(), undertakingDocumentId: await undertaking(other) }, { now: ist("2026-03-12T09:25:00") }))).code).toBe("undertaking_invalid");
    // RED 7: no approval needed to leave.
    const out = await settleFinalBill(db, w.cashier, { ...base, idempotencyKey: key(), undertakingDocumentId: await undertaking(patientId) }, { now: ist("2026-03-12T09:30:00") });
    expect(out.duesPaise).toBe(b.patientRoundedPaise - 100_000);
    const pass = await issueGatePass(db, w.cashier, { idempotencyKey: key(), admissionId }, { now: ist("2026-03-12T09:35:00") });
    expect(pass.duesRecorded).toBe(true);
    await scanGatePass(db, w.duty, { idempotencyKey: key(), gatePassCode: pass.code, gateId: newId(), scannedAt: ist("2026-03-12T09:50:00").toISOString() }, { now: ist("2026-03-12T09:50:00") });
    expect((await listBillDesk(db, w.cashier, { now: ist("2026-03-12T10:00:00") })).rows.find((r) => r.admissionId === admissionId)?.exceptions).toContain("dues_awaiting_approval");
    // 9: the dues word never rides an event; a doctor's tracker does not carry it.
    const evs = (await db.select().from(events)).filter((e) => (e.payload as { admissionId?: string }).admissionId === admissionId);
    expect(evs.filter((e) => JSON.stringify(e.payload).includes("dues"))).toEqual([]);
    expect((await readDischargeTracker(db, w.doctor, admissionId, { now: ist("2026-03-12T10:00:00") })).gatePass?.duesRecorded).toBeNull();
    // 15: the requester never approves their own ask (the approvals kernel's requester ≠ approver).
    const self = await askDuesApproval(db, w.billingManager, { admissionId, amountPaise: out.duesPaise, note: "family pays Monday" });
    await expect(approveRequest(db, w.billingManager, { approvalId: self.approvalId, note: "self" })).rejects.toThrow();
    const asked = await askDuesApproval(db, w.cashier, { admissionId, amountPaise: out.duesPaise, note: "family pays Monday" });
    await approveRequest(db, w.billingManager, { approvalId: asked.approvalId, note: "undertaking on file" });
    await recordDuesApproval(db, w.cashier, { admissionId, approvalId: asked.approvalId }, { now: ist("2026-03-12T11:00:00") });
    expect((await listBillDesk(db, w.cashier, { now: ist("2026-03-12T11:05:00") })).rows.find((r) => r.admissionId === admissionId)?.exceptions ?? []).not.toContain("dues_awaiting_approval");
  });

  it("10 — the refund is pending until its voucher issues", async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await db.update(ipdAdmissions).set({ payerKind: "cash", stabilisedAt: ist("2026-03-10T10:30:00") }).where(eq(ipdAdmissions.id, admissionId));
    await takeDeposit(db, w.admitDesk, { idempotencyKey: key(), admissionId, amountPaise: 900_000, tender: "upi", tenderRef: "UPI-2", payer: { name: "Self", relation: "self" } }, { now: ist("2026-03-10T11:00:00") });
    await fitAndReady(admissionId, "2026-03-12");
    await settle(admissionId, ist("2026-03-12T09:30:00"), { settlement: "refund_due" });
    expect((await readFinalBill(db, w.cashier, admissionId)).settled?.refundState).toBe("refund_pending");
    const row = (await db.select().from(ipdFinalBills).where(eq(ipdFinalBills.admissionId, admissionId)))[0]!;
    await db.insert(refundVouchers).values({
      id: newId(), voucherNo: "RV-FAKE-2", patientId, kind: "advance_refund", amountPaise: row.refundPaise, method: "cash", reasonClass: "genuine", reason: "excess",
      guardFlags: {}, approvalId: row.refundApprovalId!, requestedBy: w.cashier.id, issuedAt: ist("2026-03-12T12:00:00"),
    });
    expect((await readFinalBill(db, w.cashier, admissionId)).settled?.refundState).toBe("refund_issued");
  });

  it("11 — the settle names the patient amount it read; a different recomputed amount refuses", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    const b = await prepareFinalBill(db, w.cashier, admissionId, { now: ist("2026-03-12T09:20:00") });
    const r = await refusal(settleFinalBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: b.billVersion, patientPayablePaise: b.patientPaise - 1, settlement: "paid",
      payments: [{ tender: "cash", amountPaise: b.patientRoundedPaise }],
    }, { now: ist("2026-03-12T09:25:00") }));
    expect(r.code).toBe("bill_changed");
  });

  it("13 — a system actor holds no department: confirm_charges refuses it", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await declareFit(db, w.doctor, { idempotencyKey: key(), admissionId, when: "today", disposition: "home" }, { now: ist("2026-03-12T09:00:00") });
    const r = await refusal(confirmCharges(db, { type: "system", id: "some-job" }, { idempotencyKey: key(), admissionId, department: "ward" }, { now: ist("2026-03-12T09:05:00") }));
    expect(r.code).toBe("department_not_yours");
  });

  it("14 — a payer portion with no payer on the admission is refused, never dropped", () => {
    expect(() => assertPayerAccounted(500, null)).toThrow(IpdRefusal);
    expect(() => assertPayerAccounted(0, null)).not.toThrow();
    expect(() => assertPayerAccounted(500, "insurance_cashless")).not.toThrow();
  });

});
