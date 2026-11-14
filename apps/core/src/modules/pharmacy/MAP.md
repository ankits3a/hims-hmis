---
type: module-notes
title: "pharmacy — module notes"
description: "Flows, invariants and traps of the pharmacy: the OPD dispense desk, the walk-in counter, stock in through materials, the legal registers, the IPD/ER seam and the copilot surface."
resource: apps/core/src/modules/pharmacy
tags: [pharmacy, materials, billing, formulary]
generated: { by: agent:claude, at: 2026-11-13 }
verified: []
stale_after: 2027-02-11
---
# pharmacy — module notes

Hand-written notes: the WHY and the traps. Signatures, routes and tables are generated in
`docs/architecture/modules/pharmacy.md`; read that for the public API. Paths are relative to
`apps/core/src/modules/pharmacy/` unless they start with a module name, `kernel/` or `scripts/`. Citations name a file
and a symbol or error code, never a line number. Update this file in the same PR when you change a flow, an invariant
or a trap below.

## 1. Purpose
The hospital pharmacy: the OPD dispense desk (an e-prescription or a paper slip becomes medicine in the patient's
hand), the walk-in retail counter, the back office (purchase, bills, returns, Tally/GST), and the legal registers
(H1, NDPS, pharmacist registration, ADR, cold chain, incidents, trays). The pharmacy FEDERATES and never owns: stock
lives in `materials` (one ledger), money in `billing`, the catalogue in `formulary`. Owner rulings: 0007, 0008, 0012,
0013, 0014, 0019, 0022, 0023, 0025, 0039, 0083.

## 2. Key files (owner of what)
- Dispense pipeline: `workflow-def.ts` (states), `consumers.ts` `handlePrescriptionIssued`, `queue.ts`
  (`enqueueDispense`, `listQueue`, `openOnDay`), `claim.ts` (`findAtCounter`, `claimDispense`), `verify.ts`
  (`verifyDispense`, `declineLine`, `cancelDispense`, `refusalsOf`), `pick.ts`, `bill.ts` (`billDispense`,
  `priceBatchLine`, `pharmacyFreeAt`), `handover.ts`, `returns.ts`, `refund.ts` (`cancelBilledDispense`),
  `takeover.ts`, `expiry.ts` (`sweepExpiredPicks`), `authorisations.ts` (allergy override to the prescriber),
  `paper-rx.ts` (`enterPaperPrescription`), `auto-match.ts`, `qty.ts` (`prefillQtyBase`), `scan.ts` + `gs1.ts`.
- Walk-in counter: `retail.ts` (`sellRetail`, `recordSale`, `enterPaperDispense` for downtime backfill, licence gate),
  `retail-returns.ts`. Downtime backfill has no file of its own; it lives in `retail.ts`.
- Money: `discount.ts` (tiers, `pharmacyRoundingRule`), `price.ts` (`priceBatchSale`, NPPA ceiling), `credit.ts`,
  `store-credit.ts` (0023, `pharmacy_credit_moves`), `shift.ts` + `summary.ts` (blind count), `tally.ts`, `gstr2b.ts`,
  `gstr3b.ts`, `sales-register.ts`, `leakage.ts`, `gst-slab.ts`.
- Stock-in helpers (stock itself is written by materials): `opening-stock.ts` (`planOpeningRows`,
  `captureOpeningStock`, `applyOpeningStock`), `stock-drug.ts` (`createStockDrug`), `price-list-import.ts`
  (`parsePack`), `purchase-drafts.ts`, `replenishment.ts` (`reorderAdvice`), `short-book.ts`, `loose-trays.ts`,
  `shelf-locations.ts`, `item-merge.ts`. `opening-stock.ts` and `stock-drug.ts` are not exported from `index.ts`.
- Law and safety: `controlled.ts`, `controlled-dispense.ts`, `controlled-office.ts`, `controlled-classify.ts`,
  `registers.ts` (H1), `pharmacists.ts` (`requireRegisteredPharmacist`), `adr.ts`, `cold-chain.ts`
  (`assertNoColdChainHold`), `incidents.ts`, `antimicrobial.ts` (Reserve steward), `trays.ts`.
- Messages: `messages.ts` (bill message, refill reminder, DLT template check).
- Agent surface: `copilot-tools.ts`, `desk-provider.ts`, `errors.ts` (`PHARMACY_ERROR_CODES`), `pharmacy-http.ts`
  (`PHARMACY_IDEMPOTENT_ROUTES`).
- Settings and constants: `settings.ts` (`quickDeskOn`), `config.ts` (store codes, `PICK_RESERVATION_MINUTES`,
  `SCHEDULED_FLAGS`, `REFUSED_FLAGS`, `DOWNTIME_BACKFILL_DAYS`).
- Web: `apps/web/src/screens/pharmacy-desk/` (the desk), `apps/web/src/screens/pharmacy-office/` (back office;
  `apps/web/src/screens/pharmacy-office/pages.ts` folds the old `/materials/*` screens into it),
  `apps/web/src/screens/pharmacy-retail.tsx`, `apps/web/src/screens/pharmacy-authorise.tsx`.

## 3. Stores
Seeded by `scripts/seed-pharmacy.ts`: `PHARM-OPD` (the desk), `PHARM-RETAIL` (walk-in, a separate shelf),
`PHARM-NDPS` (`CONTROLLED_STORE_CODE`, two-key cabinet), `IN-TRANSIT`, the OT consignment store, and loose/damage
child trays. Crash-cart trays are child stores with `attributes.tray`. There is NO central store, IP pharmacy or ward
store on main. `ER-SAT` exists only on the IPD integration branch.

## 4. Main flows

### 4.1 OPD dispense (state machine, `workflow-def.ts`)
Every move is a compare-and-set on `pharmacy_dispenses.status` plus a workflow transition. The user also needs role
`pharmacy` or `pharmacy_assistant` (`kernel/workflow/instances.ts`), else `role_denied`.

    queued -> claimed -> verified -> picked -> billed -> handed_over
       \________\___________\_________\--> cancelled      billed --(cancelBilledDispense)--> cancelled

- queued: `enqueueDispense`; P-number minted (`nextEpisodeNo("pharmacy_dispense")`, 0007). No stock effect.
- claimed: `claimDispense` lays out lines, prefills quantity (`qty.ts`), auto-matches a brand.
- verified: `verifyDispense` runs `refusalsOf` (allergy, interaction, duplicate, drug-disease) and
  `assertStewardApprovals`; needs a registered pharmacist unless quick desk is on; places the kernel medication order.
- picked: `pickDispense` calls `materials.reserveStock` per batch (FEFO via `materials.fefoPick`, loose tray first).
  Reservation lives `PICK_RESERVATION_MINUTES` (30); `sweepExpiredPicks` runs every 60 s and cancels the ticket.
- billed: `billDispense` calls `billing.issueInvoice` inside the same transaction (savepoint cast `tx as unknown as Db`).
- handed_over: `handOverDispense` consumes the reservation, completes order items, writes `pharmacy_reg_h1` rows and
  the controlled register. Schedule H/H1 needs `pharmacy.dispense.scheduled`, a registered pharmacist (unless quick
  desk) and an identity check: today's token, the phone's last four, or *collected by* (self, or an attendant with
  name and relation; `handover.ts` `HandoverIdentity`, #1046). Collected-by is refused on a ticket with a Schedule X
  or NDPS line.
- Entry paths: the `prescription.issued` consumer (idempotent on event id); the counter find (`rx1.`, `q1.`, `T-14`,
  UHID, name; a name never auto-selects); a paper prescription typed by the pharmacist (`paper-rx.ts`, writes a real
  `opd_prescriptions` row, opens a no-fee pharmacy visit).
- Re-issue: one live row per (prescription, version) via `pharmacy_dispenses_live_rx_ux` (rows with `balance_of` null);
  a newer version cancels only older rows still `queued`; a claimed older version answers `prescription_superseded`.
- Balance ticket (#1046): `pick.ts` writes `owed_qty_base` on a line picked short; for `BALANCE_WINDOW_DAYS` (30) from
  the prescription's first hand-over, `claim.ts` `openBalanceDispense` / `queue.ts` `enqueueBalanceDispense` create a
  dispense with `balance_of` = the source, holding only owed lines (one live balance per source,
  `pharmacy_dispenses_live_balance_ux`). Route `POST /pharmacy/dispenses/:id/balance`.
- Bill seam: `bill.ts` passes `oneInvoicePerDocument` to `billing.issueInvoice`, which skips the FD-27
  encounter + service check (`liveInvoiceCharging`); one bill per dispense is the picked→billed compare-and-set.
- Added by hand (#1055, ruling 0094): `add-line.ts` `addDispenseLine` (`POST /pharmacy/dispenses/:id/lines`, idempotent
  key `addLine`, event `dispense.line_added`) adds a line while the dispense is claimed, verified or picked, for reason
  `not_prescribed` or `paper`; any schedule except X and NDPS. It runs the same four checks verify runs; after verify also
  the steward gate and the registered-pharmacist check (stood down in quick desk); on a picked ticket it is held FEFO at
  once (`pick.ts` `fefoParts`, `splitCopyOf`). The `added_*` columns on `pharmacy_dispense_lines` carry who, when, why
  and (paper) the slip document and prescriber; an H1 line added as not prescribed writes `NO_PRESCRIPTION_PRESCRIBER`
  in the H1 register. A line added after verify has no kernel order item (the kernel cannot add one to a placed order).
- Desk layout (#1055): two columns like Desk One (`aside` 296 px + work); the queue (`QueueList`) sits under the find
  box; the bill column `.pd-billcol` (296 px) opens only at `picked` or `billed` and closes after hand-over; on a phone
  the line's tab becomes Bill only then. The find box uses Desk One's `.in` look (1px line border at rest, green ring on
  focus, no Find button).
- Printing: the desk that takes the money prints the bill (`POST …/print {documents}`); hand-over sends labels only.
  `print.ts` heads the bill with the pharmacist's registration and the D.L. No. (`retail.ts` `licenceOnBill`).

### 4.2 Walk-in counter (`retail.ts`)
Licence gate (`retail_licence_missing` / `_lapsed`, Form 20/21) -> cart (max 50 lines; Schedule X and every NDPS class
refused; one batch must cover the line or `short_stock`) -> preview (writes nothing) -> `recordSale` in one
transaction under `withIdempotency`: buyer is always a registered patient, cold-chain hold, restricted antimicrobial
refused, H/H1 needs an outside prescription with photo and a registered pharmacist (quick desk is NOT consulted
here), allergy or severe interaction refuses with no override, stock via `postMovements`, invoice via `issueInvoice`,
H1 row, `retail.sold`. Returns: sealed pack, 7 days, at least 30 days of shelf life; a cut strip goes to a tray.

### 4.3 Stock in (all writes are materials')
- Opening stock: `opening-stock.ts` (sheet or keyboard grid, `apps/web/src/screens/pharmacy-office/stock-entry.tsx`;
  `judgeRow` is the one row judgement) -> GRN capture with source `opening_stock` (`OPENING_STOCK_SOURCE`, kept out of
  purchasing whatever supplier a row names), store fixed to PHARM-OPD -> normal QC and post. Batch, MM/YY expiry, MRP per pack, pack size
  and packs are required; whole sheet or nothing; same file hash captures once.
- GRN: `materials/grn.ts` `captureGrn` -> `runGateQc` (`materials/qc.ts` `qcLine`) -> `postGrn`, the ONLY GRN-side
  stock writer. Against a PO: `assertReceivableAgainstPo`, received qty <= ordered + 2%; the PO approver may not
  capture or post. Two-person QC is a setting (`grnQcNeedsSecondPerson`, off by default, 0019).
- Supplier money: `materials/supplier-bills.ts` (three-way match, 1% / Rs 10 tolerance, held bill needs another
  person) -> `materials/payments.ts` (payment run, owner approval, a different person pays; MSME 45 days).
- Movement: `materials/transfers.ts` via IN-TRANSIT (receiver differs from issuer), `materials/indents.ts`, counts
  (`materials/counts.ts`, blind) -> adjustments (MS approval), returns to vendor (`materials/supplier-returns.ts`),
  destruction (`materials/write-offs.ts`, BMW manifest).
- Supplier invoice in the grid (#1047): `opening-stock.ts` `planSupplierInvoice` / `captureSupplierInvoice` take a
  header (vendor, invoice no. and date, optional PO, store from `invoiceStores` = PHARM-OPD or PHARM-RETAIL, rate with
  or without GST via `rateWithoutGstPaise`); the invoice no./date become the GRN's challan and `invoice_date`, and
  prefill the supplier bill. The same invoice number twice answers `invoice_already_captured`.
- Corrections (#1047): `materials/items.ts` `replaceItemUom` (refused `pack_in_use` while any batch, GRN line or open
  PO line uses the pack); `materials/grn.ts` `cancelGrn` before posting (`already_received` after). A counted strip
  size the item lacks becomes the counter's pack (`opening-stock.ts` `putCountedPack`, sheet, grid and invoice): it
  replaces the item's counter strip through `replaceItemUom`, or, on `pack_in_use`, is added and the old strip loses
  `isIssueUom` (`materials` `setIssueUom`); one strip size per item in a sheet (`judgeRow`). MRP revision:
  `materials/qc.ts` verdict `mrp_revised` -> `requestMrpRevisionApproval` (type `materials_mrp_revision`, materials head) ->
  `postGrn` refuses `mrp_revision_unapproved` until granted, then `findOrCreateBatch` reprices the batch and emits
  `batch.mrp_revised`. `materials/supplier-returns.ts` `recordStandaloneCredit` (rate_difference, scheme, breakage,
  other) sets off in the payment run like a return credit.
- Price check (#1061, 0096): `materials/price-check.ts`. `captureGrn` judges every paid line of a `challan` or
  `consignment_challan` GRN from a real supplier, per base unit, against the item's last paid receipt (any supplier,
  `purchaseHistoryByItem`: posted, accepted, not free, not opening stock or donation) and this supplier's contract
  (`contractRatesFor`). More than 2% above either (`PRICE_CHECK_THRESHOLD_BPS`; 1 paisa per unit is rounding) refuses
  `price_reason_required` with `detail.lines[{ index, check }]` until the line carries `priceReason` (mrp_revised,
  scheme_changed, urgent_buy, other + words); the reference and reason go on `grn_lines.price_*` and
  `grn.price_above_reference` is emitted. `planSupplierInvoice` returns each row's `priceCheck` and the supplier's
  `unusedCreditPaise` (`vendorCredits`). Office report `GET /pharmacy/office/reports/purchase-analysis` (margin right)
  lists the amber lines with extra rupees. Web: `apps/web/src/screens/pharmacy-office/price-check-note.tsx` under the
  grid row and on `apps/web/src/screens/materials-grn.tsx`.
- Estimated cost (0093): a blank opening rate costs `estimatedPackCostPaise` = MRP / (1 + GST) x 0.80, flagged
  `estimated_cost` on the GRN line and the batch; `materials/reports.ts` `stockValuationAt` reports known and
  estimated value apart. An explicit 0 stays zero cost.
- Expiry action list (#1063): `expiry-actions.ts` `expiryActionList` (computed on read) sorts every batch of PHARM-OPD
  and PHARM-RETAIL (trays with their counter) expiring within `EXPIRY_ACTION_HORIZON_DAYS` (180) or expired into one
  action: Return (inside the supplier's window) · Move (the other counter sold it in `EXPIRY_SALES_WINDOW_DAYS`, this
  one did not; main shelf only) · At risk (more than 90 days out, leftover after FEFO sales, `fefoLeftovers`) · Write off
  (past the window, no supplier, damage tray). NDPS apart, never drafted. `runWeeklyExpiryActions` (job, daily 07:00
  IST, acts once per Monday-07:00 window, `nextExpiryRunAt`) and `runExpiryActionsNow` top up ONE open agent draft per
  supplier (`materials/supplier-returns.ts` `topUpAgentReturns`, actor `EXPIRY_RUN_ACTOR`) under an advisory lock; a
  supplier whose draft no longer fits the stock is skipped and logged. Run log = event `expiry_actions.ran`.
  `moveExpiryBatch` drafts a transfer (`materials.stock.issue`). Page `?view=returns&page=expiring`. The returns
  page's older "Make the drafts" (`draftSupplierReturns`) still makes a new draft per supplier and includes NDPS.
- The counter pack is one rule: `@hmis/contracts` `counterPackOf`, used by `bill-rows.ts` `counterPacks` and the web
  desk's `packOf`. Drug expiry is a month (#1048): `@hmis/contracts` `expiryFromLabel`, `monthEndOf`,
  `sameExpiryMonth`.

### 4.4 IPD and Emergency (on the IPD integration branch only, not on main)
IPD (the ipd module's eMAR `issueMed`) consumes straight from PHARM-OPD to the patient and charges at ISSUE
(`postDrugIssueChargesIn`, priced by this module's `priceBatchLine`). ER (the emergency module's `issueErMed`) consumes
from ER-SAT and prices through materials, a third price door. Neither uses indents, transfers or reservations, and this
module has no view of either. Decision 0012: ward issue, ward returns, IP bill and MAR wait for IPD.

### 4.5 Owner exception digest (#1065, ruling 0097)
`exceptions.ts` `pharmacyExceptionsOn(db, istDay)` computes on read one day's exceptions from the records that already
hold them: refunds and cancels, discounts approved above 10%, stock adjustments, write-offs, MRP revisions, leakage
mismatches (`leakage.ts`; a mismatch a listed refund explains stays on the page but is counted once, under Refunds),
blind-count cash short/over (pharmacy-role drawers, the day's last count), purchase lines above reference (#1061),
supplier credit below our debit note, paper sales entered late. Rupees always positive, sorted biggest first; "who"
is the approver where an approval let it through. Each row carries its own reference and the rights that open its
target screen; the page links only when the viewer holds one (no right was added to the owner). Page
`officeExceptions` (`apps/web/src/screens/pharmacy-office/pages.ts` key `exceptions`), right `EXCEPTIONS_VIEW` = `pharmacy.exceptions.view`, owner role only.
`sendPharmacyExceptionDigest` (08:00 IST job) raises one bell notice per owner-role user, keyed by the day (alert kind
`pharmacy_exception_digest`, ref type `pharmacy_exceptions_day`), sent to phones by the existing relay in category
`reminder`; the phone builds the sentence from `Notice.figures` (`kernel/push/phone-push.ts` `figureSentence`), so no
patient text leaves. A day with none sends nothing. Expiring stock (#1063) is not in it yet.

## 5. Invariants (do not break)
- `stock_balances` is never negative (CHECK + ordered lock in `materials/ledger.ts` `postMovements`).
- `pharmacy_reg_h1` and the controlled stock register refuse UPDATE/DELETE by trigger.
- Loose-MRP (0008): a full strip bills exactly at MRP; a loose unit at the share rounded DOWN; never above MRP.
  `bill.ts` `priceBatchLine` is the single pricing path for both counters.
- Cash rounding (0019): any cash in the tender rounds half-up to the rupee; UPI/card alone are exact.
- Discount tiers (`discount.ts`): <=10% pharmacist, <=25% in-charge, above or > Rs 25,000 owner; the requester never
  approves their own ask; the approval binds to the draft, value, patient and amount.
- Only the owner issues credit (0013); the cashier never sees expected cash before counting (0014).
- Quick desk (0022) stands down exactly three checks: `prescription_required`, `pharmacist_not_registered` (verify and
  scheduled hand-over), `slip_not_confirmed`. Do not widen it without a new ruling.
- Fee switch (0083): read at dispense creation / sale time; every line keeps MRP with a 100% discount;
  `assertFreeTakesNoMoney`.
- Schedule X is refused at every gate; NDPS stock lives only in PHARM-NDPS (`materials/controlled.ts`).

## 6. Traps (measured 2026-11-13; owed work is tracked as GitHub issues, not here)
- An unclaimed balance ticket's queue row still lists every drug of the prescription, not only the owed ones.
- `sweepExpiredPicks` spares a picked ticket while a discount or credit approval bound to it (subject = the dispense,
  same patient) is pending, and renews its hold through `materials.renewReservations` (#1048). An approval nobody
  decides holds the stock until it is decided or the pharmacist cancels. A ticket waiting only on the patient's cash
  is still cancelled at 30 minutes; redoing it mints a new P-number.
- `declineLine` works in claimed, verified and picked (#1046); in picked it releases the line's reservations, and the
  last line cancels the ticket. After `billed` only the return path remains.
- The web mints a fresh idempotency key for each claim, verify and pick attempt; only bill and hand-over reuse a
  stable key (`apps/web/src/screens/pharmacy-desk/pharmacy-desk.tsx` `keyFor`).
- Brand swap on an H/H1 line needs the prescriber (0093, #1046): `verify.ts` `swapNeedsPrescriber`,
  `authorisations.ts` `swapToAsk` (book `substitution`), refusal `substitution_needs_prescriber`. OTC keeps patient
  consent. `auto-match.ts` filling a GENERIC line with a stocked brand is not a swap and needs no agreement.
- `enterPaperDispense` (downtime) is not linked to the queued e-Rx ticket for the same prescription: double dispense.
- Cost is integer paise per base unit, floored (`costPerBase`), and a batch keeps its first receipt's cost.
  Free goods are a zero-cost line; their cost is not spread over the paid packs.
- NDPS custody keys on `items.storage_class`: `materials/controlled.ts` `planCustody` refuses a narcotic-class item
  entering a non-cabinet store, but an item not yet classified slips into PHARM-OPD. Desk gates read the formulary
  NDPS class instead, so both must be classified before stock goes in.
- An item with no GST slab sells as exempt (`gstCategoryFor(null)`); only standup row `pharmacy_gst_slab_set` notices.
- `listQueue` has no limit; untouched tickets stay `QUEUED_CARRY_DAYS` (3) and every desk polls it.
- The desk's split is cash + UPI only; the walk-in counter takes cash + UPI (#1046); UPI has no pending state.
- `GET /pharmacy/retail/sales` omits `netPaise` for a caller who is collections-blind (`collectionsBlind`, as
  `summary.ts` `counterSummaryFor` does; #1048). Amounts still reach a seller through the sale detail, the list's
  Print bill and the downtime list.
- `copilot-tools.ts` `stock_on_shelf` reads PHARM-OPD only.
- `shelf.ts` `shelfByMedicine` keeps ONE item per formulary medicine (the medicine may be a generic, so several brands
  per medicine are legitimate): the item with the most sellable stock over all stores, tie -> lowest code. The counter
  search (`retail.ts` `searchShelfAt`, behind `searchCounterShelf` / `searchRetailShelf`, paper-Rx, resolve and copilot)
  lists every item of a medicine, best-stocked AT THE SEARCHED STORE first, each with its own name and code; it is the
  union of name/code matches then salt matches (a name the formulary resolves to one product is not widened); walk-in and
  downtime lines carry an optional `itemId` (refused `unknown_sale_item` unless it is a sale item of that medicine);
  `claim.ts` takes the shelf's choice and `verify.ts` keeps the line's own item while it is still valid.
- `sale-items.ts` `registerSaleItem` refuses an item with no GST slab (`gst_slab_unknown`), so nothing new goes on
  sale as exempt by omission; items already on sale with a blank slab still bill as exempt.
- The desk's tender starts on Cash with the cash field at the exact payable (`apps/web/src/screens/pharmacy-desk/bill.tsx` `BillRail`).
- 'Rate with GST' invoices draft the supplier bill up to a paisa per pack short (per-pack paise rounding;
  `supplier_bill_lines_money_ck` forces taxable = packs x rate); within the match tolerance. Tracked as #1053.
- The store is a constant, not a parameter: `claimDispense` and `planOpeningRows` use `OPD_PHARMACY_STORE_CODE`
  although `pharmacy_dispenses.store_resource_id` exists.
- On the IPD integration branch, IPD and ER issues call `postMovements` directly and skip what a hand-over does:
  the cold-chain hold, the H1 register, the last-gate expiry check. An IPD narcotic order has no cabinet stock path.

## 7. Agent surface
- Copilot intents (`copilot-tools.ts`, registered via `manifest.ts` `copilotTools`): reads `stock_on_shelf`,
  `paid_not_collected`; drafts `draft_short_book_entry`, `draft_purchase_orders`, `draft_payment_run`,
  `draft_supplier_returns`, `find_duplicate_items`. No `act` tool: the kernel propose/confirm path
  (`kernel/copilot/act.ts`) is unused here, and the short-book confirm is a plain POST with no `copilot_acts` row.
- Desk card `pharmacy.authorisations` (`desk-provider.ts`) puts allergy overrides on the prescriber's desk.
- Refusals are a closed code list with structured `detail` (`PharmacyError`), but no `fix` field.
- Idempotency is an optional header; only `PHARMACY_IDEMPOTENT_ROUTES` take it. Not idempotent: take-over, decline,
  cancel, confirm-slip.
- Non-user actors are refused at `kernel/auth/guards.ts`; there is no agent-callable API outside the copilot chat.

## 8. Constants worth knowing
`config.ts`: `PICK_RESERVATION_MINUTES` 30, `SCHEDULED_FLAGS` H/H1, `REGISTER_FLAGS` H1, `REFUSED_FLAGS` X,
`DOWNTIME_BACKFILL_DAYS` 7. `materials/config.ts`: near-expiry 6 months / 75% of shelf life, PO head limit Rs 50k,
receipt tolerance 2%, bill tolerance 1% / Rs 10, purchase price check 2% (0096), MSME 45 days. `opening-stock.ts`: `OPENING_MAX_ROWS` 2000. `config.ts` (#1063): `EXPIRY_ACTION_HORIZON_DAYS` 180,
`EXPIRY_SALES_WINDOW_DAYS` 90, `EXPIRY_ACTIONS_IST`.
`scripts/standup-check.ts` holds the pharmacy readiness rows. `pharmacist_council_number` is red while every current
registration is a TRIAL placeholder (`pharmacists.ts` `isTrialRegistration`, shared with `office-needs.ts`);
`pharmacist_registration_not_lapsing` still counts a TRIAL registration as current.
