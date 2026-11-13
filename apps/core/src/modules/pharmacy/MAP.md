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
  desk) and an identity check (today's token or the phone's last four).
- Entry paths: the `prescription.issued` consumer (idempotent on event id); the counter find (`rx1.`, `q1.`, `T-14`,
  UHID, name; a name never auto-selects); a paper prescription typed by the pharmacist (`paper-rx.ts`, writes a real
  `opd_prescriptions` row, opens a no-fee pharmacy visit).
- Re-issue: one live row per (prescription, version) via `pharmacy_dispenses_live_rx_ux`; a newer version cancels only
  older rows still `queued`; a claimed older version answers `prescription_superseded`.

### 4.2 Walk-in counter (`retail.ts`)
Licence gate (`retail_licence_missing` / `_lapsed`, Form 20/21) -> cart (max 50 lines; Schedule X and every NDPS class
refused; one batch must cover the line or `short_stock`) -> preview (writes nothing) -> `recordSale` in one
transaction under `withIdempotency`: buyer is always a registered patient, cold-chain hold, restricted antimicrobial
refused, H/H1 needs an outside prescription with photo and a registered pharmacist (quick desk is NOT consulted
here), allergy or severe interaction refuses with no override, stock via `postMovements`, invoice via `issueInvoice`,
H1 row, `retail.sold`. Returns: sealed pack, 7 days, at least 30 days of shelf life; a cut strip goes to a tray.

### 4.3 Stock in (all writes are materials')
- Opening stock: `opening-stock.ts` (sheet or keyboard grid, `apps/web/src/screens/pharmacy-office/stock-entry.tsx`) -> GRN capture under the
  `OPENING-STOCK` vendor, store fixed to PHARM-OPD -> normal QC and post. Batch, MM/YY expiry, MRP per pack, pack size
  and packs are required; whole sheet or nothing; same file hash captures once.
- GRN: `materials/grn.ts` `captureGrn` -> `runGateQc` (`materials/qc.ts` `qcLine`) -> `postGrn`, the ONLY GRN-side
  stock writer. Against a PO: `assertReceivableAgainstPo`, received qty <= ordered + 2%; the PO approver may not
  capture or post. Two-person QC is a setting (`grnQcNeedsSecondPerson`, off by default, 0019).
- Supplier money: `materials/supplier-bills.ts` (three-way match, 1% / Rs 10 tolerance, held bill needs another
  person) -> `materials/payments.ts` (payment run, owner approval, a different person pays; MSME 45 days).
- Movement: `materials/transfers.ts` via IN-TRANSIT (receiver differs from issuer), `materials/indents.ts`, counts
  (`materials/counts.ts`, blind) -> adjustments (MS approval), returns to vendor (`materials/supplier-returns.ts`),
  destruction (`materials/write-offs.ts`, BMW manifest).

### 4.4 IPD and Emergency (on the IPD integration branch only, not on main)
IPD (the ipd module's eMAR `issueMed`) consumes straight from PHARM-OPD to the patient and charges at ISSUE
(`postDrugIssueChargesIn`, priced by this module's `priceBatchLine`). ER (the emergency module's `issueErMed`) consumes
from ER-SAT and prices through materials, a third price door. Neither uses indents, transfers or reservations, and this
module has no view of either. Decision 0012: ward issue, ward returns, IP bill and MAR wait for IPD.

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
- H/H1 hand-over needs a token or the phone's last four (`handover.ts`, `identity_confirmation_required`). A paper
  pharmacy visit has no token and a phone is optional at registration, so a paid ticket for a phone-less patient
  cannot be handed over; the only exit is cancel + refund.
- One dispense per prescription version, ever: `pharmacy_dispenses_live_rx_ux` excludes only `cancelled`, so a
  `handed_over` row blocks a follow-on dispense ("rest tomorrow" balance). Partial pick with a reason works
  (`isPartial`) but nothing records the owed balance.
- The FD-27 duplicate-bill guard (`billing/invoices.ts` `liveInvoiceCharging`) is per encounter + service, and each
  sale item is its own service. It bites when a re-issued prescription version on the SAME visit carries a medicine
  already billed. A second paper prescription opens a new pharmacy visit (`paper-rx.ts`), so it escapes the guard.
- `sweepExpiredPicks` cancels a picked ticket after 30 minutes even while it waits on a discount/credit approval or
  the patient's cash; redoing it mints a new P-number.
- `declineLine` works only in claimed/verified; dropping one line at the bill means cancelling the ticket.
- The desk prints the bill only after hand-over (`apps/web/src/screens/pharmacy-desk/paper.tsx`), so a patient who
  has paid and waits holds no paper.
- The web mints a fresh idempotency key for each claim, verify and pick attempt; only bill and hand-over reuse a
  stable key (`apps/web/src/screens/pharmacy-desk/pharmacy-desk.tsx` `keyFor`).
- Brand substitution on an H/H1 line needs only the patient's consent (`substitutable` excludes only Schedule X).
- `enterPaperDispense` (downtime) is not linked to the queued e-Rx ticket for the same prescription: double dispense.
- `materials/grn.ts`: no edit or cancel of a captured GRN (captured GRNs also count in PO headroom);
  `findOrCreateBatch` throws `batch_mismatch` when the same batch arrives with a different expiry day or MRP (GRN date
  picker vs the sheet's month-end, MRP revisions).
- `materials/qc.ts` `qcLine`: a near-expiry verdict returns early and skips MRP-required, MRP >= cost, the DPCO
  ceiling, recall-frozen and consignment-agreement checks.
- Pack units can be added, never retired or corrected (`materials/items.ts` has only `addItemUom`). Server and web
  disagree on "the pack": `bill-rows.ts` `counterPacks` takes the smallest multiplier above 1,
  `apps/web/src/screens/pharmacy-desk/work.ts` `packOf` the largest.
- Cost is integer paise per base unit, floored (`costPerBase`), and a batch keeps its first receipt's cost.
  `planOpeningRows` accepts a zero cost and only counts it (`zeroCost`).
- The fast keyboard grid (`apps/web/src/screens/pharmacy-office/stock-entry.tsx`) is wired to opening stock only;
  a supplier delivery goes through the slow card form `apps/web/src/screens/materials-grn.tsx`.
- The `OPENING-STOCK` vendor is not excluded from last-purchase pricing, PO drafts or `unbilledGrns`.
- NDPS custody keys on `items.storage_class`: `materials/controlled.ts` `planCustody` refuses a narcotic-class item
  entering a non-cabinet store, but an item not yet classified slips into PHARM-OPD. Desk gates read the formulary
  NDPS class instead, so both must be classified before stock goes in.
- An item with no GST slab sells as exempt (`gstCategoryFor(null)`); only standup row `pharmacy_gst_slab_set` notices.
- `listQueue` has no limit; untouched tickets stay `QUEUED_CARRY_DAYS` (3) and every desk polls it.
- The walk-in screen takes one tender only; the desk's split is cash + UPI only; UPI has no pending state.
- `GET /pharmacy/retail/sales` returns `netPaise` per row to the seller before her drawer is counted (0014 tension).
- No bill prints the drug licence number; the server bill (`print.ts`) omits batch and expiry.
- `copilot-tools.ts` `stock_on_shelf` reads PHARM-OPD only.
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
receipt tolerance 2%, bill tolerance 1% / Rs 10, MSME 45 days. `opening-stock.ts`: `OPENING_MAX_ROWS` 2000.
`scripts/standup-check.ts` holds 25 pharmacy readiness rows; none checks that the pharmacist registration is real
rather than the TRIAL one (0008).
