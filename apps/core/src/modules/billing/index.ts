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
export { BillingError } from "./errors";
export type { BillingErrorCode } from "./errors";
export { issueInvoice, memberBenefitsEnabled, previewInvoice, invoiceSettlement, getInvoice, listInvoices } from "./invoices";
export type { IssueInvoiceInput, IssueInvoiceResult, InvoiceRow, InvoiceLineRow, PricedDraft } from "./invoices";
export { recordReceipt, allocateReceipt, reverseAllocation, patientBalance, listDues, markEnteredInError } from "./receipts";
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
