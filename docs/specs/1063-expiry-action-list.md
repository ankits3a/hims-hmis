---
issue: 1063
status: approved
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
