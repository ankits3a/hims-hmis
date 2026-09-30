# Board notes · Billing back office · /billing/office · draft for approval · 28-Sep-2026

Grounded in origin/main f9f87500 (`apps/web/src/screens/billing-office.tsx`, `billing.controller.ts`, `refunds.ts`, `recon.ts`) and PR #358 (open).

## What changes and why
- **Five filter-style tabs → one ranked list.** "Needs you today" pulls vouchers to pay, refunds awaiting approval, settlement mismatches, unbilled visits, downtime paper receipts, a missing statement and the GSTR-1 due date into one list, most urgent first, with source chips (PAY · APPROVE · RECON · UNBILLED · DAY BOOK · GSTR-1).
- **Pages move into the header menu** (Refunds, Receipts, Reconciliation, Day book, GSTR-1, Unbilled visits): no sidebar, no tabs. Forms (request refund, void receipt, upload statement) become menu entries, not blocks above the work.
- **At 390 the vouchers were below two forms.** On the phone the list is the page, vouchers at the top; an opened voucher stacks its steps and pins "Pay" at the thumb.
- **Black-and-neutral → Paper & Pine**: same tokens, header, chips, left lane and pinned act as the approved pharmacy office board.
- **Unbilled visits get their own date/time and a way out**: "Raise the missing bill" (new).
- **Voucher pay is a numbered flow**: requested → approved → issued → who takes the money (name, ID type, ID number typed once, never shown back) → which drawer → print. Guard flags stay visible, never block.
- **Money reads as money**: ₹ 2 decimals, 28-Sep-2026 dates, printed numbers and UHIDs; no paise, ids or enum words. Builds on #358.
- **No credit act** anywhere on this screen (owner ruling 28-Sep-2026: credit is the owner's).
- Responsive: 1100–1280 the Today list becomes a right drawer; below 1100 the nav folds behind a Menu button.

## Needs server
1. **One ranked "needs you" feed for billing** (`GET /billing/office/today` or similar): vouchers `issued` not `paid`, pending `billing_refund` approvals, `mismatched` tenders, charge orphans for today/yesterday, degraded receipts in the day book, missing settlement statements, GSTR-1 due date — with age and patient name/UHID.
2. **Refunds awaiting approval in the office list**: `/approvals` exists but needs `approvals.requests.read` and is not billing-scoped or named.
3. **Resolve a settlement mismatch**: no endpoint today (mismatch is read-only). Needs dispute / accept-as-bank-charge-with-reason / re-upload outcomes, audited, and a day-book line for bank charges.
4. **"Statement not uploaded" detection**: count of captured UPI/card tenders for a settled day with no upload batch.
5. **Raise the missing bill from an unbilled visit**: orphan rows carry `encounterId/visitNo/visitType/serviceDate` only — needs patient name/UHID, visit time, doctor ID, and a route (or deep link to the billing desk) that issues the invoice for that visit's fee service.
6. **"Someone else collects" relation on a voucher payee** (payee relation field) — optional.
7. Per-page paths under `/billing/office/*` with redirects from the old tab state (web only).

## Questions for the owner (money)
1. **Short settlements**: may the billing manager accept a bank short-payment as a charge, and up to what amount per receipt (suggested ≤ ₹50.00, above that to you)? Or must every difference be disputed?
2. **Large refunds**: every refund is approved by the billing manager today. Should refunds above an amount (suggested ₹25,000.00) come to you, as credit does?
