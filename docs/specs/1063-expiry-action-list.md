---
issue: 1063
status: built
approved: 2026-11-14
---
# SPEC — Weekly expiry action list: return, move, at risk, write off (#1063)

Status: APPROVED 2026-11-14 by the owner ("Yes, build" with the defaults).

## What

The pharmacy can already return a near-expiry or expired batch to its supplier inside the vendor's window
(`materials/supplier-returns.ts`, 90 days after expiry by default, near-expiry returnable any time inside 90 days
before) and write off the rest with the BMW manifest. Nobody is told on a schedule what to do this week, and stock
that will still be on the shelf at expiry is seen only when it is already near expiry. Source: P0 item 1 of the
pharmacy software study of 2026-11-14.

## Decisions (DECIDED by the agent unless marked)

- **Horizon.** Every batch with stock in PHARM-OPD and PHARM-RETAIL that has expired or expires within 180 days
  (the 6-month near-expiry rule). Loose and damage trays are included with their parent store.
- **One action per batch, first that applies:** Return (inside the supplier's window, real supplier only) ·
  Move (the other counter sold the item in the last 90 days and this store did not) · At risk (stock above what the
  last 90 days of sales at this store will use before the expiry month ends) · Write off (past the window, or
  opening/trial stock with no supplier). A batch with none of these is not listed.
- **Value** at the batch's cost per base unit; estimated-cost batches are marked as estimates.
- **The run** every Monday 07:00 IST and on "Run now". It drafts at most one open supplier return per vendor
  (source `agent`), adding new batches to that vendor's open draft rather than making a second; it never approves,
  dispatches or writes off. Move drafts a transfer only when a person taps it.
- **NDPS** batches (PHARM-NDPS or narcotic class) are listed apart, never drafted: their return and destruction follow
  the controlled register.
- **Page** "Expiring: act now" in the pharmacy office: four groups with counts and rupees, each batch with item,
  batch, expiry month, store, quantity, value, supplier and the action's button; last run, next run, batches
  checked, Run now. Right: the existing returns right (`materials.returns.manage`) to draft; anyone with office
  access to read.

## Done means

- **D1** A batch from a real supplier expiring in 60 days is listed under Return, and the Monday run puts it in a
  draft return for that supplier; a second run adds nothing twice.
- **D2** An expired batch past the supplier's window, and an opening-stock batch near expiry, are listed under Write
  off with their value, and no return is drafted for them.
- **D3** A batch at the walk-in counter that sold nothing in 90 days while the OPD desk sold the item is listed under
  Move, and tapping Move drafts a transfer of that batch to the OPD store.
- **D4** A batch expiring in 150 days whose stock is larger than 150 days of this store's sales is listed under At
  risk with the leftover quantity and its value.
- **D5** The page shows last run, next run and batches checked; Run now reruns and updates them.
- **D6** A narcotic batch is listed apart and never drafted.

## Built (2026-11-14)

Where the build is more precise than the text above:

- **Files.** List, run and Move: `apps/core/src/modules/pharmacy/expiry-actions.ts` (`expiryActionList`,
  `runExpiryActionsNow`, `runWeeklyExpiryActions`, `moveExpiryBatch`). The stock read and the one-draft-per-supplier
  writer are materials': `supplier-returns.ts` `expiryCandidates` and `topUpAgentReturns` (the existing draft writer,
  split from `createSupplierReturn` / `updateSupplierReturn`; no second writer). Page: `apps/web/src/screens/pharmacy-office/expiring.tsx`
  at `/pharmacy/office?view=returns&page=expiring`.
- **Routes.** `GET /pharmacy/office/expiry-actions` and `POST /pharmacy/office/expiry-actions/run` on
  `materials.returns.manage` (the returns page's own read right); `POST /pharmacy/office/expiry-actions/move` on
  `materials.stock.issue`, the transfer writer's own right (without it the page shows the move as text).
- **The run.** Scheduler job `runExpiryActions`, daily at 07:00 IST; it acts only when no run happened since the latest
  Monday 07:00 IST (so a missed Monday catches up the next morning). One transaction under an advisory lock. Its log is the
  event `expiry_actions.ran` (last run, trigger, batches checked, drafts): no table, no migration. A supplier whose open
  agent draft no longer resolves (stock sold since) is skipped and named in the log, never given a second draft.
- **Return** is `materials` `returnVerdict`: expired inside the vendor's window, near expiry within 90 days
  (`NEAR_EXPIRY_RETURN_DAYS`), or recalled; real supplier, owned stock only.
- **At risk** applies beyond those 90 days. Inside them, stock nobody takes back (opening, trial, donated) whose leftover
  the sales will not clear is **Write off** (D2). The leftover is FEFO per counter and item: the earlier-expiring batches
  sell first, at the counter's last-90-days rate, up to the last day of each batch's expiry month.
- **Move** is offered from a counter's main shelf only (not its loose tray), for unexpired stock; the target is the other
  counter's main store. A counter's loose and damage trays count in its sales.
- **Write off** also takes: expired stock with no supplier, recalled stock with no supplier, and the damage tray whatever its
  date (never returned, ruling 2026-10-03). The page's Write off opens the existing write-off sheet; an expiry write-off
  takes expired stock only, so an unexpired row says "At expiry".
- A batch on a live return or write-off is listed in that document's group with the document instead of an action.
  "Batches checked" counts every store batch inside the horizon, NDPS included; a batch whose stock is all reserved is
  checked but not listed.

