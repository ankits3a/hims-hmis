---
type: module-notes
title: "billing — module notes"
description: "Why and traps of the money ledger: invoices, receipts, allocations, credit notes, refunds, cashier sessions and the day book."
resource: apps/core/src/modules/billing
tags: [billing]
generated: { by: agent:claude, at: 2026-10-07 }
verified: []
stale_after: 2027-01-05
---
# billing — module notes

Hand-written notes: the WHY and the traps. Signatures, routes and tables are generated in
`docs/architecture/modules/billing.md`; read that for the public API. Paths are relative to
`apps/core/src/modules/billing/` unless they start with a module name or `kernel/`. Citations name a file and a
symbol or error code, never a line number (line numbers rot; `node tools/arch/gen.mjs --check` refuses them).
Update this file in the same PR when you change a flow, an invariant or a trap below.

## 1. Purpose
Money ledger of the hospital: invoices, receipts, allocations, credit notes, refunds, cashier sessions, day book.
Every rupee is an integer paise; documents are append-only and corrected by new documents, never edited.

## 2. Key files (owner of what)
- `index.ts` — the ONLY import door for other modules (lint-enforced).
- `billing.controller.ts` — 49 HTTP routes under `/billing/*`; wraps writes in `withIdempotency`.
- `invoices.ts` — pricing preview, `issueInvoice`, `insertReceiptWithTenders`, `invoiceSettlement`, `getInvoice`.
- `receipts.ts` — `recordReceipt`, `allocateReceipt`/`allocateOnTx`, `reverseAllocation`, `markEnteredInError`, `advanceOf`, `patientBalance`, `listDues`, `releaseInvoiceSurplusOnTx`.
- `credit-notes.ts` + `credit-share.ts` — `issueCreditNote` (3 kinds); pure per-line pro-rata share (`creditShare`).
- `refunds.ts` — `requestRefund` / `issueRefundVoucher` / `payRefundVoucher` (approval ladder).
- `daily-close.ts` — `runDailyClose`, `dayBook`, `gstr1Summary`, `chargeOrphans`.
- `sessions.ts` — cashier drawer: `openSession`, `requireOpenSession`, expected-cash reads.
- `cash-law.ts` / `cash-math.ts` — cash threshold / PAN rules (`assertCashAccepted`); denomination and expected-cash arithmetic.
- `totals.ts` — `totalInvoice`, `roundTotalBy`, `ROUNDING_RULES`. `settlement.ts` — `settlementState` (pure).
- `series.ts` — `nextDocNo` gapless numbering per series and FY. `time.ts` — `istDay`.
- `idempotency.ts` — `withIdempotency`. `errors.ts` — `BillingError`, `billingHttpStatus`.
- `events.ts` — event catalog (`invoiceIssued`, `receiptRecorded`, `paymentReceived`, `creditNoteIssued`, `dayClosed`, ...).
- `approval-types.ts` — approval type registration. `config.ts` — `loadBillingConfig`.
- `fee-status.ts` + `settle-hooks.ts` — consult-fee status projection and the hook registry (OPD flips queue token).
- `visit-move.ts` — money moves with a visit on OPD department move.
- `report-reads.ts`, `accrual-view.ts`, `patient-bills.ts` — read-only views for other modules.
- Also present, not opened for this map: `gate.ts`, `recon*.ts`, `worklist.ts`, `office-needs.ts`, `credit-requests.ts`, `fee-switches.ts`, `consult-prices.ts`, `charge-rules.ts`, `search-provider.ts`, `desk-provider.ts`.
- Tables: `kernel/db/schema/billing.ts` (16 tables, list in the architecture page).

## 3. Main flows
### 3.1 Issue invoice — `issueInvoice(db, actor, input, now)` invoices.ts; route `POST /billing/invoices` billing.controller.ts (via `withIdempotency`)
1. `loadBillingConfig`; canonicalise `encounterId` (`canonicalEncounterRef`); `priceDraftWithBenefits` (outside tx).
2. Pure arithmetic: tender total, `allocatedPaise = min(tenders, net)`, `remainderPaise`, `unallocatedPaise`.
3. Change-given guards: `change_without_cash`, `change_exceeds_surplus`.
4. `withTx`. If encounter: `pg_advisory_xact_lock(hashtext('invoice:'+encounterId))`, then duplicate guard `duplicate_invoice_refused`.
5. `nextDocNo(...,"invoice")`. Each approval-needing discount line needs a granted approval (`discount_approval_missing`).
6. Remainder > 0: hold, or credit lane. Refusals `unsettled_issue_refused`, `credit_permission_required`, `credit_approval_required` (owner approval always), then outstanding cap.
7. Insert `invoices` row, then `invoice_lines`; `consumeWinningInstruments` when member benefits are on.
8. If receipt present: `requireOpenSession`, `assertCashAccepted`, `insertReceiptWithTenders`, insert `allocations` row (kind "apply").
9. `allocateOnTx` for each `settleFromReceipts`. Append events (`invoiceIssued`, `invoiceCreditExtended`, `receiptRecorded`, `paymentReceived`, `advanceReceived`, `cashThresholdWarned`).
10. `emitFeeStatusChanged` when encounter and (credit or settled). `enqueuePrintJob` `opd_payment_receipt` when money moved.
11. Catch: `cash_threshold_blocked` appends `cashThresholdBlocked` in a NEW tx so the audit survives the rollback.

### 3.2 Record receipt + allocation
- `recordReceipt(db, actor, input, now)` receipts.ts; route `POST /billing/receipts` controller. Standalone advance, no invoice.
  1. `assertPaise` per tender; total must be > 0. 2. `withTx`: `requireOpenSession`, `assertCashAccepted`, `insertReceiptWithTenders` (numbers via `nextDocNo "receipt"` invoices.ts).
  3. Events `receiptRecorded`, `advanceReceived`, optional `cashThresholdWarned`. 4. Same blocked-audit catch as 3.1.
- `allocateReceipt` receipts.ts = `withTx(allocateOnTx)`; `allocateOnTx` receipts.ts; route `POST /billing/receipts/:id/allocations` controller.
  1. `assertPaise`, amount > 0. 2. `lockInvoice` (FOR UPDATE). 3. Lock ALL receipts of the patient `order by id for update`. 4. `lockReceipt`.
  5. Checks: same patient, not entered-in-error, `over_allocation` invoice side and receipt side, `allocation_exceeds_advance`.
  6. Insert `allocations` (kind "apply"), event `paymentReceived`, `emitFeeStatusChanged` when invoice becomes settled.
- Reverse: `reverseAllocation` receipts.ts (`POST /billing/allocations/:id/reverse` controller).

### 3.3 Credit note — `issueCreditNote(db, actor, rawInput, now)` credit-notes.ts; route `POST /billing/invoices/:id/credit-notes` controller (`issueCreditNote`)
1. Zod parse; `loadBillingConfig`; for `clearance_discount`: `assertPaise` ask, load caps via tariff `loadRuleConfig` (outside tx).
2. `withTx`: `lockInvoice`; load lines and already-credited qty.
3. Kind `clearance_discount`: needs outstanding (`clearance_requires_outstanding`), cap `over_cap`, approval above threshold `clearance_approval_required` + `assertGrantedApproval`.
4. Kind `correction`: must cover the full remaining value of every line (`correction_must_exhaust`). Kind partial: per-line `creditShare` (owns `credit_exceeds_line`).
5. Rounding once on the note total by the INVOICE's rule (`roundTotalBy`). `nextDocNo "credit_note"`; insert `credit_notes` + `credit_note_lines`; event `creditNoteIssued`.
6. `restoreEntitlements` always; `releaseRedemptions` only for `correction`. `emitFeeStatusChanged` via "credit_note" when invoice has encounter.

### 3.4 Daily close — `runDailyClose(db, day?, now)` daily-close.ts; no HTTP route; scheduled at kernel/worker/jobs.ts (`DAILY_CLOSE_IST = "23:59"` kernel/worker/jobs.ts)
1. `targetDay = day ?? istDay(now)`; `loadBillingConfig`; `dayBook(db, day)`; `orphanScan` (limit 5000, daily-close.ts). All read-only, before the tx.
2. `withTx`: insert `daily_closes(day)` `onConflictDoNothing`. No row returned means already closed: return `claimed:false`, write nothing.
3. Append `chargeOrphanFlagged` per orphan, then `dayClosed` (system actor `DAILY_CLOSE_ACTOR`).
- Read-only preview of orphans: `chargeOrphans`, used by controller (comment in billing.controller.ts); do not call `runDailyClose` for that.

## 4. Invariants and traps
- Paise: all amounts are safe integers. `assertPaise` (from tariff) at every boundary: receipts.ts; credit-notes.ts; refunds.ts; sessions.ts; invoices.ts (`assertBoundaryPaise`). Add it to any new money input.
- Rounding (§170) is applied ONCE per document total, never per line share: credit-notes.ts. Credit note uses the invoice's own `roundingRule`.
- Idempotency: HTTP-level only, opt-in by `Idempotency-Key` header; no header = no protection (idempotency.ts). Claim insert `onConflictDoNothing`; failed work DELETES the claim so a corrected retry works; same key + different body = `idempotency_key_reused`; unfinished = `idempotency_key_in_progress`.
- Duplicate bill guard is separate from idempotency: encounter advisory lock + live-invoice check (invoices.ts). Do not move the check outside the tx.
- Lock order: invoice row first, then patient's receipts in one `order by id for update` statement, then the single receipt (`allocateOnTx` in receipts.ts, and the comment at the top of receipts.ts). Never lock receipt-then-set. `refunds.ts` and the other receipt writers in receipts.ts use the same statement.
- `lockInvoice` exists as THREE private copies: receipts.ts, credit-notes.ts, refunds.ts. Change locking in all three.
- Documents are immutable: receipts cannot be UPDATEd/DELETEd (trigger from migration 0012, per comment receipts.ts). Corrections = credit note, reversal allocation (`kind` + `reversalOfId`), or `markEnteredInError` (receipts.ts).
- Advance is a derived balance, never floored (`advanceOf`); allocation must not drive it negative (receipts.ts).
- Approvals: credit on unsettled remainder ALWAYS needs an owner-granted approval, cap no longer exempts (invoices.ts, comment owner ruling 2026-09-28); discount approvals bound to draft+line; clearance above threshold (credit-notes.ts); refunds ladder in refunds.ts (approval row locked `for update` refunds.ts).
- Cash: needs an open session of the ACTING cashier (`requireOpenSession`); `assertCashAccepted` can throw `cash_threshold_blocked`, whose audit event must be written in a second tx (invoices.ts, receipts.ts catch).
- Change given only against cash tender and only up to min(surplus, cash tendered): invoices.ts.
- Daily close is idempotent by primary-key claim on `daily_closes.day` (daily-close.ts); safe to re-run.
- Doc numbers: `nextDocNo` upserts series then increments in the caller's tx (series.ts); a rolled-back tx gives the number back.
- Other modules call `issueInvoice`/`issueCreditNote`/`requestRefund` with `tx as unknown as Db` so billing joins their tx (pharmacy/bill.ts, lab/desk.ts comment). Billing's `withTx` must stay nest-safe.
- Shared-file warnings from CLAUDE.md: `billing` is imported by most modules; a signature change in `index.ts` exports breaks every lane. After changing exports/routes run `node tools/arch/gen.mjs`.
- Money-route change owes the controller test census (`test/caddyfile-parity.test.ts` pins route counts).

## 5. Callers from other modules (non-test; function -> call site)
- opd: `registerFeeStatusHook` opd/opd.module.ts; `encounterFeeStatuses` opd/queue.ts, opd/prestage.ts, opd/encounters.ts; `newConsultFeePaise` opd/department-move.ts; `moveMoneyPlan`; `maySettleMoveDifference`; `carryMoneyToMovedVisit`. `withIdempotency` imported opd/walk-in.ts.
- pharmacy: `issueInvoice` pharmacy/bill.ts, pharmacy/retail.ts; `previewInvoice` pharmacy/bill.ts, pharmacy/retail.ts; `getInvoice` pharmacy/bill.ts, pharmacy/bill-rows.ts, pharmacy/print.ts, pharmacy/refund.ts, pharmacy/returns.ts, pharmacy/retail.ts; `issueCreditNote` pharmacy/refund.ts, pharmacy/returns.ts; `requestRefund` pharmacy/refund.ts, pharmacy/returns.ts; `releaseInvoiceSurplusOnTx` pharmacy/store-credit.ts; `advanceOf` pharmacy/store-credit.ts, pharmacy/credit-notes.ts; `receiptUnallocatedPaise` pharmacy/store-credit.ts; `invoiceSettlement` pharmacy/handover.ts; `patientBalance` pharmacy/patient-rail.ts; `invoiceLineCredits` pharmacy/leakage.ts, pharmacy/returns.ts; `creditedInvoiceLineIdsBetween` pharmacy/leakage.ts; `gstr1Summary` pharmacy/gstr3b.ts; `invoicesBetween`/`creditNotesBetween`/`invoiceLinesOf`/`invoiceHeadsByIds` pharmacy/sales-register.ts; `invoicePayments`/`refundVouchersPaidBetween` pharmacy/accounts.ts; `receiptAllocationsBetween` pharmacy/tally.ts; `billingDocumentByNo` pharmacy/activity.ts; `collectionsBlind` pharmacy/summary.ts, pharmacy/shift.ts; `cashierDay`/`listSessions`/`mayReadExpectedCash`/`liveExpectedCashPaise` pharmacy/shift.ts.
- lab: `issueInvoice` lab/desk.ts, lab/verify.ts; `previewInvoice` lab/lab-desk.controller.ts; `issueCreditNote` lab/money.ts, lab/sweeps.ts; `invoiceSettlement` lab/interlock.ts.
- radiology: `invoiceSettlement` radiology/held.ts, radiology/ready-on-payment.ts, radiology/reports.ts.
- ot: `previewInvoice` ot/bill.ts; `issueInvoice`; `requestRefund`; `receiptUnallocatedPaise` ot/deposit.ts; `advanceOf`.
- partners: `registerBenefitSourceProvider` partners/partners.module.ts; `invoiceAccrualView` partners/consumer.ts.
- kernel: `runDailyClose` kernel/worker/jobs.ts (imports `../../modules/billing/daily-close` directly, not via index).
- membership: no non-test call into billing found; it only uses billing in tests (entitlements, redemptions).
- `withIdempotency` also imported by pharmacy/lab/ot/radiology controllers (e.g. pharmacy/retail.ts, lab/lab-verify.controller.ts, radiology/place.ts, ot/ot-recovery.controller.ts).
