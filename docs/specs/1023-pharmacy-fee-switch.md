---
issue: 1023
status: built
approved: 2026-11-02
---
# SPEC — Pharmacy fee switch (#1023)

## What

A fourth switch, "Pharmacy medicines", on Billing → Back office → Fees, beside the OPD, laboratory and imaging
switches. Off means free: medicines go out at ₹0. The owner approved this on 2026-11-02.

## Decisions

1. **Which sales:** OPD dispenses and walk-in counter sales, including downtime paper entries. IPD is out of scope.
2. **Which medicines:** every item, including Schedule H and controlled drugs. Registers are written as on a paid sale.
3. **When it is decided:** when the dispense is created, like imaging. A walk-in sale decides at the time of sale.
4. **On the bill:** each line keeps its MRP and carries a 100% discount with the reason "समाज सेवा छूट". The total is ₹0.
5. **GST:** the owner's CA rules on GST for free medicines before this switch is used in production. The switch ships
   off (charged).

## Done means

- D1: A dispense created while the switch is off bills at ₹0, keeps its MRP on the line, and needs no tender.
- D2: A dispense created while the switch is on bills at MRP as before.
- D3: A free dispense moves stock exactly as a paid one does.
- D4: Each flip is audited with who and when, and the Fees page lists the pharmacy switch.
- D5: A free medicine returned goes back on the shelf, and no refund and no pharmacy credit arise.
- D6: Flipping the switch does not change a dispense already created.
- D7: A walk-in sale made while the switch is off is ₹0 with no tender, and its stock moves.
