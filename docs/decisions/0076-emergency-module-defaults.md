---
type: decision
id: "0076"
title: "Emergency department: the spec's defaults are ruled (rates, dues, cashless schemes, mass casualty, hardware)"
description: "Owner 2026-10-15 took the defaults of the Emergency spec draft: incumbent ER tariff carried over, no-detention dues, road-accident cashless and PM-JAY at ₹0, mass-casualty charges to an event account, ER hardware bought before rehearsal."
generated: { by: agent:claude, at: 2026-10-15 }
verified: []
status: stable
ruling: ruled
tags: [emergency, billing, law, procurement]
supersedes: []
superseded_by: []
sources:
  - { id: issue-808, resource: "https://github.com/ankits3a/hims-hmis/issues/808", title: "ER lane 1 — er-arrival" }
---
# 0076 — Emergency department defaults

- **Date:** 2026-10-15   **Status:** Ruled
- **Area:** Emergency department (milestone "Emergency", issues #808–#816)

## What is ruled

**Owner, 2026-10-15:** *"go with your defaults, keep working"*. This applies to the five questions of the
Emergency spec draft (kept out of git with the other module specs).

1. **ER rates.** The incumbent's ER tariff is carried over line by line:
   - ER registration and ER physician fee, each once per visit;
   - after the first 6 hours, an observation charge per started 6 hours;
   - procedures, consumables, drugs and tests itemised at the hospital tariff.

   On admission, the ER lines roll into the IP running bill. Go-live is blocked until those rates exist.
2. **Unpaid ER balance on leaving without admission.** The patient is never held. The balance is recorded as
   dues against a signed undertaking, with the invoice held until paid (not credit, see 0013). No deposit is
   asked before the ER doctor records "stabilised".
3. **Cashless schemes.** The hospital joins the central road-accident cashless scheme (up to ₹1.5 lakh for
   7 days). Road-accident victims and PM-JAY patients pay ₹0. Rape and acid-attack victims are treated free by law
   (BNSS s.397). The TPA desk (0075) files claims by hand.
4. **Mass-casualty event.** No charge at the point of care. Charges post at full tariff to an event account.
   Afterwards the owner decides, event by event, to waive them, claim them from the state, or bill the payer.
5. **ER hardware (about ₹4–5 lakh), bought before the first rehearsal:**
   - 2 wall screens;
   - 6 tablets;
   - 1 thermal wristband printer;
   - 1 A4 printer;
   - 2 rugged scanners.

## Decided by standard practice (not owner rulings)
- Triage: ESI v4, five levels.
- ER beds: the 60 emergency-class beds already in the bed registry.
- Unidentified patients get a real UHID with an alias, merged later through `patient_merge`.
- MLC: police intimation within 1 hour; faculty countersign within 24 hours.
- Brought dead is always an MLC.
- No money appears on any ER clinical screen (0058).
