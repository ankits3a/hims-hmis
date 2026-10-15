import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantCreditExtend, issuePaidInvoice, issuePaidInvoiceByTender, mkBillingManager, mkCashier, openSessionFor, seedBillingBase,
} from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { approveRequest } from "../../kernel/approvals/decisions";
import { withTx } from "../../kernel/db/client";
import { DESTINATION_OF } from "../../kernel/printing/enqueue";
import { renderDocument } from "../../kernel/printing/render";
import { patients, printJobs, refundVouchers, registrationConfig, receiptTenders } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { issueCreditNote } from "./credit-notes";
import { dayBook } from "./daily-close";
import { getInvoice, issueInvoice, previewInvoice } from "./invoices";
import { billingOfficeNeeds } from "./office-needs";
import { uploadSettlement } from "./recon";
import { resolveMismatch } from "./recon-resolve";
import { issueRefundVoucher, patientCreditNotes, payRefundVoucher, requestRefund } from "./refunds";
import { registerBillingPrinting, rupeesInWords } from "./refund-print";
import type { Db } from "../../kernel/db/client";

/**
 * #655 — THE BILLING BACK OFFICE'S GAPS FROM THE UX AUDIT (HANDOFF 2026-10-04 §5.4; board
 * docs/design/2026-09-28-ux-audit/billing-back-office.html):
 *   1. a printed refund voucher, server-side (owner ruling 2026-09-04): number, amount in words, payee
 *      and a signature line;
 *   2. the day book's line for bank charges the office accepted;
 *   3. "someone else collects for the patient — name the relation", never an Aadhaar number;
 *   4. the GSTR-1 row's count of hospital GSTINs billed;
 *   5. the refund form picks a credit note from the patient's own list instead of taking a raw id.
 */
describe("#655 — billing back office gaps", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  const NOW = new Date("2026-08-19T06:00:00Z"); // 11:30 IST, IST day 2026-08-19
  const DAY = "2026-08-19";
  const OFFICE: Actor = { type: "user", id: "office-gaps" };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
    await grantCreditExtend(db);
  });

  let n = 0;
  const mkPatient = async (name: string): Promise<string> => {
    const { patient } = await withTx(db, (tx) => registerPatient(tx, { type: "user", id: "clerk" }, { name, sex: "female", ageYears: 40 }));
    return patient.id;
  };
  const cashierOpen = async (): Promise<{ id: string; actor: Actor }> => {
    n += 1;
    const c = await mkCashier(db, `gaps-cashier-${String(n)}`);
    await openSessionFor(db, c, 100_000);
    return c;
  };

  /** An issued cash voucher of `amountPaise` against a credit note on a paid consultation bill. */
  async function issuedVoucher(amountPaise = 50_000): Promise<{ voucherId: string; voucherNo: string; cashier: { id: string; actor: Actor }; patientId: string; creditNoteId: string }> {
    const cashier = await cashierOpen();
    const manager = await mkBillingManager(db, `gaps-manager-${String(n)}`);
    const patientId = await mkPatient("Sunita Verma");
    const invoice = await issuePaidInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId }, NOW);
    const line = (await getInvoice(db, invoice.invoiceId))!.lines[0]!;
    const cn = await issueCreditNote(db, cashier.actor, { kind: "refund", invoiceId: invoice.invoiceId, reason: "service cancelled", lines: [{ invoiceLineId: line.id, qty: 1 }] }, NOW);
    const ask = { kind: "invoice_refund", creditNoteId: cn.creditNoteId, amountPaise, reasonClass: "genuine", reason: "MRI cancelled after payment" } as const;
    const asked = await requestRefund(db, cashier.actor, ask);
    await approveRequest(db, manager.actor, { approvalId: asked.approvalId, note: "ok" });
    const v = await issueRefundVoucher(db, cashier.actor, { ...ask, approvalId: asked.approvalId, method: "cash" }, NOW);
    return { voucherId: v.voucherId, voucherNo: v.voucherNo, cashier, patientId, creditNoteId: cn.creditNoteId };
  }

  // ——— 1 · the printed voucher ———

  test("rupees in words, Indian grouping, paise only when there are any", () => {
    expect(rupeesInWords(240_000)).toBe("Rupees Two Thousand Four Hundred Only");
    expect(rupeesInWords(12_345_678_950)).toBe("Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine and Fifty Paise Only");
    expect(rupeesInWords(50)).toBe("Rupees Zero and Fifty Paise Only");
    expect(rupeesInWords(100_000_00)).toBe("Rupees One Lakh Only");
  });

  test("paying a voucher queues ONE printed voucher for the front desk's A4: number, amount in words, payee and relation, a signature line — and no ID number", async () => {
    const unregister = registerBillingPrinting();
    try {
      const v = await issuedVoucher(50_000);
      const paid = await payRefundVoucher(db, v.cashier.actor, { voucherId: v.voucherId, payeeName: "Ramesh Verma", payeeIdType: "driving_licence", payeeIdRef: "BR-0619-2011-0045", payeeRelation: "son" }, NOW);
      expect(paid.printJobId).toEqual(expect.any(String));

      const jobs = await db.select().from(printJobs);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ document: "billing_refund_voucher", destination: DESTINATION_OF.billing_refund_voucher, patientId: v.patientId, params: { voucherId: v.voucherId } });
      expect(DESTINATION_OF.billing_refund_voucher).toBe("front_desk_a4");

      const doc = await renderDocument(db, "billing_refund_voucher", { voucherId: v.voucherId }, NOW, v.cashier.actor);
      expect(doc).not.toBeNull();
      const text = doc!.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      expect(text).toContain(v.voucherNo);
      expect(text).toContain("₹500.00");
      expect(text).toContain("Rupees Five Hundred Only");
      expect(text).toContain("Ramesh Verma");
      expect(text).toContain("son");
      expect(text).toContain("Sunita Verma");
      expect(text).toMatch(/Signature of the payee/i);
      expect(text).not.toContain("BR-0619-2011-0045");

      // A second pay call is refused and queues nothing more.
      await expect(payRefundVoucher(db, v.cashier.actor, { voucherId: v.voucherId, payeeName: "x", payeeIdType: "pan" }, NOW)).rejects.toMatchObject({ code: "voucher_state_conflict" });
      expect(await db.select().from(printJobs)).toHaveLength(1);
    } finally {
      unregister();
    }
  });

  /* FD-25 — a print with no requester on record defaults to the ALIAS for a sealed patient, as the kernel's own papers do. */
  test("with no requester on record, a sealed patient's voucher prints the alias, never the name", async () => {
    const unregister = registerBillingPrinting();
    try {
      const v = await issuedVoucher(50_000);
      await payRefundVoucher(db, v.cashier.actor, { voucherId: v.voucherId, payeeName: "Ramesh Verma", payeeIdType: "pan" }, NOW);
      await db.update(patients).set({ isConfidential: true, alias: "Patient R" }).where(eq(patients.id, v.patientId));
      const doc = await renderDocument(db, "billing_refund_voucher", { voucherId: v.voucherId }, NOW, null);
      const text = doc!.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      expect(text).toContain("Patient R");
      expect(text).not.toContain("Sunita Verma");
    } finally {
      unregister();
    }
  });

  test("an unpaid voucher renders nothing", async () => {
    const unregister = registerBillingPrinting();
    try {
      const v = await issuedVoucher();
      expect(await renderDocument(db, "billing_refund_voucher", { voucherId: v.voucherId }, NOW, v.cashier.actor)).toBeNull();
    } finally {
      unregister();
    }
  });

  // ——— 3 · someone else collects ———

  test("the relation of someone collecting for the patient is stored; a number in it is refused, Aadhaar rules unchanged", async () => {
    const v = await issuedVoucher();
    await expect(payRefundVoucher(db, v.cashier.actor, { voucherId: v.voucherId, payeeName: "Ramesh", payeeIdType: "pan", payeeRelation: "1234 5678 9012" }, NOW))
      .rejects.toMatchObject({ code: "payee_relation_invalid" });
    await payRefundVoucher(db, v.cashier.actor, { voucherId: v.voucherId, payeeName: "Ramesh Verma", payeeIdType: "aadhaar", payeeRelation: " husband " }, NOW);
    const [row] = await db.select().from(refundVouchers).where(eq(refundVouchers.id, v.voucherId));
    expect(row).toMatchObject({ payeeName: "Ramesh Verma", payeeIdType: "aadhaar", payeeIdRef: null, payeeRelation: "husband" });
  });

  test("the patient collecting herself records no relation", async () => {
    const v = await issuedVoucher();
    await payRefundVoucher(db, v.cashier.actor, { voucherId: v.voucherId, payeeName: "Sunita Verma", payeeIdType: "pan" }, NOW);
    const [row] = await db.select().from(refundVouchers).where(eq(refundVouchers.id, v.voucherId));
    expect(row!.payeeRelation).toBeNull();
  });

  // ——— 2 · the day book's bank charges ———

  test("the day book counts the bank charges the office accepted that day; a dispute is not one", async () => {
    const accept = async (settled: number, outcome: "bank_charge" | "dispute"): Promise<void> => {
      const cashier = await cashierOpen();
      const patientId = await mkPatient(`Card ${String(n)}`);
      const ref = `CARD-GAP-${String(n)}`;
      const paid = await issuePaidInvoiceByTender(db, cashier, { patientId, serviceId: base.consultNewServiceId, mode: "card", refText: ref });
      await uploadSettlement(db, OFFICE, { csv: `ref,settledPaise,settledOn\n${ref},${String(settled)},${DAY}`, source: "card" }, NOW);
      const [tender] = await db.select().from(receiptTenders).where(eq(receiptTenders.receiptId, paid.receiptId!));
      await resolveMismatch(db, OFFICE, { tenderId: tender!.id, outcome, reason: "MDR difference" }, NOW);
    };
    await accept(48_000, "bank_charge"); // short 1250
    await accept(44_250, "bank_charge"); // short 5000
    await accept(47_000, "dispute");
    expect((await dayBook(db, DAY)).bankCharges).toEqual({ count: 2, amountPaise: 6_250 });
    expect((await dayBook(db, "2026-08-20")).bankCharges).toEqual({ count: 0, amountPaise: 0 });
  });

  // ——— 4 · the GSTR-1 GSTIN count ———

  test("the GSTR-1 row counts the distinct hospital GSTINs billed in the month it is due for", async () => {
    const cashier = await cashierOpen();
    const patientId = await mkPatient("B2B Patient");
    const bill = async (gstin: string | undefined): Promise<void> => {
      const lines = [{ lineId: newId(), serviceId: base.consultNewServiceId, qty: 1 }];
      const preview = await previewInvoice(db, { lines }, NOW);
      await issueInvoice(db, cashier.actor, {
        draftId: newId(), patientId, lines, ...(gstin === undefined ? {} : { buyerGstin: gstin }),
        receipt: { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] },
      }, NOW);
    };
    await bill("10AABCU9603R1ZM");
    await bill("10AABCU9603R1ZM");
    await bill("27AAPFU0939F1ZV");
    await bill(undefined);
    const row = (await billingOfficeNeeds(db, OFFICE, NOW)).rows.find((r) => r.kind === "gstr1_due")!;
    expect(row.params).toMatchObject({ month: "2026-08", gstinCount: 2 });
  });

  // ——— 5 · the credit-note picker ———

  test("a patient's credit notes, with what is still refundable on each — the refund form's picker", async () => {
    const v = await issuedVoucher(20_000); // the credit note is ₹500.00; ₹200.00 of it is on a voucher
    const notes = await patientCreditNotes(db, v.patientId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ creditNoteId: v.creditNoteId, creditNoteNo: expect.stringMatching(/^CN\//), invoiceNo: expect.stringMatching(/^INV\//), netPaise: 50_000, refundedPaise: 20_000, refundablePaise: 30_000 });
    expect(await patientCreditNotes(db, await mkPatient("Nobody"))).toEqual([]);
  });
});
