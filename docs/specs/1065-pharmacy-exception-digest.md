---
issue: 1065
status: built
approved: 2026-11-14
---
# SPEC — Daily owner exception digest for the pharmacy (#1065)

Status: APPROVED 2026-11-14 by the owner ("Yes, build"; answers in ruling 0097).

## What

Every pharmacy exception is already recorded (approvals, credit notes, adjustments, the leakage auditor in
`pharmacy/leakage.ts`, shift counts, the price check of #1061), but the owner must go and look. Source: P0 item 4 of
the pharmacy software study of 2026-11-14.

## Decisions

- **Items, one row each with a link to the record:** bill cancels and refunds; discounts approved above the
  pharmacist's 10% tier; stock adjustments, write-offs and approved MRP revisions; leakage mismatches (issued vs
  billed, consumption outside a sale); cash short or over at a blind shift count; purchase lines above the last price
  or contract (#1061); supplier credit notes accepted below our debit note; downtime (paper) sales entered later;
  (expiring stock not acted on joins the digest when #1063 is built, as a follow-up). Each row: what, rupees, who, when.
- **Page** "Exceptions" in the pharmacy office for any IST day, sorted by rupees, with totals by kind. Right: a new
  `pharmacy.exceptions.view`, given to the owner role.
- **Digest** at 08:00 IST for the previous day (ruling 0097): a phone-app notification to the owner only, with the
  count and total in rupees and no patient text, opening that day's page. Every exception is listed, biggest first;
  no threshold.
- A day with no exceptions sends nothing.

## Done means

- **D1** A refund, a 15% discount approved by the in-charge and an approved stock adjustment on one day each appear
  on that day's Exceptions page with rupees, who and a link; a 5% discount does not.
- **D2** A leakage mismatch and a shift count ₹40 short appear on the page.
- **D3** A purchase line captured with a price reason (#1061) appears with the extra rupees.
- **D4** The page sorts by rupees and totals each kind; without `pharmacy.exceptions.view` it is refused.
- **D5** At 08:00 IST the owner gets one notification with the count and total, opening that day's page; a day with
  no exceptions sends none.

## Built (2026-11-14)

- **Read model:** `apps/core/src/modules/pharmacy/exceptions.ts` `pharmacyExceptionsOn(db, day)`, computed on read
  (no table, no migration). Kinds: `refund` (live credit notes on a pharmacy bill, and pharmacy bills voided as
  entered in error), `discount` (granted in-charge/owner discount approvals), `stock_adjustment` (one row per posted
  line), `write_off`, `mrp_revision` (`batch.mrp_revised`; rupees = the change per pack), `leakage` (the auditor's
  mismatches at both counters, and consumption outside a sale at the batch's cost), `cash` (the last blind count of
  each drawer of a pharmacy-role cashier that day, short or over), `purchase_price` (#1061's analysis rows),
  `supplier_credit`, `downtime` (paper sales by entry time). Each row: kind, paise (a magnitude), who (the approver
  where an approval let it through), at (null for a leakage mismatch), what, link.
- **Page:** `GET /pharmacy/office/reports/exceptions?day=` (right `pharmacy.exceptions.view`, owner only); web
  Reports → Exceptions, `/pharmacy/office?view=reports&page=exceptions&day=YYYY-MM-DD`, yesterday by default
  (`apps/web/src/screens/pharmacy-office/exceptions.tsx`).
- **Digest:** worker job `sendPharmacyExceptionDigest`, `dailyIst("08:00")`: one bell row per holder of the owner
  role (kind `pharmacy_exception_digest`, ref `pharmacy_exceptions_day` = the day, key `pharmacy_exceptions:<day>`,
  so re-runs send nothing); `alert.raised` carries two integers (`figures`) and the phone relay says "Pharmacy: 7
  exceptions yesterday, ₹3,240" (Hindi too) under the `reminder` switch, link `pharmacyExceptions`; the phone app
  opens the web page. The bell row opens that day's page.
- **Counted once (follow-up):** a leakage line that day's listed credit notes explain (same dispense or sale, item and
  batch) is listed with `sameMoneyAs` = the refund row and left out of the count, totals and digest.
- **Links (follow-up):** each row carries its record's reference (`ref`) and the rights that open its link
  (`linkNeeds`); the page links a row only for a viewer holding one, else shows the reference as text. No right added.
