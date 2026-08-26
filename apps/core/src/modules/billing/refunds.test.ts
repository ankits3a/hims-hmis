import { eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantCreditExtend, issueDuesInvoice, issuePaidInvoice, mkBillingManager, mkCashier, openSessionFor,
  seedBillingBase,
} from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { assignRole } from "../../kernel/auth/permissions";
import { SodViolationError } from "../../kernel/auth/sod";
import { approveRequest } from "../../kernel/approvals/decisions";
import { requestApproval } from "../../kernel/approvals/requests";
import { withTx } from "../../kernel/db/client";
import { approvals, events, opdEncounters, refundVouchers, registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { issueCreditNote } from "./credit-notes";
import { getInvoice, outstandingOf } from "./invoices";
import { advanceOf, recordReceipt } from "./receipts";
import { beginClose } from "./sessions";
import {
  guardFlagsFor, issueRefundVoucher, payRefundVoucher, REFUND_APPROVAL_SUBJECT, REFUND_APPROVAL_TYPE,
  requestRefund,
} from "./refunds";
import type { GuardFlag, RefundMethod } from "./refunds";
import type { Pool } from "pg";
import type { Db } from "../../kernel/db/client";

/**
 * Plan 08 T8, D6 — refund vouchers: the four guards, approval-gated always, refund-to-payer.
 *
 * THE SEEDED FIXTURE every number below is derived from (test/helpers/billing.ts
 * `seedBillingBase`):
 *   · tariff: OPD-CONSULT-NEW in category "consultation", EXEMPT healthcare, priced 50000 paise;
 *     GENERIC-SERVICE in category "pharmacy", TAXABLE at 1200 bps, priced 50000 paise.
 *   · billing_config: refundBankAbovePaise 1_000_000 (Rs 10,000 — the cash refund ceiling) ·
 *     creditCapPaise 500_000 · outstandingCapPaise 2_000_000 mode "warn" · cash warn 15_000_000 /
 *     block 20_000_000 / PAN 5_000_000 · series prefix "RFV" for vouchers.
 *
 * THE MONEY, from the shipped engine (modules/tariff/money.ts):
 *   divHalfUp(n, d) = floor((2n + d) / 2d) · taxHead(base, rateBps) = divHalfUp(base·rateBps, 20000)
 *   roundTotalToRupee(t) = divHalfUp(t, 100)·100    (§170, applied ONCE per document)
 *
 *   OPD-CONSULT-NEW qty 1 — EXEMPT, so heads are 0 and there is nothing to round:
 *     gross 50000, base 50000, cgst 0, sgst 0, raw total 50000, rounding 0, NET PAYABLE 50000.
 *     qty 5: gross 250000, base 250000, raw 250000, NET PAYABLE 250000.
 *   GENERIC-SERVICE qty 1 — taxable 1200 bps:
 *     taxHead(50000, 1200) = divHalfUp(60,000,000, 20,000) = floor((120,000,000 + 20,000)/40,000)
 *                          = floor(3000.5) = 3000 per head.
 *     raw 50000 + 3000 + 3000 = 56000; roundTotalToRupee(56000) = floor((112,000 + 100)/200)·100
 *                          = floor(560.5)·100 = 56000, rounding 0, NET PAYABLE 56000.
 *   A FULL credit note over a whole line credits the line's own stored money (T2's `creditShare`
 *   with p = 0 and k = qty): for OPD-CONSULT-NEW qty 5 crediting qty 1,
 *     gross divHalfUp(250000·1, 5) - divHalfUp(0, 5) = 50000 - 0 = 50000, base 50000, heads 0,
 *     raw 50000, rounding 0, net 50000.
 *
 * DISCLOSED SHAPING: `opd_encounters` rows are inserted DIRECTLY (the T5 precedent — opening a
 * real visit needs the whole Class-A workflow activation, which proves nothing about refunds).
 * Every invoice, receipt, allocation, credit note and voucher below goes through the shipped
 * write paths.
 */
describe("refund vouchers: the four guards, approval-gated always, refund-to-payer (D6)", () => {
  let db: Db;
  let pool: Pool;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;

  // The same fixed instant T5/T6/T7 use: 2026-08-19T06:00:00Z + 5:30 = 11:30 IST -> IST day
  // "2026-08-19", fiscal year 2026-27 rendered "26-27", so the first voucher of a fresh database
  // is "RFV/26-27/000001".
  const NOW = new Date("2026-08-19T06:00:00Z");
  const SERVICE_DAY = "2026-08-19";
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const PAYEE = { payeeName: "Asha Devi", payeeIdType: "aadhaar", payeeIdRef: "XXXX-XXXX-1234" };

  beforeAll(async () => {
    ({ db, pool, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    await grantCreditExtend(db); // every dues fixture below issues through D2's credit lane
  });

  async function mkTestPatient(name = "Refund Patient"): Promise<string> {
    const actor: Actor = { type: "user", id: "refund-clerk" };
    const { patient } = await withTx(db, (tx) => registerPatient(tx, actor, { name, sex: "female", ageYears: 35 }));
    return patient.id;
  }

  async function cashierWithSession(username: string, floatPaise = 100_000): Promise<{ id: string; actor: Actor }> {
    const cashier = await mkCashier(db, username);
    await openSessionFor(db, cashier, floatPaise);
    return cashier;
  }

  /** See the shaping disclosure in this file's header. */
  async function shapeEncounter(
    patientId: string,
    over: { visitType?: string; status?: string; consultCompletedAt?: Date | null } = {},
  ): Promise<string> {
    const id = newId();
    await db.insert(opdEncounters).values({
      id, visitNo: `VFX-${id}`, patientId, workflowInstanceId: newId(), serviceDate: SERVICE_DAY,
      visitType: over.visitType ?? "new",
      status: over.status ?? "completed",
      consultCompletedAt: over.consultCompletedAt === undefined ? NOW : over.consultCompletedAt,
      intendedPayer: "self", openedBy: "shaped", updatedBy: "shaped",
    });
    return id;
  }

  /** A GRANTED `billing_refund` approval bound to a subject, patient and exact amount. */
  async function grantedRefundApproval(input: {
    subjectId: string; patientId: string; amountPaise: number; requester: Actor; approver: Actor;
  }): Promise<string> {
    const filed = await withTx(db, (tx) =>
      requestApproval(tx, input.requester, {
        typeKey: REFUND_APPROVAL_TYPE,
        subject: { type: REFUND_APPROVAL_SUBJECT, id: input.subjectId },
        patientId: input.patientId,
        amountPaise: input.amountPaise,
        requestNote: "refund asked at the counter",
      }),
    );
    await approveRequest(db, input.approver, { approvalId: filed.approvalId, note: "approved for the test" });
    return filed.approvalId;
  }

  /** A credit note covering `qty` units of the invoice's only line — the paper a refund draws on. */
  async function creditNoteOver(actor: Actor, invoiceId: string, qty: number): Promise<string> {
    const found = await getInvoice(db, invoiceId);
    const line = found!.lines[0]!;
    const cn = await issueCreditNote(
      db, actor,
      { kind: "refund", invoiceId, reason: "goods returned unused", lines: [{ invoiceLineId: line.id, qty }] },
      NOW,
    );
    return cn.creditNoteId;
  }

  /**
   * The T7 `codeOf` shape, with one deliberate difference: the "it returned instead of refusing"
   * case is reported through `expect` rather than through a bare `throw`. Tripwire 21 asks a
   * mutant kill to quote EXPECTED vs RECEIVED, and a wrong implementation of a guard fails by
   * ACCEPTING — so this is exactly where the pair has to come from. Do not simplify it back to a
   * bare throw: it would take the diff out of every refusal assertion in this file.
   */
  const codeOf = async (run: Promise<unknown>): Promise<{ code: unknown; detail: unknown }> => {
    let refused = false;
    let returned: unknown = null;
    let err: { code?: unknown; detail?: unknown } = {};
    try {
      returned = (await run) ?? null;
    } catch (e) {
      refused = true;
      err = e as { code?: unknown; detail?: unknown };
    }
    expect({ refused, returned }).toEqual({ refused: true, returned: null });
    return { code: err.code, detail: err.detail };
  };

  const advanceOfCash = async (
    cashier: { actor: Actor }, patientId: string, amountPaise: number,
  ): Promise<{ receiptId: string }> =>
    recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise }] }, NOW);

  // ===========================================================================================
  // 1-2 — approval-gated ALWAYS: the request files the gate, the issue checks it on execute
  // ===========================================================================================

  test("requestRefund files a billing_refund approval carrying the guard flags, the patient and the money — and writes no voucher", async () => {
    const cashier = await cashierWithSession("cashier-request");
    const patientId = await mkTestPatient();
    const encounterId = await shapeEncounter(patientId); // completed + consultCompletedAt (guards 2+3)
    const invoice = await issuePaidInvoice(db, cashier, {
      patientId, serviceId: base.consultNewServiceId, encounterId,
    });
    const creditNoteId = await creditNoteOver(cashier.actor, invoice.invoiceId, 1);

    const asked = await requestRefund(db, cashier.actor, {
      kind: "invoice_refund", creditNoteId, amountPaise: 50_000,
      reasonClass: "genuine", reason: "patient discharged before the service was rendered",
    });

    expect(asked).toMatchObject({
      patientId, invoiceId: invoice.invoiceId, creditNoteId, amountPaise: 50_000,
      guardFlags: ["terminal_encounter", "delivered_line"],
    });

    const [row] = await db.select().from(approvals).where(eq(approvals.id, asked.approvalId));
    expect(row).toBeDefined();
    expect(row!).toMatchObject({
      typeKey: "billing_refund",
      subjectType: REFUND_APPROVAL_SUBJECT,
      subjectId: creditNoteId,
      patientId,
      encounterId,
      amountPaise: 50_000,
      requesterId: cashier.id, // the cashier asks; a billing_manager decides (kernel SoD, test 13)
      status: "pending",
      cumulativePatientPaise: 50_000, // C-12 aggregation, free from the kernel
    });
    // Guards 2+3 ride the request so the approver sees WHY this one is escalated.
    expect(row!.requestNote).toContain("terminal_encounter");
    expect(row!.requestNote).toContain("delivered_line");

    expect(await db.select().from(refundVouchers)).toHaveLength(0); // a request is a question
  });

  test("issueRefundVoucher is check-on-execute: refused while the approval is pending, and stores the guard flags once granted", async () => {
    const cashier = await cashierWithSession("cashier-issue");
    const manager = await mkBillingManager(db, "manager-issue");
    const patientId = await mkTestPatient();
    const encounterId = await shapeEncounter(patientId);
    const invoice = await issuePaidInvoice(db, cashier, {
      patientId, serviceId: base.consultNewServiceId, encounterId,
    });
    const creditNoteId = await creditNoteOver(cashier.actor, invoice.invoiceId, 1);

    const asked = await requestRefund(db, cashier.actor, {
      kind: "invoice_refund", creditNoteId, amountPaise: 50_000,
      reasonClass: "mistake", reason: "billed the wrong patient",
    });
    const issue = {
      kind: "invoice_refund", creditNoteId, amountPaise: 50_000,
      reasonClass: "mistake", reason: "billed the wrong patient",
      approvalId: asked.approvalId, method: "cash",
    } as const;

    expect(await codeOf(issueRefundVoucher(db, cashier.actor, issue, NOW))).toMatchObject({
      code: "approval_not_granted",
    });
    expect(await db.select().from(refundVouchers)).toHaveLength(0);

    await approveRequest(db, manager.actor, { approvalId: asked.approvalId, note: "verified against the credit note" });
    const voucher = await issueRefundVoucher(db, cashier.actor, issue, NOW);

    expect(voucher).toMatchObject({
      voucherNo: "RFV/26-27/000001", patientId, kind: "invoice_refund", invoiceId: invoice.invoiceId,
      creditNoteId, amountPaise: 50_000, method: "cash", status: "issued",
      guardFlags: ["terminal_encounter", "delivered_line"],
    });

    const [stored] = await db.select().from(refundVouchers).where(eq(refundVouchers.id, voucher.voucherId));
    expect(stored!).toMatchObject({
      status: "issued", approvalId: asked.approvalId, reasonClass: "mistake",
      reason: "billed the wrong patient", requestedBy: cashier.id,
      payeeName: null, payeeIdType: null, payeeIdRef: null, paidAt: null, cashierSessionId: null,
    });
    expect(stored!.guardFlags).toEqual(["terminal_encounter", "delivered_line"]);

    const emitted = await db.select().from(events).where(eq(events.name, "refund_voucher.issued"));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!).toMatchObject({ patientId, encounterId, correlationId: invoice.invoiceId, module: "billing" });
    expect(emitted[0]!.payload).toMatchObject({
      voucherId: voucher.voucherId, voucherNo: "RFV/26-27/000001", kind: "invoice_refund", amountPaise: 50_000,
    });
  });

  // ===========================================================================================
  // 3-4 — GUARD 1, structural (K27). The cap is the money the hospital ACTUALLY TOOK, never the
  // invoice's net: a partially-paid bill can only refund what was paid on it.
  // ===========================================================================================

  test("guard 1: on a genuinely partially-paid invoice, vouchers are capped by the money RECEIVED — not by the net", async () => {
    const cashier = await cashierWithSession("cashier-guard1");
    const manager = await mkBillingManager(db, "manager-guard1");
    const patientId = await mkTestPatient();

    // A DUES bill: net payable 50000, of which only 30000 was ever paid (D2's credit lane carries
    // the 20000 remainder). allocations 30000 < net 50000 — this is what makes the fixture able to
    // tell "capped at received" from "capped at net" apart at all.
    const invoice = await issueDuesInvoice(db, cashier, {
      patientId, serviceId: base.consultNewServiceId, receiptPaise: 30_000,
    });
    expect(await outstandingOf(db, invoice.invoiceId)).toBe(20_000);

    // The full credit note zeroes the receivable: credited 50000 + allocated 30000 = 80000 against
    // a 50000 net, so 30000 is genuinely refundable — exactly the money that came in.
    const creditNoteId = await creditNoteOver(cashier.actor, invoice.invoiceId, 1);

    const over = {
      kind: "invoice_refund", creditNoteId, amountPaise: 40_000,
      reasonClass: "genuine", reason: "the whole bill is being refunded",
    } as const;
    const overApproval = await grantedRefundApproval({
      subjectId: creditNoteId, patientId, amountPaise: 40_000, requester: cashier.actor, approver: manager.actor,
    });
    expect(
      await codeOf(issueRefundVoucher(db, cashier.actor, { ...over, approvalId: overApproval, method: "cash" }, NOW)),
    ).toMatchObject({
      code: "refund_exceeds_received",
      detail: { askedPaise: 40_000, drawnPaise: 0, receivedPaise: 30_000, surplusPaise: 30_000, capPaise: 30_000 },
    });
    expect(await db.select().from(refundVouchers)).toHaveLength(0);

    // Exactly the money received passes …
    const okApproval = await grantedRefundApproval({
      subjectId: creditNoteId, patientId, amountPaise: 30_000, requester: cashier.actor, approver: manager.actor,
    });
    const voucher = await issueRefundVoucher(
      db, cashier.actor,
      { ...over, amountPaise: 30_000, approvalId: okApproval, method: "cash" },
      NOW,
    );
    expect(voucher.amountPaise).toBe(30_000);

    // … and the cap is CUMULATIVE: one more paisa is one paisa the hospital never took.
    const moreApproval = await grantedRefundApproval({
      subjectId: creditNoteId, patientId, amountPaise: 1, requester: cashier.actor, approver: manager.actor,
    });
    expect(
      await codeOf(issueRefundVoucher(db, cashier.actor, { ...over, amountPaise: 1, approvalId: moreApproval, method: "cash" }, NOW)),
    ).toMatchObject({ code: "refund_exceeds_received", detail: { drawnPaise: 30_000, capPaise: 30_000 } });
    expect(await db.select().from(refundVouchers)).toHaveLength(1);
  });

  test("guard 1: a patient who still owes money is owed nothing back — the credit note freed no surplus", async () => {
    const cashier = await cashierWithSession("cashier-surplus");
    const manager = await mkBillingManager(db, "manager-surplus");
    const patientId = await mkTestPatient();

    // net 250000 (qty 5 x 50000, exempt), paid 150000, so 100000 is still owed. Crediting ONE unit
    // (50000) leaves 50000 outstanding: credited 50000 + allocated 150000 = 200000 < 250000, so the
    // surplus is zero even though 150000 was received.
    const invoice = await issueDuesInvoice(db, cashier, {
      patientId, serviceId: base.consultNewServiceId, qty: 5, receiptPaise: 150_000,
    });
    expect(await outstandingOf(db, invoice.invoiceId)).toBe(100_000);
    const creditNoteId = await creditNoteOver(cashier.actor, invoice.invoiceId, 1);
    expect(await outstandingOf(db, invoice.invoiceId)).toBe(50_000);

    const approvalId = await grantedRefundApproval({
      subjectId: creditNoteId, patientId, amountPaise: 50_000, requester: cashier.actor, approver: manager.actor,
    });
    expect(
      await codeOf(
        issueRefundVoucher(
          db, cashier.actor,
          {
            kind: "invoice_refund", creditNoteId, amountPaise: 50_000, reasonClass: "genuine",
            reason: "one unit returned", approvalId, method: "cash",
          },
          NOW,
        ),
      ),
    ).toMatchObject({
      code: "refund_exceeds_received",
      detail: { askedPaise: 50_000, receivedPaise: 150_000, surplusPaise: 0, capPaise: 0 },
    });
    expect(await db.select().from(refundVouchers)).toHaveLength(0);
  });

  // ===========================================================================================
  // 5-7 — GUARD 1, advance lane: D1's "the advance balance is never negative", enforced
  // ===========================================================================================

  test("an advance refund draws on the patient's advance balance and cannot drive it negative", async () => {
    const cashier = await cashierWithSession("cashier-advance");
    const manager = await mkBillingManager(db, "manager-advance");
    const patientId = await mkTestPatient();

    await advanceOfCash(cashier, patientId, 10_000);
    expect(await advanceOf(db, patientId)).toBe(10_000);

    const ask = (amountPaise: number, approvalId: string) => ({
      kind: "advance_refund", patientId, amountPaise, reasonClass: "genuine",
      reason: "the patient is leaving and wants the balance back", approvalId, method: "cash",
    } as const);

    const tooMuch = await grantedRefundApproval({
      subjectId: patientId, patientId, amountPaise: 12_000, requester: cashier.actor, approver: manager.actor,
    });
    expect(await codeOf(issueRefundVoucher(db, cashier.actor, ask(12_000, tooMuch), NOW))).toMatchObject({
      code: "refund_exceeds_advance", detail: { askedPaise: 12_000, advancePaise: 10_000 },
    });

    const exact = await grantedRefundApproval({
      subjectId: patientId, patientId, amountPaise: 10_000, requester: cashier.actor, approver: manager.actor,
    });
    const voucher = await issueRefundVoucher(db, cashier.actor, ask(10_000, exact), NOW);
    expect(voucher).toMatchObject({ kind: "advance_refund", amountPaise: 10_000, invoiceId: null, creditNoteId: null });
    // `advanceOf` (T6) subtracts every advance-refund voucher issued or paid — the balance is spent
    // the moment the voucher exists, not when the cash leaves.
    expect(await advanceOf(db, patientId)).toBe(0);

    const onePaisa = await grantedRefundApproval({
      subjectId: patientId, patientId, amountPaise: 1, requester: cashier.actor, approver: manager.actor,
    });
    expect(await codeOf(issueRefundVoucher(db, cashier.actor, ask(1, onePaisa), NOW))).toMatchObject({
      code: "refund_exceeds_advance", detail: { askedPaise: 1, advancePaise: 0 },
    });
    expect(await db.select().from(refundVouchers)).toHaveLength(1);
  });

  test("race (K30) — two concurrent advance refunds of 6000 against a 10000 balance: exactly one refund_exceeds_advance", async () => {
    const cashier = await cashierWithSession("cashier-race");
    const manager = await mkBillingManager(db, "manager-race");
    const patientId = await mkTestPatient();

    await advanceOfCash(cashier, patientId, 10_000);
    const first = await grantedRefundApproval({
      subjectId: patientId, patientId, amountPaise: 6_000, requester: cashier.actor, approver: manager.actor,
    });
    const second = await grantedRefundApproval({
      subjectId: patientId, patientId, amountPaise: 6_000, requester: cashier.actor, approver: manager.actor,
    });
    const ask = (approvalId: string) => ({
      kind: "advance_refund", patientId, amountPaise: 6_000, reasonClass: "genuine",
      reason: "balance returned", approvalId, method: "cash",
    } as const);

    // 6000 + 6000 = 12000 against a 10000 balance. The single ordered lock
    // (`select id from receipts where patient_id = $1 order by id for update`) is what makes the
    // second reader see the first voucher: without it both read 10000 and both pass.
    const results = await Promise.allSettled([
      issueRefundVoucher(db, cashier.actor, ask(first), NOW),
      issueRefundVoucher(db, cashier.actor, ask(second), NOW),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    expect(loser).toBeDefined();
    expect(loser!.reason.code).toBe("refund_exceeds_advance");
    expect(loser!.reason.detail).toMatchObject({ askedPaise: 6_000, advancePaise: 4_000 });

    expect(await db.select().from(refundVouchers)).toHaveLength(1);
    expect(await advanceOf(db, patientId)).toBe(4_000);
  });

  test("race (K30), the lock leg — the ordered receipt FOR UPDATE is REAL: an advance refund is still pending while an outside session holds those rows", async () => {
    const cashier = await cashierWithSession("cashier-lock");
    const manager = await mkBillingManager(db, "manager-lock");
    const patientId = await mkTestPatient();
    await advanceOfCash(cashier, patientId, 10_000);
    const approvalId = await grantedRefundApproval({
      subjectId: patientId, patientId, amountPaise: 6_000, requester: cashier.actor, approver: manager.actor,
    });

    // §3.28/§3.39: the observation point must be OUTSIDE the target's own write path, and the LOCK
    // MODE is load-bearing.
    //   · The outside holder takes FOR NO KEY UPDATE on the patient's receipt rows. That mode
    //     conflicts with FOR UPDATE and with FOR SHARE / FOR NO KEY UPDATE — and NOT with
    //     FOR KEY SHARE, the mode an FK check would take.
    //   · `issueRefundVoucher` inserts into `refund_vouchers`, whose only FK is to `patients`
    //     (ruling R5) — nothing it writes references `receipts`, so no implicit FOR KEY SHARE on a
    //     receipt row exists to be blocked here. `advanceOf`'s reads are plain SELECTs and never
    //     wait. `nextDocNo` moves a `document_series` row and `appendEvent` inserts into `events`,
    //     neither of which this holder touches.
    //   · So the ONLY lock in the implementation that can wait on this hold is the single ordered
    //     `select id from receipts where patient_id = $1 order by id for update` itself.
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from receipts where patient_id = $1 order by id for no key update", [patientId]);

      const p = issueRefundVoucher(
        db, cashier.actor,
        {
          kind: "advance_refund", patientId, amountPaise: 6_000, reasonClass: "genuine",
          reason: "balance returned", approvalId, method: "cash",
        },
        NOW,
      );
      p.catch(() => {}); // no unhandled rejection while unobserved
      const state = await Promise.race([p.then(() => "settled", () => "settled"), delay(400).then(() => "pending")]);
      expect(state).toBe("pending");

      await holder.query("commit");
      const done = await p;
      expect(done.amountPaise).toBe(6_000);
    } finally {
      holder.release();
    }
    expect(await advanceOf(db, patientId)).toBe(4_000);
  });

  // ===========================================================================================
  // 8 — GUARDS 2+3 (K29): flags, never blocks
  // ===========================================================================================

  test("guards 2+3 are computed flags: terminal encounter and delivered consult line, each independently observable", async () => {
    const cashier = await cashierWithSession("cashier-flags");
    const patientId = await mkTestPatient();

    // (a) a completed encounter whose consult fee is what is being refunded: BOTH flags.
    const terminal = await shapeEncounter(patientId);
    const feeInvoice = await issuePaidInvoice(db, cashier, {
      patientId, serviceId: base.consultNewServiceId, encounterId: terminal,
    });
    const feeCredit = await creditNoteOver(cashier.actor, feeInvoice.invoiceId, 1);
    expect(await guardFlagsFor(db, { creditNoteId: feeCredit })).toEqual<GuardFlag[]>([
      "terminal_encounter", "delivered_line",
    ]);

    // (b) the same fee line on an encounter still WAITING, consultation not completed: neither
    // flag. The fixture carries the fee service exactly as (a) does — what changed is the
    // encounter, which is what the guards read.
    const waiting = await shapeEncounter(patientId, { status: "waiting", consultCompletedAt: null });
    const waitingInvoice = await issuePaidInvoice(db, cashier, {
      patientId, serviceId: base.consultNewServiceId, encounterId: waiting,
    });
    const waitingCredit = await creditNoteOver(cashier.actor, waitingInvoice.invoiceId, 1);
    expect(await guardFlagsFor(db, { creditNoteId: waitingCredit })).toEqual<GuardFlag[]>([]);

    // (c) a completed encounter, but the money being refunded is NOT the consult fee: the
    // encounter is terminal, nothing delivered was refunded.
    const otherInvoice = await issuePaidInvoice(db, cashier, {
      patientId, serviceId: base.genericServiceId, encounterId: terminal,
    });
    const otherCredit = await creditNoteOver(cashier.actor, otherInvoice.invoiceId, 1);
    expect(await guardFlagsFor(db, { creditNoteId: otherCredit })).toEqual<GuardFlag[]>(["terminal_encounter"]);

    // (d) an advance refund has no document and therefore no flags.
    expect(await guardFlagsFor(db, {})).toEqual<GuardFlag[]>([]);
  });

  // ===========================================================================================
  // 9 — GUARD 4: reason class and reason, at the boundary
  // ===========================================================================================

  test("guard 4: reasonClass is a closed pair and the reason is mandatory — refused by the boundary schema", async () => {
    const cashier = await cashierWithSession("cashier-guard4");
    const patientId = await mkTestPatient();
    await advanceOfCash(cashier, patientId, 10_000);

    await expect(
      requestRefund(db, cashier.actor, {
        kind: "advance_refund", patientId, amountPaise: 5_000,
        reasonClass: "sorry" as unknown as "genuine", reason: "no class",
      }),
    ).rejects.toBeInstanceOf(z.ZodError);

    await expect(
      requestRefund(db, cashier.actor, {
        kind: "advance_refund", patientId, amountPaise: 5_000, reasonClass: "genuine", reason: "",
      }),
    ).rejects.toBeInstanceOf(z.ZodError);

    await expect(
      issueRefundVoucher(db, cashier.actor, {
        kind: "advance_refund", patientId, amountPaise: 5_000, reasonClass: "genuine", reason: "",
        approvalId: newId(), method: "cash",
      }, NOW),
    ).rejects.toBeInstanceOf(z.ZodError);

    // `seedBillingBase` files (and grants) one tariff_revision approval of its own, so the count
    // that matters is this module's: no refund was ever asked for.
    expect(await db.select().from(approvals).where(eq(approvals.typeKey, REFUND_APPROVAL_TYPE))).toHaveLength(0);
  });

  // ===========================================================================================
  // 10-11 — payment: drawer-bound cash, single-winner, and the bank-transfer floor (K28)
  // ===========================================================================================

  test("payRefundVoucher: cash is drawer-bound, refund-to-payer identity lands on the row, and a second payment is refused", async () => {
    const cashier = await cashierWithSession("cashier-pay");
    const manager = await mkBillingManager(db, "manager-pay");
    const patientId = await mkTestPatient();
    await advanceOfCash(cashier, patientId, 20_000);
    const approvalId = await grantedRefundApproval({
      subjectId: patientId, patientId, amountPaise: 20_000, requester: cashier.actor, approver: manager.actor,
    });
    const voucher = await issueRefundVoucher(db, cashier.actor, {
      kind: "advance_refund", patientId, amountPaise: 20_000, reasonClass: "genuine",
      reason: "unused advance returned", approvalId, method: "cash",
    }, NOW);

    // A cashier with no drawer of their own cannot pay cash out of one (D9).
    const noDrawer = await mkCashier(db, "cashier-no-drawer");
    expect(await codeOf(payRefundVoucher(db, noDrawer.actor, { voucherId: voucher.voucherId, ...PAYEE }, NOW)))
      .toMatchObject({ code: "no_open_session" });

    const paid = await payRefundVoucher(db, cashier.actor, { voucherId: voucher.voucherId, ...PAYEE }, NOW);
    expect(paid).toMatchObject({ status: "paid", amountPaise: 20_000, method: "cash", paidAt: NOW });
    expect(paid.cashierSessionId).not.toBeNull();

    const [stored] = await db.select().from(refundVouchers).where(eq(refundVouchers.id, voucher.voucherId));
    expect(stored!).toMatchObject({ status: "paid", paidBy: cashier.id, ...PAYEE });

    const refunded = await db.select().from(events).where(eq(events.name, "payment.refunded"));
    expect(refunded).toHaveLength(1);
    // An advance refund has no invoice to correlate to; the patient is what carries it.
    expect(refunded[0]!).toMatchObject({ patientId, correlationId: null, module: "billing" });
    expect(refunded[0]!.payload).toMatchObject({ voucherId: voucher.voucherId, amountPaise: 20_000, method: "cash" });

    expect(await codeOf(payRefundVoucher(db, cashier.actor, { voucherId: voucher.voucherId, ...PAYEE }, NOW)))
      .toMatchObject({ code: "voucher_state_conflict", detail: { status: "paid" } });
    expect(await db.select().from(events).where(eq(events.name, "payment.refunded"))).toHaveLength(1);
  });

  test("above the configured ceiling the money may only leave by bank transfer, and every payment names its payee", async () => {
    const cashier = await cashierWithSession("cashier-bank");
    const manager = await mkBillingManager(db, "manager-bank");
    const patientId = await mkTestPatient();
    // Rs 30,000 banked as an advance: below the PAN threshold (5_000_000) and far below the C-2
    // warn threshold (15_000_000), so the cash law is not what this test is measuring.
    await advanceOfCash(cashier, patientId, 3_000_000);

    const ask = (approvalId: string, method: RefundMethod) => ({
      kind: "advance_refund", patientId, amountPaise: 1_500_000, reasonClass: "genuine",
      reason: "advance returned in full", approvalId, method,
    } as const);
    const cashApproval = await grantedRefundApproval({
      subjectId: patientId, patientId, amountPaise: 1_500_000, requester: cashier.actor, approver: manager.actor,
    });
    const transferApproval = await grantedRefundApproval({
      subjectId: patientId, patientId, amountPaise: 1_500_000, requester: cashier.actor, approver: manager.actor,
    });

    // 1_500_000 paise is above refundBankAbovePaise (1_000_000). The voucher issues — the ceiling
    // governs the INSTRUMENT the money leaves by, and that is decided at the drawer.
    const cashVoucher = await issueRefundVoucher(db, cashier.actor, ask(cashApproval, "cash"), NOW);
    expect(await codeOf(payRefundVoucher(db, cashier.actor, { voucherId: cashVoucher.voucherId, ...PAYEE }, NOW)))
      .toMatchObject({
        code: "bank_transfer_required",
        detail: { amountPaise: 1_500_000, refundBankAbovePaise: 1_000_000, method: "cash" },
      });

    const transferVoucher = await issueRefundVoucher(db, cashier.actor, ask(transferApproval, "bank_transfer"), NOW);
    // Refund-to-payer: the identity is mandatory at PAY time for EVERY method (spec §7).
    await expect(
      payRefundVoucher(db, cashier.actor, { voucherId: transferVoucher.voucherId, payeeName: "", payeeIdType: "aadhaar", payeeIdRef: "XXXX-XXXX-1234" }, NOW),
    ).rejects.toBeInstanceOf(z.ZodError);

    const paid = await payRefundVoucher(db, cashier.actor, { voucherId: transferVoucher.voucherId, ...PAYEE }, NOW);
    expect(paid).toMatchObject({ status: "paid", method: "bank_transfer", cashierSessionId: null });

    const [stillIssued] = await db.select().from(refundVouchers).where(eq(refundVouchers.id, cashVoucher.voucherId));
    expect(stillIssued!.status).toBe("issued"); // the refused payment moved nothing
  });

  // ===========================================================================================
  // 12-13 — the boundary belt, and the SoD that comes free from the kernel
  // ===========================================================================================

  test("assertPaise belts the boundary BEFORE anything is read: a fractional refund is invalid_paise", async () => {
    const cashier = await cashierWithSession("cashier-paise");
    const patientId = await mkTestPatient();
    await advanceOfCash(cashier, patientId, 10_000);

    await expect(
      requestRefund(db, cashier.actor, {
        kind: "advance_refund", patientId, amountPaise: 1_000.5, reasonClass: "genuine", reason: "half a paisa",
      }),
    ).rejects.toMatchObject({ code: "invalid_paise" });

    // ORDERING, not merely refusal: the approval id below is not an approval at all, so if the
    // check-on-execute ran first the error would be `approval_not_granted`.
    await expect(
      issueRefundVoucher(db, cashier.actor, {
        kind: "advance_refund", patientId, amountPaise: 1_000.5, reasonClass: "genuine", reason: "half a paisa",
        approvalId: newId(), method: "cash",
      }, NOW),
    ).rejects.toMatchObject({ code: "invalid_paise" });

    expect(await db.select().from(approvals).where(eq(approvals.typeKey, REFUND_APPROVAL_TYPE))).toHaveLength(0);
    expect(await db.select().from(refundVouchers)).toHaveLength(0);
  });

  test("the cashier approving their OWN refund is refused by the kernel's requester_approver SoD pair", async () => {
    const cashier = await cashierWithSession("cashier-sod");
    const patientId = await mkTestPatient();
    await advanceOfCash(cashier, patientId, 10_000);
    const asked = await requestRefund(db, cashier.actor, {
      kind: "advance_refund", patientId, amountPaise: 5_000, reasonClass: "genuine", reason: "balance returned",
    });

    // The cashier ALSO holds billing_manager here — proving SoD, not a missing permission, is the
    // gate (the decisions.test.ts precedent, and T4's variance test).
    await assignRole(db, { userId: cashier.id, roleKey: "billing_manager", scopeType: "hospital" });
    await expect(
      approveRequest(db, cashier.actor, { approvalId: asked.approvalId, note: "approving my own refund" }),
    ).rejects.toBeInstanceOf(SodViolationError);

    const [row] = await db.select().from(approvals).where(eq(approvals.id, asked.approvalId));
    expect(row!.status).toBe("pending"); // nothing moved
    const sodEvents = await db.select().from(events).where(eq(events.name, "sod.violation_blocked"));
    expect(sodEvents).toHaveLength(1);
    expect(sodEvents[0]!.payload).toMatchObject({
      pairKey: "requester_approver", actorAId: cashier.id, actorBId: cashier.id,
    });
  });

  // ===========================================================================================
  // 14 — the T4 term goes live: a paid cash voucher leaves the drawer short by its own amount
  // ===========================================================================================

  test("a paid cash voucher subtracts from the session's expected cash at close", async () => {
    const cashier = await cashierWithSession("cashier-close", 100_000);
    const manager = await mkBillingManager(db, "manager-close");
    const patientId = await mkTestPatient();

    // float 100000 + cash tenders (50000 invoice + 20000 advance) - cash vouchers paid (20000)
    //   = 150000 expected in the drawer at close.
    await issuePaidInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId });
    await advanceOfCash(cashier, patientId, 20_000);
    const approvalId = await grantedRefundApproval({
      subjectId: patientId, patientId, amountPaise: 20_000, requester: cashier.actor, approver: manager.actor,
    });
    const voucher = await issueRefundVoucher(db, cashier.actor, {
      kind: "advance_refund", patientId, amountPaise: 20_000, reasonClass: "mistake",
      reason: "advance taken at the wrong counter", approvalId, method: "cash",
    }, NOW);
    await payRefundVoucher(db, cashier.actor, { voucherId: voucher.voucherId, ...PAYEE }, NOW);

    // Three Rs 500 notes = 150000 paise counted (cash-math.ts's denomination keys are paise).
    const closed = await beginClose(db, cashier.actor, { denominations: { "50000": 3 } }, NOW);
    expect(closed).toMatchObject({
      countedCashPaise: 150_000, expectedCashPaise: 150_000, variancePaise: 0, status: "closed",
    });
  });
});
