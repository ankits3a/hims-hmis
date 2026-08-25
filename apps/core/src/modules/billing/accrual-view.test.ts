import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantCreditExtend, mkBillingManager, mkCashier, openSessionFor, seedBillingBase,
} from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { approveRequest } from "../../kernel/approvals/decisions";
import { withTx } from "../../kernel/db/client";
import { enteredInErrorMarks, registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { invoiceAccrualView } from "./accrual-view";
import { issueCreditNote } from "./credit-notes";
import { getInvoice, issueInvoice } from "./invoices";
import { allocateReceipt, recordReceipt, reverseAllocation } from "./receipts";
import { issueRefundVoucher, payRefundVoucher, requestRefund } from "./refunds";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 09 DD19 / S15 — `invoiceAccrualView`, the seam the accrual consumer reads billing money
 * through. **§2.49 binds harder here than anywhere else in this phase**, because this export has
 * NO CALLER until T6: an assertion about a surface nothing uses is exactly how a vacuous test is
 * born, and the plan says so in as many words.
 *
 * The remedy the plan prescribes and this file executes: every fixture below carries a credit note
 * ON AN ELIGIBLE LINE, an allocation reversal and an entered-in-error mark, **with numbers that
 * differ from one another** — so an implementation that returned the invoice's own stored,
 * pre-credit numbers (which is what a naive reader would return, since `invoices` and
 * `invoice_lines` are IMMUTABLE and a credit note moves neither) fails them.
 *
 * ═══ THE FIXTURE'S MONEY, HAND-DERIVED FROM THE SHIPPED ENGINE ═══
 *
 * `seedBillingBase`: OPD-CONSULT-NEW at 50 000 paise in the EXEMPT "consultation" category,
 * GENERIC-SERVICE at 50 000 in "pharmacy", taxable at 1 200 bps.
 *   divHalfUp(n, d) = floor((2n + d) / 2d) · taxHead(base, rateBps) = divHalfUp(base·rateBps, 20 000)
 *
 *   line 1 — consultation qty 2 : gross 100 000 · base 100 000 · heads 0 · net 100 000
 *   line 2 — pharmacy qty 1     : gross  50 000 · base  50 000 · taxHead(50 000, 1 200) = 3 000
 *                                 per head · net 56 000
 *   invoice raw 156 000 → roundTotalToRupee = 156 000 (rupee-exact), NET PAYABLE 156 000
 *
 *   a qty-1 refund credit note over line 1 (p = 0, k = 1, qty 2):
 *     gross divHalfUp(100 000 × 1, 2) = 50 000 · base 50 000 · heads 0 · raw 50 000 · NET 50 000
 *
 * Four different numbers, on purpose: netPayable 156 000 · credited 50 000 · allocated 60 000 ·
 * line-1 credited base 50 000 against a stored base of 100 000.
 *
 * ═══ TWO DISCLOSED SHAPINGS, AND WHY EACH IS UNAVOIDABLE ═══
 *
 * `entered_in_error_marks` rows with `doc_type = 'invoice'` are inserted DIRECTLY. Nothing in this
 * module writes one — `markEnteredInError` marks RECEIPTS, and an invoice's own entered-in-error
 * grammar is the `correction` credit note (D4) — but the mark is READ by `patientOutstandingPaise`
 * and by DD12's `target = 0` branch, so the reader must report it and the only way to put one
 * there is to write it. The same applies to the `doc_type = 'credit_note'` mark, whose live-note
 * filter is what stops a cancelled credit note crediting anything.
 */
describe("invoiceAccrualView: DD19's seam, on live money", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let cashier: { id: string; actor: Actor };
  let manager: { id: string; actor: Actor };
  let patientId: string;

  const NOW = new Date("2026-08-19T06:00:00Z"); // 11:30 IST — the billing suite's own fixed instant
  const PAYEE = { payeeName: "Asha Devi", payeeIdType: "aadhaar", payeeIdRef: "XXXX-XXXX-1234" };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    await grantCreditExtend(db);
    cashier = await mkCashier(db, "accrual_view_cashier");
    await openSessionFor(db, cashier, 1_000_000);
    manager = await mkBillingManager(db, "accrual_view_manager");
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, { type: "user", id: "accrual-clerk" }, { name: "Vimal Rao", sex: "male", ageYears: 52 }));
    patientId = patient.id;
  });

  /** The two-line invoice this file's header derives, issued on D2's credit lane and part-paid. */
  async function mixedInvoice(): Promise<{ invoiceId: string; lineIds: string[] }> {
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: newId(), patientId,
      lines: [
        { lineId: newId(), serviceId: base.consultNewServiceId, qty: 2 },
        { lineId: newId(), serviceId: base.genericServiceId, qty: 1 },
      ],
      credit: { reason: "settles at the dues counter" },
    }, NOW);
    expect(issued.totals.netPayablePaise).toBe(156_000);
    const found = await getInvoice(db, issued.invoiceId);
    return { invoiceId: issued.invoiceId, lineIds: found!.lines.map((l) => l.id) };
  }

  it("reports live money and live per-line base: a credit note on an eligible line moves BOTH", async () => {
    const { invoiceId, lineIds } = await mixedInvoice();

    // 60 000 stays applied; a second 40 000 is applied and then REVERSED, so the reversal is real
    // and the allocated total is neither the invoice's payable nor the sum of what was received.
    const first = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 60_000 }] }, NOW);
    await allocateReceipt(db, cashier.actor, { receiptId: first.receiptId, invoiceId, amountPaise: 60_000 }, NOW);
    const second = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 40_000 }] }, NOW);
    const applied = await allocateReceipt(db, cashier.actor, { receiptId: second.receiptId, invoiceId, amountPaise: 40_000 }, NOW);
    await reverseAllocation(db, cashier.actor, { allocationId: applied.allocationId, reason: "posted to the wrong bill" }, NOW);

    // §3 Q4's fixture trap: `issueCreditNote` wants the STORED `invoice_lines.id`, never a draft id.
    await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId, reason: "one consultation was not given",
      lines: [{ invoiceLineId: lineIds[0]!, qty: 1 }],
    }, NOW);

    const view = (await invoiceAccrualView(db, invoiceId))!;
    expect(view).toEqual({
      invoiceId,
      issuedAt: NOW,
      enteredInError: false,
      netPayablePaise: 156_000, // the invoice row never moved — it is immutable
      creditedPaise: 50_000, // ... and this is what says the money did
      allocatedPaise: 60_000, // Σ apply − Σ reverse: 60 000 + 40 000 − 40 000
      refundedPaise: 0,
      lines: [
        { lineId: lineIds[0]!, category: "consultation", taxableBasePaise: 100_000, creditedBasePaise: 50_000 },
        { lineId: lineIds[1]!, category: "pharmacy", taxableBasePaise: 50_000, creditedBasePaise: 0 },
      ],
    });
    // The DD12 arithmetic this view exists to feed, spelled out on these numbers so the fixture
    // cannot drift into agreeing with a pre-credit implementation:
    //   liveBase(line 1) = 100 000 − 50 000 = 50 000, and NOT the stored 100 000
    //   settleable       = 156 000 − 50 000 = 106 000, and NOT the stored 156 000
    expect(view.lines[0]!.taxableBasePaise - view.lines[0]!.creditedBasePaise).toBe(50_000);
    expect(view.netPayablePaise - view.creditedPaise).toBe(106_000);
  });

  it("a credit note that is ITSELF entered-in-error credits nothing, in the total and per line", async () => {
    const { invoiceId, lineIds } = await mixedInvoice();
    const note = await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId, reason: "raised against the wrong bill",
      lines: [{ invoiceLineId: lineIds[0]!, qty: 1 }],
    }, NOW);
    expect((await invoiceAccrualView(db, invoiceId))!.creditedPaise).toBe(50_000);

    // See the header's shaping disclosure.
    await db.insert(enteredInErrorMarks).values({
      id: newId(), docType: "credit_note", docId: note.creditNoteId,
      reason: "the note was raised in error", markedBy: manager.id, markedAt: NOW,
    });

    const view = (await invoiceAccrualView(db, invoiceId))!;
    expect(view.creditedPaise).toBe(0);
    expect(view.lines.map((l) => l.creditedBasePaise)).toEqual([0, 0]);
  });

  it("an entered-in-error INVOICE is reported as such — DD12's `target = 0` branch", async () => {
    const { invoiceId } = await mixedInvoice();
    expect((await invoiceAccrualView(db, invoiceId))!.enteredInError).toBe(false);
    // See the header's shaping disclosure: nothing in this module marks an INVOICE.
    await db.insert(enteredInErrorMarks).values({
      id: newId(), docType: "invoice", docId: invoiceId,
      reason: "the whole bill belongs to another person", markedBy: manager.id, markedAt: NOW,
    });
    expect((await invoiceAccrualView(db, invoiceId))!.enteredInError).toBe(true);
  });

  it("a PAID refund voucher moves refundedPaise, and an issued-but-unpaid one moves nothing", async () => {
    const { invoiceId, lineIds } = await mixedInvoice();
    const receipt = await recordReceipt(db, cashier.actor, { patientId, tenders: [{ mode: "cash", amountPaise: 156_000 }] }, NOW);
    await allocateReceipt(db, cashier.actor, { receiptId: receipt.receiptId, invoiceId, amountPaise: 156_000 }, NOW);
    const note = await issueCreditNote(db, cashier.actor, {
      kind: "refund", invoiceId, reason: "one consultation was not given",
      lines: [{ invoiceLineId: lineIds[0]!, qty: 1 }],
    }, NOW);

    const asked = await requestRefund(db, cashier.actor, {
      kind: "invoice_refund", creditNoteId: note.creditNoteId, amountPaise: 50_000,
      reasonClass: "genuine", reason: "the consultation was not given",
    });
    await approveRequest(db, manager.actor, { approvalId: asked.approvalId, note: "approved for the test" });
    const voucher = await issueRefundVoucher(db, cashier.actor, {
      kind: "invoice_refund", creditNoteId: note.creditNoteId, amountPaise: 50_000,
      reasonClass: "genuine", reason: "the consultation was not given",
      approvalId: asked.approvalId, method: "cash",
    }, NOW);

    // ISSUED is not PAID: the money has not left the drawer, so nothing has been refunded yet.
    expect((await invoiceAccrualView(db, invoiceId))!.refundedPaise).toBe(0);

    await payRefundVoucher(db, cashier.actor, { voucherId: voucher.voucherId, ...PAYEE }, NOW);
    const view = (await invoiceAccrualView(db, invoiceId))!;
    expect(view.refundedPaise).toBe(50_000);
    // collected = allocated − refunded = 156 000 − 50 000 = 106 000, which is exactly the
    // settleable above: the invoice is square again, and DD12's delta for it is zero.
    expect(view.allocatedPaise - view.refundedPaise).toBe(106_000);
    expect(view.netPayablePaise - view.creditedPaise).toBe(106_000);
  });

  it("an invoice this database does not hold reads back as null, never as an exception", async () => {
    expect(await invoiceAccrualView(db, newId())).toBeNull();
  });
});
