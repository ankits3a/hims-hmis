import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  approvals, creditNotes, events, invoices, ipdAdmissions, ipdChargeLines, ipdFinalBills, ipdPayerClaims, patientDocuments, refundCancellations,
  refundVouchers,
} from "../../../kernel/db/schema";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { BillingError, issueRefundVoucher } from "../../billing";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkDischargeWorld } from "../../../../test/helpers/ipd";
import { mkTpaDesk } from "../../../../test/helpers/ipd-payer";
import { coveredLineIds } from "../bill-cover";
import {
  IpdError, IpdRefusal, askBillVoid, askDuesApproval, cancelFit, confirmCharges, declareFit, issueGatePass, listBillDesk,
  postNightlyIpdCharges, prepareFinalBill, prepareSupplementaryBill, recordDuesApproval, recordPayerAuth, saveSummaryDraft, scanGatePass,
  settleFinalBill, settleSupplementaryBill, signSummary, takeDeposit, voidBill,
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

  // No guard or listener is registered anywhere in this file: a cancelled refund must fail closed on billing's own marker.
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
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
    // The first midnight after settlement posts nothing (review #762 RED 2): the exit time is not known yet.
    await postNightlyIpdCharges(db, ist("2026-03-13T00:05:00"));
    expect((await linesOf(admissionId)).length).toBe(atSettle);
    // Still in the bed through the 13th: the next midnight posts the 13th — into the supplementary running bill.
    await postNightlyIpdCharges(db, ist("2026-03-14T00:05:00"));
    expect((await linesOf(admissionId)).filter((l) => l.serviceDate === "2026-03-13").length).toBeGreaterThan(0);
    const desk = (await listBillDesk(db, w.cashier, { now: ist("2026-03-14T08:00:00") })).rows.find((r) => r.admissionId === admissionId);
    expect(desk?.exceptions).toEqual(expect.arrayContaining(["settled_not_exited", "supplementary_owed"]));

    // The gate pass asks for it first.
    const blocked = await refusal(issueGatePass(db, w.cashier, { idempotencyKey: key(), admissionId }, { now: ist("2026-03-14T09:00:00") }));
    expect(blocked.code).toBe("supplementary_unsettled");

    const supp = await prepareSupplementaryBill(db, w.cashier, admissionId, { now: ist("2026-03-14T09:05:00") });
    // The settlement day (stayed past 14:00 on it) and the night after: both land in the supplementary bill, once.
    expect(new Set(supp.lines.map((l) => l.serviceDate))).toEqual(new Set(["2026-03-12", "2026-03-13"]));
    const night = (await linesOf(admissionId)).filter((l) => l.serviceDate === "2026-03-12" || l.serviceDate === "2026-03-13");
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
    expect([f.coverByTime, s.coverByTime]).toEqual([false, false]);
    // Review 11: the settled event names the bill's kind and number.
    const settled = (await db.select().from(events).where(eq(events.name, "ipd.bill.settled")))
      .map((e) => e.payload as { finalBillId: string; kind: string; seq: number });
    expect(settled.map((p) => [p.finalBillId, p.kind, p.seq]).sort()).toEqual([[f.id, "final", 0], [s.id, "supplementary", 1]].sort());

    // A void takes the newest bill first; paid — the pass issues now.
    const approvalId = await askAndGrant(admissionId, f.id);
    const older = await ipdError(voidBill(db, w.cashier, { idempotencyKey: key(), admissionId, billId: f.id, approvalId, reason: "wrong class" }, { now: ist("2026-03-14T09:12:00") }));
    expect(older.code).toBe("void_newer_bill_first");
    const pass = await issueGatePass(db, w.cashier, { idempotencyKey: key(), admissionId }, { now: ist("2026-03-14T09:15:00") });
    expect(pass.duesRecorded).toBe(false);
  });

  it("2 — a voided final bill allows cancel_fit; re-settling composes ONE new bill; every money move is a document", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await deposit(admissionId, 100_000);
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
    // Review 10: the counter receipt paid on the voided bill becomes the stay's deposit — named on the void event, with
    // its own deposit event (as `takeDeposit` writes it).
    expect(before.paidPaise).toBeGreaterThan(0);
    expect(voided.adoptedReceiptIds).toHaveLength(1);
    const evs = await db.select().from(events);
    const voidEv = evs.find((e) => e.name === "ipd.bill.voided")!.payload as { adoptedReceiptIds: string[] };
    expect(voidEv.adoptedReceiptIds).toEqual(voided.adoptedReceiptIds);
    expect(evs.filter((e) => e.name === "ipd.deposit.taken" && (e.payload as { receiptId: string }).receiptId === voided.adoptedReceiptIds[0]))
      .toHaveLength(1);
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
    expect(live[0]!.depositAppliedPaise).toBe(Math.min(100_000 + before.paidPaise, newInv.netPayablePaise));
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
    // Billing's own marker, not a registered guard, refused it (nothing is registered in this file).
    expect((await db.select().from(refundCancellations).where(eq(refundCancellations.approvalId, bRow.refundApprovalId!))).length).toBe(1);
    expect(await db.select().from(refundVouchers).where(eq(refundVouchers.approvalId, bRow.refundApprovalId!))).toEqual([]);
  });

  it("4 — a self-approved void is refused (the approvals engine, and the void's own re-check)", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    const s = await settle(admissionId, ist("2026-03-12T09:30:00"));
    const self = await askBillVoid(db, w.billingManager, { admissionId, billId: s.billId, reason: "own mistake" });
    await expect(approveRequest(db, w.billingManager, { approvalId: self.approvalId, note: "self" })).rejects.toThrow();
    // Still pending: no void.
    const pending = await ipdError(voidBill(db, w.billingManager, { idempotencyKey: key(), admissionId, billId: s.billId, approvalId: self.approvalId, reason: "own mistake" },
      { now: ist("2026-03-12T10:00:00") }));
    expect([pending.code, pending.detail?.reason]).toEqual(["void_needs_approval", "not_granted"]);
    // A grant written around the engine (decided by its own requester) is refused too.
    // Review 12: decidedBy = requester written directly — the void's OWN check stops it (`detail.reason`).
    await db.update(approvals).set({ status: "granted", decidedBy: w.billingManager.id, decidedAt: ist("2026-03-12T10:01:00") }).where(eq(approvals.id, self.approvalId));
    const own = await ipdError(voidBill(db, w.billingManager, { idempotencyKey: key(), admissionId, billId: s.billId, approvalId: self.approvalId, reason: "own mistake" },
      { now: ist("2026-03-12T10:02:00") }));
    expect([own.code, own.detail?.reason]).toEqual(["void_needs_approval", "self_approved"]);
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

  // ═══════════════════════════ review of a0d85914 (#775) ═══════════════════════════

  it("R1a — settled before 14:00, left after 14:00 the same day: the settlement day is charged, on the supplementary bill", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    await settle(admissionId, ist("2026-03-12T09:30:00"));
    expect((await linesOf(admissionId)).filter((l) => l.serviceDate === "2026-03-12")).toEqual([]);
    expect((await refusal(issueGatePass(db, w.cashier, { idempotencyKey: key(), admissionId }, { now: ist("2026-03-12T15:00:00") }))).code)
      .toBe("supplementary_unsettled");
    const supp = await prepareSupplementaryBill(db, w.cashier, admissionId, { now: ist("2026-03-12T15:05:00") });
    expect(new Set(supp.lines.map((l) => l.serviceDate))).toEqual(new Set(["2026-03-12"]));
    expect(supp.lines.some((l) => l.component === "room")).toBe(true);
  });

  it("R1b — settled before 14:00, stayed the night, left before 14:00 next day: the settlement day is charged, the exit day is not", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    await settle(admissionId, ist("2026-03-12T09:30:00"));
    await postNightlyIpdCharges(db, ist("2026-03-13T00:05:00"));
    const supp = await prepareSupplementaryBill(db, w.cashier, admissionId, { now: ist("2026-03-13T11:00:00") });
    expect(new Set(supp.lines.map((l) => l.serviceDate))).toEqual(new Set(["2026-03-12"]));
    // Prepared twice: the dedupe posts nothing again.
    const again = await prepareSupplementaryBill(db, w.cashier, admissionId, { now: ist("2026-03-13T11:01:00") });
    expect(again.lines.map((l) => l.lineId).sort()).toEqual(supp.lines.map((l) => l.lineId).sort());
  });

  it("R2 — ⚖ unbilled charges after settlement and no payment: the gate pass issues by recording the dues at the gate", async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    await settle(admissionId, ist("2026-03-12T09:30:00"));
    await postNightlyIpdCharges(db, ist("2026-03-14T00:05:00"));
    // Without the undertaking: the same rule as the final bill's dues (never stricter).
    expect((await refusal(issueGatePass(db, w.duty, { idempotencyKey: key(), admissionId }, { now: ist("2026-03-14T09:00:00") }))).code)
      .toBe("supplementary_unsettled");
    // The duty manager at night: no billing permission, no payment — the undertaking records the dues and the pass issues.
    const pass = await issueGatePass(db, w.duty, { idempotencyKey: key(), admissionId, undertakingDocumentId: await undertaking(patientId) },
      { now: ist("2026-03-14T09:01:00") });
    expect(pass.state).toBe("discharging");
    const supp = (await liveOf(admissionId)).find((b) => b.seq === 1)!;
    expect([supp.kind, supp.settlement, supp.paidPaise, supp.duesPaise > 0, supp.duesApprovalId]).toEqual(["supplementary", "dues_recorded", 0, true, null]);
  });

  it("R3 — ⚖ a void is refused while an issued pass is not yet scanned, and allowed after the scan", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    const s = await settle(admissionId, ist("2026-03-12T09:30:00"));
    const pass = await issueGatePass(db, w.cashier, { idempotencyKey: key(), admissionId }, { now: ist("2026-03-12T09:35:00") });
    const approvalId = await askAndGrant(admissionId, s.billId);
    const live = await ipdError(voidBill(db, w.cashier, { idempotencyKey: key(), admissionId, billId: s.billId, approvalId, reason: "x" }, { now: ist("2026-03-12T09:40:00") }));
    expect(live.code).toBe("gate_pass_live");
    await scanGatePass(db, w.duty, { idempotencyKey: key(), gatePassCode: pass.code, gateId: newId(), scannedAt: ist("2026-03-12T09:50:00").toISOString() }, { now: ist("2026-03-12T09:50:00") });
    await voidBill(db, w.cashier, { idempotencyKey: key(), admissionId, billId: s.billId, approvalId, reason: "x" }, { now: ist("2026-03-12T10:00:00") });
    expect(await liveOf(admissionId)).toEqual([]);
    // After the exit the bill settles again (the cash paid on the voided bill is now the stay's deposit: nothing to pay).
    await settle(admissionId, ist("2026-03-12T10:30:00"), { settlement: "refund_due" });
    expect((await liveOf(admissionId)).length).toBe(1);
  });

  it("R4 — a bill whose claim the payer settled is refused before any write", async () => {
    const tpa = await mkTpaDesk(db);
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await recordPayerAuth(db, tpa, {
      idempotencyKey: key(), admissionId, payerKind: "insurance_cashless", entry: "initial", status: "approved", provisionalCashlessSigned: true,
      approvedAmountPaise: 10_000_000, preAuthNumber: "PA-FAKE-9", coPayBp: 1000,
    }, { now: ist("2026-03-10T11:00:00") });
    await fitAndReady(admissionId, "2026-03-12");
    const s = await settle(admissionId, ist("2026-03-12T09:30:00"));
    await db.update(ipdPayerClaims).set({ status: "settled" }).where(eq(ipdPayerClaims.finalBillId, s.billId));
    const approvalId = await askAndGrant(admissionId, s.billId);
    const refused = await ipdError(voidBill(db, w.cashier, { idempotencyKey: key(), admissionId, billId: s.billId, approvalId, reason: "x" }, { now: ist("2026-03-12T10:00:00") }));
    expect(refused.code).toBe("payer_claim_settled");
    const row = (await billsOf(admissionId))[0]!;
    expect(row.voidedAt).toBeNull();
    expect(row.invoiceId === null ? [] : await db.select().from(creditNotes).where(eq(creditNotes.invoiceId, row.invoiceId))).toEqual([]);
  });

  it("R5 — one dues approval attaches to one bill, and never the requester's own", async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    const b = await prepareFinalBill(db, w.cashier, admissionId, { now: ist("2026-03-12T09:20:00") });
    await settleFinalBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: b.billVersion, patientPayablePaise: b.patientPaise, settlement: "dues_recorded", payments: [],
      undertakingDocumentId: await undertaking(patientId),
    }, { now: ist("2026-03-12T09:30:00") });
    await postNightlyIpdCharges(db, ist("2026-03-14T00:05:00"));
    await issueGatePass(db, w.duty, { idempotencyKey: key(), admissionId, undertakingDocumentId: await undertaking(patientId) }, { now: ist("2026-03-14T09:00:00") });
    expect((await liveOf(admissionId)).filter((x) => x.duesPaise > 0)).toHaveLength(2);
    // Self-approval written around the engine: refused.
    const self = await askDuesApproval(db, w.cashier, { admissionId, amountPaise: 100_000_000, note: "both bills" });
    await db.update(approvals).set({ status: "granted", decidedBy: w.cashier.id, decidedAt: ist("2026-03-14T09:05:00") }).where(eq(approvals.id, self.approvalId));
    expect((await refusal(recordDuesApproval(db, w.cashier, { admissionId, approvalId: self.approvalId }, { now: ist("2026-03-14T09:06:00") }))).code)
      .toBe("dues_need_approval");
    // A real approval covers one bill only: the second attach is refused.
    const asked = await askDuesApproval(db, w.cashier, { admissionId, amountPaise: 100_000_000, note: "both bills" });
    await approveRequest(db, w.billingManager, { approvalId: asked.approvalId, note: "undertaking on file" });
    await recordDuesApproval(db, w.cashier, { admissionId, approvalId: asked.approvalId }, { now: ist("2026-03-14T09:10:00") });
    expect((await refusal(recordDuesApproval(db, w.cashier, { admissionId, approvalId: asked.approvalId }, { now: ist("2026-03-14T09:11:00") }))).code)
      .toBe("dues_need_approval");
    expect((await liveOf(admissionId)).filter((x) => x.duesApprovalId === asked.approvalId)).toHaveLength(1);
  });

  it("R6 — a supplementary bill is refused outside the discharge and ended states", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    await settle(admissionId, ist("2026-03-12T09:30:00"));
    await db.update(ipdAdmissions).set({ state: "admitted" }).where(eq(ipdAdmissions.id, admissionId));
    const r = await refusal(settleSupplementaryBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: 0, patientPayablePaise: 0, settlement: "paid", payments: [{ tender: "cash", amountPaise: 100 }],
    }, { now: ist("2026-03-14T09:00:00") }));
    expect(r.code).toBe("admission_wrong_state");
  });

  it("R7 — only a bill flagged as pre-migration covers by posting time; a new bill covers exactly its list", () => {
    const at = ist("2026-03-12T09:30:00");
    const lines = [{ id: "L1", postedAt: ist("2026-03-11T00:05:00") }, { id: "L2", postedAt: ist("2026-03-12T09:00:00") }];
    const bill = { lineIds: ["L1"], settledAt: at, coverByTime: false } as unknown as Parameters<typeof coveredLineIds>[0][number];
    expect([...coveredLineIds([bill], lines)]).toEqual(["L1"]);
    expect([...coveredLineIds([{ ...bill, lineIds: [], coverByTime: true }], lines)].sort()).toEqual(["L1", "L2"]);
    expect([...coveredLineIds([{ ...bill, lineIds: [] }], lines)]).toEqual([]);
  });

  it("R13a — two voids at once: exactly one wins", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    const s = await settle(admissionId, ist("2026-03-12T09:30:00"));
    const approvalId = await askAndGrant(admissionId, s.billId);
    const go = () => voidBill(db, w.cashier, { idempotencyKey: key(), admissionId, billId: s.billId, approvalId, reason: "x" }, { now: ist("2026-03-12T10:00:00") });
    const out = await Promise.allSettled([go(), go()]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const lost = out.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as IpdError).code).toBe("bill_already_voided");
    expect((await db.select().from(creditNotes))).toHaveLength(1);
  });

  it("R13b — a void racing the refund voucher: never a refund paid on a voided bill", async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await deposit(admissionId, 900_000);
    await fitAndReady(admissionId, "2026-03-12");
    const s = await settle(admissionId, ist("2026-03-12T09:30:00"), { settlement: "refund_due" });
    const row = (await billsOf(admissionId))[0]!;
    await approveRequest(db, w.billingManager, { approvalId: row.refundApprovalId!, note: "excess" });
    const approvalId = await askAndGrant(admissionId, s.billId);
    const out = await Promise.allSettled([
      voidBill(db, w.cashier, { idempotencyKey: key(), admissionId, billId: s.billId, approvalId, reason: "x" }, { now: ist("2026-03-12T10:00:00") }),
      issueRefundVoucher(db, w.billingManager, {
        kind: "advance_refund", patientId, amountPaise: s.refundPaise, reasonClass: "genuine", reason: "excess", approvalId: row.refundApprovalId!, method: "bank_transfer",
      }, ist("2026-03-12T10:00:00")),
    ]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const voided = (await billsOf(admissionId))[0]!.voidedAt !== null;
    const vouchers = await db.select().from(refundVouchers).where(eq(refundVouchers.approvalId, row.refundApprovalId!));
    expect(voided ? vouchers.length : 1 - vouchers.length).toBe(0);
  });

  it("R13c — a void racing a re-settle: at most one live final bill, and a new one only after the void", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fitAndReady(admissionId, "2026-03-12");
    const s = await settle(admissionId, ist("2026-03-12T09:30:00"));
    const approvalId = await askAndGrant(admissionId, s.billId);
    const read = await prepareFinalBill(db, w.cashier, admissionId, { now: ist("2026-03-12T09:55:00") });
    const out = await Promise.allSettled([
      voidBill(db, w.cashier, { idempotencyKey: key(), admissionId, billId: s.billId, approvalId, reason: "x" }, { now: ist("2026-03-12T10:00:00") }),
      settleFinalBill(db, w.cashier, {
        idempotencyKey: key(), admissionId, billVersion: read.billVersion, patientPayablePaise: read.patientPaise, settlement: "paid",
        payments: read.patientRoundedPaise > 0 ? [{ tender: "cash", amountPaise: read.patientRoundedPaise }] : [],
      }, { now: ist("2026-03-12T10:00:01") }),
    ]);
    expect(out[0].status).toBe("fulfilled");
    const live = await liveOf(admissionId);
    expect(live.length).toBeLessThanOrEqual(1);
    if (out[1].status === "fulfilled") expect(live.map((b) => b.id)).toEqual([out[1].value.billId]);
    else expect(live).toEqual([]);
  });
});
