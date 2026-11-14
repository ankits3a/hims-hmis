---
issue: 1061
status: built
approved: 2026-11-14
---
# SPEC — Price check on every purchase line, unused supplier credit, purchase analysis (#1061)

Status: APPROVED 2026-11-14 by the owner ("go ahead with your recommendations"). Rulings: 0096.

## What

Until now a supplier delivery was captured with no look at what the hospital paid before. Only the PO receipt
quantity (2%) and the supplier bill against the GRN (1% / Rs 10) were checked, so a line bought well above last
month's rate posted as quietly as one bought at the usual rate. Source: P0 item 2 of the pharmacy software study
of 2026-11-14.

## Decisions

- **Where.** Every paid line of a supplier GRN (source `challan` or `consignment_challan`, from a real supplier),
  by both entry paths: the stock-entry invoice grid and PO receipt (`POST /materials/grns`). Opening stock,
  donations, free goods and zero-cost lines are never checked and never count as a past purchase.
- **Compared against (0096).** Cost per base unit, so a box of 100 compares with strips of 10, against (a) the
  item's last paid receipt from **any** supplier and (b) this supplier's contract rate in force. The line shows the
  last three receipts (date, supplier, rate) and the contract rate, and names a supplier who sold it cheaper.
- **Amber (0096).** More than **2%** above either reference. A difference of one paisa per base unit or less is
  rounding and never amber. When both references are exceeded, the line names the lower one. An item with no
  past receipt and no contract shows "first purchase".
- **Override (0096).** An amber line is captured only with a reason: MRP revised, scheme changed, urgent buy, or
  other (typed). The reason alone is enough; no second person. The reason, the reference rate and its kind are
  stored on the GRN line, and `grn.price_above_reference` is emitted for each such line.
- **Unused credit.** When the supplier has accepted credit notes not yet set off, the grid shows the unused
  amount at capture. It is still set off in the payment run, as before.
- **Report.** New office report "Purchase analysis": each amber line with reference rate, rate paid, extra rupees
  (rise per base unit × base quantity), reason, who and when; totals by supplier. Same right as the margin report.

## Done means

- **D1** An invoice line priced more than 2% above the item's last paid receipt shows amber with the last three
  receipts, and capture is refused until a reason is given.
- **D2** A line within 2% captures with no reason asked.
- **D3** The check is per base unit: a box-of-100 receipt and a strip-of-10 line compare correctly; an
  opening-stock GRN and a free line are never the "last receipt".
- **D4** A line above this supplier's contract rate is amber even when the last receipt was dearer.
- **D5** A PO receipt (`POST /materials/grns`) with an amber line is refused without a reason, as the grid is.
- **D6** An item with no past receipt and no contract captures as "first purchase", no reason asked.
- **D7** Capturing an invoice from a supplier with accepted, unspent credit shows the unused amount.
- **D8** The Purchase analysis report lists every amber line with reference, rate paid, extra rupees, reason and
  who, with per-supplier totals.

## Built (2026-11-14)

Built as specified; acceptance tests `spec #1061 D1`–`D8` in `apps/core/src/modules/pharmacy/acceptance/` and the
web half of D1 and D7 in `apps/web/src/screens/acceptance/`. Migration `0231_grn_price_check` (additive: four nullable
`grn_lines.price_*` columns and a check). Where the build is more precise than the text above:

- The check lives in `materials/price-check.ts` and runs inside `captureGrn`, so every path that captures a supplier
  GRN is covered. The refusal `price_reason_required` carries each amber line's index and check.
- The reference stored on the line is rounded to the paisa; a contract rate per unit may fall between two paise.
- The PO receipt screen shows the check after the server's refusal, under the line, with the reason picker; the
  stock-entry grid shows it while the invoice is typed.
- The report is `GET /pharmacy/office/reports/purchase-analysis`, by capture day (IST), cancelled GRNs left out.

