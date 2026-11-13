---
issue: 1047
status: approved
approved: 2026-11-13
---
# SPEC — Pharmacy stock-in go-live (#1047)

Status: APPROVED 2026-11-13 by the owner ("Both A and B"), after the pharmacy architecture review. Rulings: 0093.

## What

Production has no pharmacy stock on the books (#1034, #636). Real stock goes in by a batch-wise recount into the
stock-entry grid, then every delivery by GRN. This spec makes that path correct and fast for Indian supplier
invoices.

## Decisions

- **Pack correction.** An item's pack unit (for example the loader's default `strip10`) can be replaced by the real
  pack (`strip15`), under `materials.items.manage`, audited old → new. It is refused while any stock batch, ledger row
  or open PO line uses the old pack; then a new pack is added instead. (The review page said "with approval"; with no
  stock on the books an approval per item would mean 251 approvals, so the precondition replaces it.) The counter's
  pack is one rule shared by server and web: the item's issue pack, else its smallest pack above 1.
- **Cancel a captured GRN.** Before posting, a captured GRN can be cancelled with a reason, audited; it no longer
  counts against PO headroom. A posted GRN is unchanged (corrections go through returns and adjustments).
- **Invoice grid.** The stock-entry keyboard grid also receives supplier deliveries. Header: vendor (active), supplier
  invoice number and date (required), optional PO, store (any pharmacy store), and a rate basis switch: *rate without
  GST* (default) or *rate with GST* (cost is then divided by 1 + the item's GST rate). Rows: item, batch, MM/YY, packs,
  free packs, MRP, rate, discount. Free packs become the free line at zero cost. The capture prefills the supplier
  bill draft with the invoice number and date. Opening stock stays a mode of the same grid.
- **Standalone supplier credit.** A vendor credit note can be recorded without a return, kind `rate_difference`,
  `scheme`, `breakage` or `other`, with amount, GST and the supplier's reference; it sets off in the payment run like
  a return credit.
- **Recount mode.** The grid accepts an optional control file (item, quantity in base units) and shows, per medicine,
  entered against control, flagging any difference. The control file stays in the browser.
- **MRP revision.** A GRN line whose batch exists with a different MRP (same expiry month) is held as `mrp_revised`
  instead of refusing the whole GRN; posting it needs the materials head's approval, and on posting the batch takes
  the new MRP, audited old → new. A different expiry month still refuses (`batch_mismatch`).
- **Opening stock is a source, not a vendor.** Every opening-stock GRN, whichever supplier its row names, stays out of
  last-purchase prices, PO drafts, the unbilled-delivery list, manual supplier billing and the "purchases received"
  metric. (The #1048 fix keyed this on the opening vendor's code; a row naming a real supplier slipped through.)
- **Estimated cost (0093).** An opening-stock row with no rate gets cost per pack = MRP ÷ (1 + GST rate) × 0.80,
  rounded down to the paisa, and is flagged *estimated*; the stock valuation report shows estimated value apart.

## Done means

- **D1** An item with no stock has its `strip10` pack replaced by `strip15`; the same act is refused for an item whose
  batch uses the old pack; the desk and the server pick the same counter pack.
- **D2** A captured GRN is cancelled with a reason before posting and stops counting against its PO.
- **D3** A supplier invoice typed in the grid (invoice no. and date, MM/YY, a free-pack cell, rate with GST) posts the
  right stock and cost, and the supplier bill draft carries the invoice number and date.
- **D4** A rate-difference credit note is recorded without a return and sets off in the next payment run.
- **D5** With a control file loaded, the grid flags a medicine whose entered total differs from the control.
- **D6** The same batch arriving at a new MRP waits for approval, then posts, and the batch sells at the new MRP.
- **D7** An opening-stock row with no rate is valued at MRP without GST less 20% and shows as estimated.
