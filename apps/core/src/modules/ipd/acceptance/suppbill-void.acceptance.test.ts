import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { approvals, creditNotes, invoices, ipdAdmissions, ipdChargeLines, ipdFinalBills, patientDocuments } from "../../../kernel/db/schema";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { BillingError, issueRefundVoucher } from "../../billing";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkDischargeWorld } from "../../../../test/helpers/ipd";
import {
  IpdError, IpdRefusal, askBillVoid, cancelFit, confirmCharges, declareFit, issueGatePass, listBillDesk, postNightlyIpdCharges,
  prepareFinalBill, prepareSupplementaryBill, registerIpdRefundVoucherGuard, saveSummaryDraft, settleFinalBill, settleSupplementaryBill,
  signSummary, takeDeposit, voidBill,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { DischargeWorld } from "../../../../test/helpers/ipd";

/**
 * #763 — "DONE MEANS" FOR THE SUPPLEMENTARY BILL AND THE VOID (Refs #730, review #762). Every act runs at an EXPLICIT IST
 * instant; nothing here reads the clock for a date.
 *
 * 1. A settled patient who stays another night gets a supplementary bill for that night.
 * 2. A voided final bill allows cancel_fit, and re-settling composes ONE new bill; every money move is a document.
 * 3. A void after the refund was issued is refused; a refund not yet issued is cancelled and its voucher never issues.
 * 4. A self-approved void is refused.
 * 5. ⚖ The gate pass is never blocked when dues are recorded.
 */

jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = () => randomUUID();

async function refusal(p: Promise<unknown>): Promise<IpdRefusal> {
  try { await p; } catch (e) { if (e instanceof IpdRefusal) return e; throw e; }
  throw new Error("expected a refusal");
}
async function ipdError(p: Promise<unknown>): Promise<IpdError> {
  try { await p; } catch (e) { if (e instanceof IpdError) return e; throw e; }
  throw new Error("expected an IpdError");
}

describe("#763 supplementary bill and void — done means", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: DischargeWorld;
  let unguard: () => void;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); unguard = registerIpdRefundVoucherGuard(); });
  afterAll(async () => { unguard(); await teardown(); });
  beforeEach(async () => { await truncateAll(db); w = await mkDischargeWorld(db); });

  const linesOf = (id: string) => db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, id));
  const billsOf = (id: string) => db.select().from(ipdFinalBills).where(eq(ipdFinalBills.admissionId, id));
  const liveOf = (id: string) => db.select().from(ipdFinalBills).where(and(eq(ipdFinalBills.admissionId, id), isNull(ipdFinalBills.voidedAt)));
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
  const deposit = async (admissionId: string, amountPaise: number) => {
    await db.update(ipdAdmissions).set({ payerKind: "cash", stabilisedAt: ist("2026-03-10T10:30:00") }).where(eq(ipdAdmissions.id, admissionId));
    await takeDeposit(db, w.admitDesk, {
      idempotencyKey: key(), admissionId, amountPaise, tender: "upi", tenderRef: `UPI-${key().slice(0, 8)}`, payer: { name: "Self", relation: "self" },
    }, { now: ist("2026-03-10T11:00:00") });
  };
  /** Ask (cashier) → the billing manager grants → the cashier voids. */
  const askAndGrant = async (admissionId: string, billId: string) => {
    const asked = await askBillVoid(db, w.cashier, { admissionId, billId, reason: "wrong room class billed" });
    await approveRequest(db, w.billingManager, { approvalId: asked.approvalId, note: "checked with the ward" });
    return asked.approvalId;
  };

  it("1 — a settled patient who stays another night gets a supplementary bill for that night", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    const final = await settle(admissionId, ist("2026-03-12T09:30:00"));
    const atSettle = (await linesOf(admissionId)).length;
    // The settlement day is the final bill's (review #762 RED 4): the first midnight posts nothing behind it.
    await postNightlyIpdCharges(db, ist("2026-03-13T00:05:00"));
    expect((await linesOf(admissionId)).length).toBe(atSettle);
    // Still in the bed through the 13th: the next midnight posts the 13th — into the supplementary running bill.
    await postNightlyIpdCharges(db, ist("2026-03-14T00:05:00"));
    const night = (await linesOf(admissionId)).filter((l) => l.serviceDate === "2026-03-13");
    expect(night.length).toBeGreaterThan(0);
    const desk = (await listBillDesk(db, w.cashier, { now: ist("2026-03-14T08:00:00") })).rows.find((r) => r.admissionId === admissionId);
    expect(desk?.exceptions).toEqual(expect.arrayContaining(["settled_not_exited", "supplementary_owed"]));

    // The gate pass asks for it first.
    const blocked = await refusal(issueGatePass(db, w.cashier, { idempotencyKey: key(), admissionId }, { now: ist("2026-03-14T09:00:00") }));
    expect(blocked.code).toBe("supplementary_unsettled");

    const supp = await prepareSupplementaryBill(db, w.cashier, admissionId, { now: ist("2026-03-14T09:05:00") });
    expect(new Set(supp.lines.map((l) => l.serviceDate))).toEqual(new Set(["2026-03-13"]));
    const out = await settleSupplementaryBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: supp.billVersion, patientPayablePaise: supp.patientPaise, settlement: "paid",
      payments: [{ tender: "cash", amountPaise: supp.balancePaise }],
    }, { now: ist("2026-03-14T09:10:00") });
    expect(out.totalPaise).toBe(night.reduce((t, l) => t + l.netPaise, 0));

    // Two documents for one admission: the final bill's invoice and the supplementary bill's, no line in both.
    const live = await liveOf(admissionId);
    expect(live.map((b) => [b.kind, b.seq])).toEqual([["final", 0], ["supplementary", 1]]);
    const [f, s] = [live.find((b) => b.seq === 0)!, live.find((b) => b.seq === 1)!];
    expect(s.invoiceId).not.toBeNull();
    expect(s.invoiceId).not.toBe(f.invoiceId);
    expect(f.id).toBe(final.billId);
    expect(s.lineIds.filter((id) => f.lineIds.includes(id))).toEqual([]);
    expect(new Set([...f.lineIds, ...s.lineIds])).toEqual(new Set((await linesOf(admissionId)).map((l) => l.id)));

    // Paid — the pass issues now; and a void takes the newest bill first.
    const pass = await issueGatePass(db, w.cashier, { idempotencyKey: key(), admissionId }, { now: ist("2026-03-14T09:15:00") });
    expect(pass.duesRecorded).toBe(false);
    const approvalId = await askAndGrant(admissionId, f.id);
    const older = await ipdError(voidBill(db, w.cashier, { idempotencyKey: key(), admissionId, billId: f.id, approvalId, reason: "wrong class" }, { now: ist("2026-03-14T09:20:00") }));
    expect(older.code).toBe("void_newer_bill_first");
  });

  it("2 — a voided final bill allows cancel_fit; re-settling composes ONE new bill; every money move is a document", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await deposit(admissionId, 300_000);
    await fitAndReady(admissionId, "2026-03-12");
    const first = await settle(admissionId, ist("2026-03-12T09:30:00"));
    const before = (await billsOf(admissionId))[0]!;
    expect((await refusal(cancelFit(db, w.doctor, { idempotencyKey: key(), admissionId, reason: "worse" }, { now: ist("2026-03-12T10:00:00") }))).code)
      .toBe("final_bill_exists");

    const approvalId = await askAndGrant(admissionId, first.billId);
    const voided = await voidBill(db, w.cashier, { idempotencyKey: key(), admissionId, billId: first.billId, approvalId, reason: "wrong room class billed" },
      { now: ist("2026-03-12T10:05:00") });
    // The money moved by DOCUMENTS: a correction credit note against the invoice for its whole value; the invoice row unchanged.
    const notes = await db.select().from(creditNotes).where(eq(creditNotes.invoiceId, before.invoiceId!));
    const inv = (await db.select().from(invoices).where(eq(invoices.id, before.invoiceId!)))[0]!;
    expect(notes.map((n) => [n.kind, n.netPaise])).toEqual([["correction", inv.netPayablePaise]]);
    expect(voided.creditNoteNo).toBe(notes[0]!.creditNoteNo);
    const row = (await billsOf(admissionId))[0]!;
    expect([row.voidedBy, row.voidApprovalId, row.creditNoteId]).toEqual([w.cashier.id, approvalId, notes[0]!.id]);

    // The running bill is open again: cancel_fit proceeds.
    const cancelled = await cancelFit(db, w.doctor, { idempotencyKey: key(), admissionId, reason: "spiked a fever" }, { now: ist("2026-03-12T10:10:00") });
    expect(cancelled.state).toBe("admitted");

    // A later discharge: the days the void reopened post again, and the settle composes ONE new bill from every line.
    await postNightlyIpdCharges(db, ist("2026-03-13T00:05:00"));
    await fitAndReady(admissionId, "2026-03-13", false);
    const second = await settle(admissionId, ist("2026-03-13T09:30:00"));
    const live = await liveOf(admissionId);
    expect(live.map((b) => b.id)).toEqual([second.billId]);
    expect((await billsOf(admissionId)).length).toBe(2);
    const all = await linesOf(admissionId);
    expect(second.totalPaise).toBe(all.reduce((t, l) => t + l.netPaise, 0));
    expect(new Set(live[0]!.lineIds)).toEqual(new Set(all.map((l) => l.id)));
    expect(live[0]!.invoiceId).not.toBe(before.invoiceId);
    // The deposit the voided bill had used, and the cash paid on it (adopted as the stay's deposit), are applied again —
    // the allocations were reversed by documents, never edited.
    const newInv = (await db.select().from(invoices).where(eq(invoices.id, live[0]!.invoiceId!)))[0]!;
    expect(live[0]!.depositAppliedPaise).toBe(Math.min(300_000 + before.paidPaise, newInv.netPayablePaise));
  });

  it("3 — a void after the refund was issued is refused; a refund not yet issued is cancelled and never issues", async () => {
    const issued = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await deposit(issued.admissionId, 900_000);
    await fitAndReady(issued.admissionId, "2026-03-12");
    const a = await settle(issued.admissionId, ist("2026-03-12T09:30:00"), { settlement: "refund_due" });
    expect(a.refundPaise).toBeGreaterThan(0);
    const aRow = (await billsOf(issued.admissionId))[0]!;
    await approveRequest(db, w.billingManager, { approvalId: aRow.refundApprovalId!, note: "excess deposit" });
    await issueRefundVoucher(db, w.billingManager, {
      kind: "advance_refund", patientId: issued.patientId, amountPaise: a.refundPaise, reasonClass: "genuine", reason: "excess deposit",
      approvalId: aRow.refundApprovalId!, method: "bank_transfer",
    }, ist("2026-03-12T11:00:00"));
    const approvalA = await askAndGrant(issued.admissionId, a.billId);
    const refused = await ipdError(voidBill(db, w.cashier, { idempotencyKey: key(), admissionId: issued.admissionId, billId: a.billId, approvalId: approvalA, reason: "x" },
      { now: ist("2026-03-12T11:30:00") }));
    expect(refused.code).toBe("refund_issued");
    expect((await billsOf(issued.admissionId))[0]!.voidedAt).toBeNull();

    // Granted but no voucher yet: the void cancels it, and billing's voucher guard refuses it afterwards.
    const pending = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await deposit(pending.admissionId, 900_000);
    await fitAndReady(pending.admissionId, "2026-03-12");
    const b = await settle(pending.admissionId, ist("2026-03-12T09:40:00"), { settlement: "refund_due" });
    const bRow = (await billsOf(pending.admissionId))[0]!;
    await approveRequest(db, w.billingManager, { approvalId: bRow.refundApprovalId!, note: "excess deposit" });
    const approvalB = await askAndGrant(pending.admissionId, b.billId);
    const out = await voidBill(db, w.cashier, { idempotencyKey: key(), admissionId: pending.admissionId, billId: b.billId, approvalId: approvalB, reason: "x" },
      { now: ist("2026-03-12T11:40:00") });
    expect(out.refundCancelled).toBe(true);
    await expect(issueRefundVoucher(db, w.billingManager, {
      kind: "advance_refund", patientId: pending.patientId, amountPaise: b.refundPaise, reasonClass: "genuine", reason: "excess deposit",
      approvalId: bRow.refundApprovalId!, method: "bank_transfer",
    }, ist("2026-03-12T12:00:00"))).rejects.toBeInstanceOf(BillingError);
  });

  it("4 — a self-approved void is refused (the approvals engine, and the void's own re-check)", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    const s = await settle(admissionId, ist("2026-03-12T09:30:00"));
    const self = await askBillVoid(db, w.billingManager, { admissionId, billId: s.billId, reason: "own mistake" });
    await expect(approveRequest(db, w.billingManager, { approvalId: self.approvalId, note: "self" })).rejects.toThrow();
    // Still pending: no void.
    expect((await ipdError(voidBill(db, w.billingManager, { idempotencyKey: key(), admissionId, billId: s.billId, approvalId: self.approvalId, reason: "own mistake" },
      { now: ist("2026-03-12T10:00:00") }))).code).toBe("void_needs_approval");
    // A grant written around the engine (decided by its own requester) is refused too.
    await db.update(approvals).set({ status: "granted", decidedBy: w.billingManager.id, decidedAt: ist("2026-03-12T10:01:00") }).where(eq(approvals.id, self.approvalId));
    expect((await ipdError(voidBill(db, w.billingManager, { idempotencyKey: key(), admissionId, billId: s.billId, approvalId: self.approvalId, reason: "own mistake" },
      { now: ist("2026-03-12T10:02:00") }))).code).toBe("void_needs_approval");
    expect((await liveOf(admissionId)).length).toBe(1);
  });

  it("5 — ⚖ the gate pass is never blocked when dues are recorded on the supplementary bill", async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    await settle(admissionId, ist("2026-03-12T09:30:00"));
    await postNightlyIpdCharges(db, ist("2026-03-14T00:05:00"));
    expect((await refusal(issueGatePass(db, w.cashier, { idempotencyKey: key(), admissionId }, { now: ist("2026-03-14T09:00:00") }))).code)
      .toBe("supplementary_unsettled");
    const supp = await prepareSupplementaryBill(db, w.cashier, admissionId, { now: ist("2026-03-14T09:05:00") });
    expect(supp.balancePaise).toBeGreaterThan(0);
    const out = await settleSupplementaryBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: supp.billVersion, patientPayablePaise: supp.patientPaise, settlement: "dues_recorded",
      payments: [], undertakingDocumentId: await undertaking(patientId),
    }, { now: ist("2026-03-14T09:10:00") });
    expect(out.duesPaise).toBe(supp.patientRoundedPaise);
    // No payment, no approval yet — the pass issues at once and says "dues recorded".
    const pass = await issueGatePass(db, w.cashier, { idempotencyKey: key(), admissionId }, { now: ist("2026-03-14T09:12:00") });
    expect([pass.state, pass.duesRecorded]).toEqual(["discharging", true]);
  });
});
