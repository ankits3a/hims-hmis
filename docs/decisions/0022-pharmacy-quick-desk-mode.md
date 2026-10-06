# 0022 — Pharmacy "quick desk mode" stands down three checks

- **Date:** 2026-10-02   **Status:** Partly open
- **Area:** pharmacy, legal

## Decision

- Owner, on staging: *"add a toggle for admin to enable a quick desk mode for pharmacy desk screen where the
  pharmacist/counter staff who is allowed to bill can find the patient, chooses the doctor/department unit from the
  filter and directly add medicine and bill the patient. No prescription upload warning … no 'Only a pharmacist with
  a current state council registration on file may do this' blocker, no 'See the slip' or 'Confirmed against the
  slip' button."*
- A setting, OFF by default. While ON, exactly three server checks stand down:
  - `prescription_required` (paper prescription);
  - `pharmacist_not_registered` (verify and scheduled hand-over only);
  - `slip_not_confirmed` (bill).
- Everything else stays: permissions, Schedule X / narcotic refusal on paper, allergy and interaction refusals, H1
  prescriber rules, the H1 register write, and "refunds/returns/authorisations still need a registered pharmacist".
- Later the same day (recorded with 0023): "refunds allowed without registration in quick desk mode". This
  contradicts the previous line for refunds; the later statement is what was built into PR #440. See Open.

## Why

The owner wants counter staff to bill from a physical prescription without ceremony. This is a law ruling
(Pharmacy Act s.42 enforcement is removed while ON) and the owner made it knowingly.

## Consequences / how to apply

- Built as `pharmacy_settings.quick_desk` (migration 0166, one row), changed under `pharmacy.licences.manage`,
  audited by `pharmacy_settings.changed`. The switch is at Pharmacy office → Law → Desk mode (PR #440).
- Do not "fix" the bypass as a defect, and do not widen it to other checks without a new ruling.

## Open

- The sources disagree on whether a refund in quick desk mode needs a registered pharmacist (see above). Confirm
  with the owner which one stands.
