# Decision records

The hospital owner's rulings on money, procurement, law and product scope, one numbered file per ruling, so people
and agents working on HMIS can read why the system behaves as it does.

**Rule: a ruling is added as a new numbered file; an old one is never rewritten, only marked Superseded.**
Numbers run in chronological order of the ruling date. A record whose rulings were partly overturned later says so
in its Status line and names the record that overturned it.

| # | Date | Title | Area | Status |
|---|---|---|---|---|
| 0001 | 2026-08-26 | [What the resource registry holds, and when master-data change control may start](0001-resource-registry-scope.md) | kernel, opd, ot, ipd | Ruled |
| 0002 | 2026-09-04 | [Printing is server-side, through a relay inside the hospital](0002-printing-is-server-side.md) | printing | Partly open |
| 0003 | 2026-09-05 | [Diagnostic-only visits carry no consult fee; a confidential patient's reprint carries the alias](0003-diagnostic-visit-fee-and-confidential-reprint.md) | billing, opd, printing, patients | Partly open |
| 0004 | 2026-09-13 | [One service is charged once per visit; the patient pays before vitals](0004-one-service-one-visit-pay-before-vitals.md) | billing, opd, vitals | Partly open |
| 0005 | 2026-09-17 | [DDInter is an internal benchmark only; no dataset is bought](0005-ddinter-internal-benchmark-only.md) | formulary, cds, legal | Ruled |
| 0006 | 2026-09-17 | [The doctor's copilot: two per-doctor toggles, the doctor always submits](0006-doctor-copilot-toggles.md) | opd, cds, copilot | Partly open |
| 0007 | 2026-09-19 | [Pharmacy desk: P-number at queue time; the doctor authorises dispensing against an allergy](0007-pharmacy-desk-p-number-and-allergy-override.md) | pharmacy | Ruled |
| 0008 | 2026-09-22 | [Make the pharmacy ready: full authority, minimal screens, loose-tablet pricing](0008-pharmacy-ready-full-authority.md) | pharmacy, materials, billing | Ruled |
| 0009 | 2026-09-23 | [The doctor's consult engine](0009-doctor-consult-engine.md) | opd, cds, billing, printing | Partly open |
| 0010 | 2026-09-25 | [Lab reception, collection, bench and report rules](0010-lab-reception-money-and-reports.md) | lab, billing, printing | Ruled — ruling 12 superseded by 0013 |
| 0011 | 2026-09-26 | [Security (WASA) and ABDM settings](0011-security-and-abdm-settings.md) | security, auth, abdm | Partly open |
| 0012 | 2026-09-28 | [Each remaining department gets its own brainstorm; pharmacy only for now](0012-department-brainstorms-and-pharmacy-scope.md) | pharmacy, ipd, emergency, tpa | Ruled |
| 0013 | 2026-09-28 | [Only the owner may issue credit, hospital-wide](0013-credit-is-owner-only.md) | billing, pharmacy, lab | Ruled |
| 0014 | 2026-09-28 | [Blind cash count](0014-blind-cash-count.md) | billing | Ruled |
| 0015 | 2026-09-28 | [Radiology: every open decision defaults to what top Indian hospitals do](0015-radiology-defaults-top-hospital-standard.md) | radiology, billing | Ruled |
| 0016 | 2026-09-28 | [UX-audit boards approved, with their money and law defaults](0016-ux-audit-boards-money-defaults.md) | billing, membership, patients | Ruled |
| 0017 | 2026-09-28 | [The Medical Superintendent holds break-glass; "collected today" is hidden from the cashier](0017-ms-break-glass-and-hidden-collected-today.md) | security, patients, billing | Ruled |
| 0018 | 2026-09-29 | [Patient profile layout; recording a death requires the death certificate number](0018-patient-profile-and-death-certificate.md) | patients, legal | Ruled |
| 0019 | 2026-09-30 | [Pharmacy money: rounding, discount limits, refunds, two-person GRN](0019-pharmacy-money-rounding-discount-refund.md) | pharmacy, billing | Ruled |
| 0020 | 2026-10-01 | [Desk One is back on the menu](0020-desk-one-back-on-the-menu.md) | web shell, front desk | Partly open |
| 0021 | 2026-10-01 | [Fee switches, "₹0 (समाज सेवा छूट)", and who changes consultation prices](0021-fee-switches-and-consult-prices.md) | billing, tariff | Ruled |
| 0022 | 2026-10-02 | [Pharmacy quick desk mode stands down three checks](0022-pharmacy-quick-desk-mode.md) | pharmacy, legal | Partly open |
| 0023 | 2026-10-02 | [A pharmacy return may be kept as the patient's credit](0023-pharmacy-return-as-patient-credit.md) | pharmacy, billing | Ruled |
| 0024 | 2026-10-04 | [The 22-unit establishment; the e-prescription prints the unit, not the doctor](0024-units-and-prescription-header.md) | roster, opd, printing | Partly open |
| 0025 | 2026-10-06 | [Doctors may prescribe on paper; the slip desk or scribe marks the visit consulted](0025-paper-consult.md) | opd, pharmacy, lab | Ruled |
