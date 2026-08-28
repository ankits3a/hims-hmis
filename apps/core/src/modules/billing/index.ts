/**
 * THE cross-module interface of the billing module (spec §4). Later plans import from here or
 * consume events — never internals. Plan 09's accrual ledger consumes `payment.received` /
 * `payment.refunded`; Plan 08.5's worker process runs `runDailyClose` daily at 23:59 IST as the
 * sixth of its six sweeps (Plan 11 productionises the worker, it does not schedule this); the IPD
 * phase consumes the advance instrument. Everything else the counter needs is reachable over HTTP
 * only (the Plan 05/07 pattern) — `billing.controller.ts` is the wire contract.
 */
export { billingManifest } from "./manifest";
export { BillingModule } from "./billing.module";
export { BillingError, billingHttpStatus } from "./errors";
export type { BillingErrorCode } from "./errors";
export {
  issueInvoice, memberBenefitsEnabled, previewInvoice, invoiceSettlement, getInvoice, listInvoices,
  // PLAN 15 T7 / DD11-F2 — the encounter-resolver seam. OPD registers `V`; the OT registers `D`.
  registerEncounterResolver, registeredEncounterPrefixes,
} from "./invoices";
export type { EncounterResolver, IssueInvoiceInput, IssueInvoiceResult, InvoiceRow, InvoiceLineRow, PricedDraft } from "./invoices";
/**
 * PLAN 15 T3 / DD12 — `advanceOf` JOINS THIS LIST, and it is a one-line cross-module edit with a
 * reason rather than a convenience.
 *
 * `patientBalance` already exposes the same number, but it takes `Db` and an `Actor` and runs three
 * reads. The mini-OT's `holdDeposit` needs the advance INSIDE its own transaction, under the lock
 * that makes "the patient's advance minus what is already earmarked" a safe read-then-write —
 * `advanceOf(exec: Db | Tx, patientId)` is the only reader in this module with that signature.
 * Reaching around this index into `receipts.ts` would be the §4 violation; widening the index by
 * one export is the sanctioned way, and it exposes nothing `patientBalance` did not already.
 */
export { recordReceipt, allocateReceipt, reverseAllocation, patientBalance, listDues, markEnteredInError, advanceOf, receiptUnallocatedPaise } from "./receipts";
export type { PatientBalance, DueRow, ReceiptRow, AllocationRow } from "./receipts";
export { issueCreditNote, listCreditNotes } from "./credit-notes";
export type { IssueCreditNoteInput, IssueCreditNoteResult, CreditNoteKind } from "./credit-notes";
export { requestRefund, issueRefundVoucher, payRefundVoucher } from "./refunds";
export type { RefundKind, RefundMethod, RefundVoucherRow } from "./refunds";
/**
 * PLAN 09 / DD19 — the ONE new export this phase opens, and the only way the accrual consumer
 * (T6, `modules/partners`) reads billing money. `creditedPaiseOf`, `allocatedPaiseOf` and
 * `enteredInErrorDocIds` stay private and `invoiceSettlement` cannot separate credited from
 * allocated, so DD12's credit-aware base needs a reader of its own rather than a relaxed lint rule.
 */
export { invoiceAccrualView } from "./accrual-view";
export type { InvoiceAccrualLine, InvoiceAccrualView } from "./accrual-view";
export { totalInvoice } from "./totals";
export type { InvoiceTotals, TaxSummaryRow } from "./totals";
export { creditShare } from "./credit-share";
export { settlementState } from "./settlement";
export type { Settlement, SettlementState } from "./settlement";
export { runDailyClose, dayBook, gstr1Summary } from "./daily-close";
export type { DayBook, Gstr1Row, DailyCloseResult } from "./daily-close";
export { registerBillingApprovalTypes, BILLING_APPROVAL_TYPES } from "./approval-types";
export { loadBillingConfig } from "./config";
export type { BillingConfig } from "./config";
export * from "./events";
