---
type: decision
id: "0074"
title: "IPD open items settled by standard practice; subsidised medical-college room and visit rates"
description: "Owner 2026-10-14: the remaining IPD questions take the standard answer of a leading Indian hospital, and the IPD rate card uses subsidised medical-college rates until the incumbent's tariff export arrives."
generated: { by: agent:claude, at: 2026-10-14 }
verified: []
status: stable
ruling: ruled
tags: [ipd, billing, tariff, pharmacy, nursing, discharge]
supersedes: []
superseded_by: []
sources:
  - { id: issue-712, resource: "https://github.com/ankits3a/hims-hmis/issues/712", title: "IPD core spec" }
  - { id: issue-787, resource: "https://github.com/ankits3a/hims-hmis/issues/787", title: "Ward medicines on the IPD bill" }
---
# 0074 — IPD open items settled by standard practice; subsidised medical-college rates

- **Date:** 2026-10-14   **Status:** Ruled
- **Area:** IPD billing, ward pharmacy, discharge, nursing, tariff

## What is ruled

**Owner, 2026-10-14:** *"Go with your defaults and standard practices in top hospitals and subsidized tariff rates
that are in medical college and hospital."*

### Ward medicines on the IPD bill (#787)
- A strip lost or damaged on the ward is reissued and charged; the bill desk may waive it with a reason.
- A ward medicine is priced at issue, at the batch MRP, not at the tariff version locked at admission.
- No membership benefit applies at ward issue.
- Ward issue comes from the main pharmacy store (PHARM-OPD). A separate inpatient store is a later setup step,
  not a code change.

### Pharmacy counter sale charged to an admission (PR #796)
- A medicine with no price is refused at the counter (a ward issue instead raises a bill-desk exception).
- No counter discount applies to a sale charged to the admission; only the item's standing discount.
- A settled final bill refuses a counter sale; later medicines reach the supplementary bill through a ward issue.
- Returns are accepted after discharge, as ward returns are, and credit at the sale's own price.

### Price-list revisions
- A tariff revision keeps two people: the billing manager approves the draft, the owner activates it with a start
  date. This is the rule built today.

### Discharge summary
- Medicine reconciliation at discharge (NABH): a summary that names a medicine with no hospital order always needs
  a no-order reason before it signs, including a typed summary on a stay with no medicine orders. The E3.2
  exception is lifted.

### Clinical defaults (kept as built)
- The ISMP high-alert list stands as the hospital list until the drugs and therapeutics committee reviews it.
- Nil by mouth ("NPO except medications"): the nurse confirms that medicines may be given with sips; a nil-by-mouth
  state that comes from an OT booking needs the doctor's verbal OK for oral medicines.
- eMAR due times stay as built (IST): OD 09:00 · BD 09:00, 21:00 · TDS 08:00, 14:00, 20:00 ·
  QID 00:00, 06:00, 12:00, 18:00 · HS 21:00 (`apps/core/src/modules/ipd/emar-rules.ts`).

### Acceptance check
- The Now-cards check (iv), which pinned the cards M4 had not yet built, is retired: all six cards are built.

### IPD rate card — subsidised medical-college rates (rupees per day)

| Class | Room | Nursing | RMO | Visit | Cross-visit |
| --- | ---: | ---: | ---: | ---: | ---: |
| General ward | 150 | 100 | 50 | 100 | 150 |
| Semi-private | 600 | 200 | 100 | 250 | 300 |
| Private | 1,200 | 300 | 150 | 400 | 500 |
| Deluxe | 1,800 | 400 | 200 | 500 | 600 |
| Suite | 2,500 | 500 | 250 | 600 | 700 |
| HDU | 1,000 | 400 | 200 | 300 | 400 |
| ICU | 1,500 | 500 | 300 | 400 | 500 |
| NICU | 1,200 | 500 | 300 | 400 | 500 |
| PICU | 1,200 | 500 | 300 | 400 | 500 |
| Labour room (LDR) | 500 | 200 | 100 | 200 | 300 |
| Day care | 150 | 100 | 50 | 100 | 150 |
| Emergency | 300 | 150 | 100 | 200 | 300 |

These sit well below CGHS and private-hospital room rents, in line with teaching-hospital subsidy. Every room rent
is under ₹5,000 a day, so no room attracts GST. The incumbent's tariff export, when it arrives, replaces this card
through the normal draft → approve → activate route.

## Not ruled here
- GST treatment of `room_rent_icu` and `ipd_care` (SAC 999311): for the chartered accountant.
- Production merges still need the owner's explicit OK each time.
