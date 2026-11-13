---
issue: 1046
status: built
approved: 2026-11-13
---
# SPEC — Pharmacy counter go-live (#1046)

Status: APPROVED 2026-11-13 by the owner ("Both A and B"), after the pharmacy architecture review. Rulings: 0093.

## What

The OPD desk pipeline (queued → claimed → verified → picked → billed → handed over) stays. Seven exceptions that stop
a busy Indian counter get a way through, and the bill carries what the Drugs Rules ask a sale bill to carry.

## Decisions

- **Collected by.** The Schedule H/H1 hand-over takes a third identity way beside today's token and phone: *collected
  by* — `self`, or `attendant` with a name and a relation (the same relation list OPD's "Who came?" uses). It is
  always offered. The dispense stores who collected; the hand-over event carries it.
- **Drop a line at the bill.** In `picked`, the pharmacist may decline one line with a reason. Its reservation is
  released and the bill preview re-totals. Declining the last line cancels the ticket as today. After `billed`, the
  return path is unchanged.
- **Bill at payment.** The desk prints the bill when the payment is taken (`billed`). Labels still print at hand-over.
- **Cash.** The cash amount field starts at the exact payable (after cash rounding, 0019). The walk-in counter offers
  split payment: cash plus UPI, which the server already accepts.
- **Bill particulars.** Every pharmacy bill (desk and walk-in, printed by the server and in the browser) shows, per
  line, batch, expiry as MM/YY and manufacturer (blank when the item has none); and, in the header, the current retail
  drug licence numbers (Form 20 and Form 21, from the licence register) and the pharmacist's name and council
  registration number.
- **Balance ticket ("rest tomorrow").** A line picked short with a reason leaves an owed balance in base units. For 30
  days from the first hand-over, finding that prescription at the desk offers the balance as a new ticket holding
  only the owed quantities; it runs the normal pipeline and bills on its own. A pharmacy bill's duplicate check is
  keyed by the dispense, so the balance bill is not refused as a duplicate of the first.
- **H/H1 brand swap (0093).** Substituting a brand on a Schedule H/H1 line sends the swap to the prescriber's desk
  card, as the allergy override does; the line waits until the prescriber agrees or declines. OTC lines keep the
  patient's consent alone. Quick desk mode does not stand this down.

## Done means

- **D1** A Schedule H ticket for a patient with no token and no phone is handed over with "collected by: attendant,
  name, relation", and the dispense shows who collected.
- **D2** In `picked`, one line is declined with a reason; its stock reservation is released and the bill total drops
  by that line.
- **D3** Taking the payment prints the bill without waiting for hand-over.
- **D4** The cash field starts at the exact payable, and a walk-in sale is paid part cash, part UPI.
- **D5** A printed pharmacy bill shows batch, MM/YY expiry and manufacturer per line, and the drug licence numbers and
  the pharmacist's registration number in its header.
- **D6** A line picked short leaves a balance; the next day the same prescription opens a balance ticket for only the
  owed quantity, and its bill is not refused as a duplicate.
- **D7** A brand swap on a Schedule H line waits for the prescriber's agreement; a swap on an OTC line does not.

## Built

Built 2026-11-13 on lane `pharmacy-counter`; locked checks `apps/core/src/modules/pharmacy/acceptance/counter-go-live-1046.test.ts`
and `apps/web/src/screens/acceptance/pharmacy-counter-1046.test.tsx`. Migration: one additive file (new nullable columns,
widened checks, the live-prescription index re-made to leave balance tickets out). Where the build is narrower or wider
than the text above:

- **Collected by** is not offered, and is refused, on a ticket with a Schedule X or NDPS line: that hand-over keeps the
  token or phone with its witness (P6).
- **Drop a line** is on the ticket's line menu while the ticket is collected and unpaid, not on the bill rail's rows.
  Dropping one batch of a split line drops the whole prescription line.
- **Bill at payment**: the desk that took the money prints the bill at once and its hand-over sends the labels alone; a
  ticket billed at another desk still sends both at hand-over.
- **Bill particulars**: the licence numbers come from the walk-in counter's licence register (the current row; "—"
  when none is current), and the desk bill names the pharmacist who verified it ("—" for a missing registration).
- **Balance ticket**: offered on the finished ticket (prescription QR or token) and beside the paper door when the
  patient is found by name or UHID. The 30 days run from the first hand-over of that prescription version. An
  unclaimed balance ticket's queue row still lists the prescription's drugs.
- **One bill per dispense**: billing takes an optional `oneInvoicePerDocument`; the pharmacy passes it on every dispense
  bill, so the encounter + service duplicate check no longer applies to any pharmacy dispense bill (this also clears
  the re-issued-prescription case). Billing the same dispense twice is still refused.
- **H/H1 brand swap**: the request names the substitute; a declined request leaves the line on the brand written.

