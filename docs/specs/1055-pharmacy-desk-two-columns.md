---
issue: 1055
status: built
approved: 2026-11-13
---
# SPEC — Pharmacy desk in two columns, the bill column only at billing, and medicines added by hand (#1055)

Status: APPROVED 2026-11-13 by the owner ("Yes, build it"). Rulings: 0094.

Owner 2026-11-13: "change the Pharmacy dashboard from 3 column to 2 column, just like OPD counter screen. 3rd column will
only happen when drugs are added to the list and billing needs to be done"; "296 px like Desk One, keep bill open until
hand-over and allow manual addition of drugs to the list even if the drug is not prescribed by the doctor or doctor has
written on paper but is not fed in the system."

## What

The desk keeps Desk One's frame: the person in hand on the left (296 px), the work on the right. The queue stops being a
fixed right column; with nobody in hand it sits under the search, and Q opens it any time. A third column, the bill
(296 px), opens only when the ticket has at least one medicine to bill and every line is settled; it stays open through
payment until hand-over, then closes. Staff can add a medicine to the ticket by hand.

## Decisions

- "Settled" = ticked, given short with a reason, or dropped. Lines stay editable from their ⋯ while the bill is open;
  the bill re-totals.
- Adding a medicine by hand ("+ Add a medicine", key A), two reasons:
  - **Not prescribed:** any schedule except Schedule X and narcotics (owner ruling 0094). An H1 line added this way is
    written to the H1 register with "no prescription — added at the counter" in place of the prescriber.
  - **The doctor wrote it on paper:** any schedule except X and narcotics; Schedule H needs a photo of the slip unless
    quick desk mode is on (0022); H1 also needs the prescriber's name and registration number, as the paper-prescription
    path does today.
  - Allergy, interaction and duplicate checks run on an added line as on a prescribed one. The line shows "added at the
    counter by <name>" on the ticket, the bill and the audit trail.
- Phone: Ticket and Day tabs while collecting; the Bill tab appears when the bill column would.
- Everything else on the desk (keys, refusals, holds, registers, printing) is unchanged.

## Done means

- **D1** With nobody in hand the desk has two columns (296 px rail + main); the queue is listed under the search; there
  is no right column.
- **D2** With a ticket in hand and any line unsettled there is no bill column; the ticket's foot shows "n of m settled"
  and the running total.
- **D3** When every line is settled and something is to be billed, a 296 px bill column opens with the payment controls.
- **D4** After payment the bill column stays open, showing paid and the printed bill, until hand-over; after hand-over
  the desk is back to two columns.
- **D5** "Add a medicine" adds a Schedule H medicine as "not prescribed" and another as "the doctor wrote it on paper"
  (with the slip photo unless quick desk mode is on); Schedule X and narcotics are refused; each added line is marked
  "added at the counter by <name>" with its reason on the ticket and the bill.
- **D6** On a phone the Bill tab appears only when the bill column would.

## Built

Built 2026-11-13 on lane `pharmacy-two-col`; checks `apps/web/src/screens/acceptance/pharmacy-two-columns-1055.test.tsx`
(D1–D6) and `apps/core/src/modules/pharmacy/acceptance/add-medicine-1055.test.ts` (D5's server rules). What differs
from the text above, or was added on the day:

- Owner additions the same day: the find box in the main column is Desk One's — one full-width field, no Find button,
  under it "no slip? · paper prescription (P)" and what is searched; suggestions are Desk One's hit cards — and its
  border is Desk One's `.in` (1 px line at rest; the green border and ring only on focus).
- "Not prescribed" allows every schedule except X and narcotics (ruling 0094); the board's "only medicines with no
  schedule" is superseded. On a paper slip the prescriber is optional except for H1 (name and registration number).
- A medicine added while the ticket is claimed gets an order item at the check; one added after the check has none
  (the kernel's order takes no item once placed); every later step reads the order item as optional.
- On a phone the tabs stay Ticket · The line · Your day (no Day tab with a ticket in hand); the line's tab becomes the
  Bill tab only when the bill column would open.
- Once paid, the bill's printed / print-again line sits in the bill column; a collected ticket's header says "every line
  settled" in place of the foot.

