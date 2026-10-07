# Decision records

The hospital owner's rulings on money, procurement, law and product scope, one numbered file per ruling, so people
and agents working on HMIS can read why the system behaves as it does.

**Rule: a ruling is added as a new numbered file; an old one is never rewritten, only marked Superseded.**
Numbers run in the order the rulings were recorded: 0001–0025 follow the ruling date, and later batches may record
an older ruling under a higher number (the Date column is the ruling date). A record whose rulings were partly overturned later says so
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
| 0022 | 2026-10-02 | [Pharmacy quick desk mode stands down three checks](0022-pharmacy-quick-desk-mode.md) | pharmacy, legal | Ruled |
| 0023 | 2026-10-02 | [A pharmacy return may be kept as the patient's credit](0023-pharmacy-return-as-patient-credit.md) | pharmacy, billing | Ruled |
| 0024 | 2026-10-04 | [The 22-unit establishment; the e-prescription prints the unit, not the doctor](0024-units-and-prescription-header.md) | roster, opd, printing | Partly open |
| 0025 | 2026-10-06 | [Doctors may prescribe on paper; the slip desk or scribe marks the visit consulted](0025-paper-consult.md) | opd, pharmacy, lab | Ruled |
| 0026 | 2026-08-25 | [Channel-partner planning uses a synthetic book; real terms arrive as configuration](0026-channel-partner-context-is-synthetic.md) | partners | Ruled |
| 0027 | 2026-08-27 | [Materials core: the three-slice cut and four procurement rules](0027-materials-core-slice-and-procurement-rules.md) | materials, procurement | Ruled |
| 0028 | 2026-08-30 | [An unpaid reflex test holds its whole order group's report](0028-lab-report-interlock-order-group.md) | lab, billing | Superseded by 0010 (ruling 9) |
| 0029 | 2026-08-31 | [The registration counter is Desk One; agent information sits in the line of sight](0029-registration-counter-desk-one-design.md) | front desk, copilot | Ruled — partly superseded by 0039 |
| 0030 | 2026-08-31 | [Vitals bay: 10-second cancel on auto-bump, serial capture off, fast typing lane, amend after save](0030-vitals-bay-rulings.md) | opd, vitals | Ruled |
| 0031 | 2026-09-04 | [FD-25 seat screens: cashier grants, voice scribe UI only, Desk One off the nav](0031-registration-seat-fd25.md) | front desk, roles | Partly superseded by 0020 |
| 0032 | 2026-09-06 | [The front-desk seats are Desk One; billing keeps every money control](0032-front-desk-seats-are-desk-one.md) | front desk, billing | Ruled |
| 0033 | 2026-09-06 | [Hospital paper prints the Doctor ID, never the doctor's name or registration number](0033-hospital-paper-prints-doctor-id.md) | printing, legal | Partly superseded by 0024 |
| 0034 | 2026-09-13 | [Patients who share a mobile number are shown as linked](0034-shared-phone-links-patients.md) | patients, privacy | Ruled |
| 0035 | 2026-09-14 | [Staff reports: count the act, not the seat; MRD permission; history horizon by role](0035-staff-reports-act-mrd-horizon.md) | staff reports, permissions | Ruled |
| 0036 | 2026-09-19 | [OPD consultations report: PDF and CSV, "New" = new to the hospital, week = Monday–Saturday](0036-opd-consultations-report.md) | opd, reports | Ruled |
| 0037 | 2026-09-20 | [An emergency is charted before billing; an unpaid token waits for the money or the doctor](0037-emergency-vitals-and-unpaid-token.md) | opd, vitals, billing | Ruled |
| 0038 | 2026-09-25 | [Build the whole ABDM connector now, without credentials; prepare for FT and WASA](0038-abdm-built-without-credentials.md) | abdm, security | Partly open |
| 0039 | 2026-09-25 | [Counter and desk screen layout](0039-counter-screen-layout.md) | web, lab, pharmacy, front desk | Ruled |
| 0040 | 2026-09-30 | [Production patient data was test data: copied to staging, wiped from production](0040-production-patient-data-wipe.md) | data, privacy | Ruled |
| 0041 | 2026-10-03 | [Two-site production: hospital server primary, automatic cloud failover](0041-two-site-production.md) | hosting, production | Partly open |
| 0042 | 2026-10-07 | [The staff app opens on "My day": approvals from the card, deadlines by kind, a team card for supervisors](0042-app-home-my-day.md) | mobile, approvals, auth | Partly open |
| 0043 | 2026-10-07 | [App home, round two: the board built whole — the header, the desks' cards, paper consultations on the phone, "ask the desk to re-check"](0043-app-home-round-two.md) | mobile, opd, approvals, roster | Ruled |
| 0044 | 2026-10-07 | [The OPD report counts the visits the desk opened; "Booked" reads "Appointments"](0044-opd-report-visits-opened.md) | opd, reports, front desk | Ruled |
| 0045 | 2026-10-07 | [A counter with no print relay prints on its own printer, from the browser](0045-browser-printing-fallback.md) | printing, front desk | Partly open |
| 0046 | 2026-10-07 | [OPD vitals: no RR tile, and a guardian with reports may skip the bay on a revisit or renewal](0046-opd-rr-hidden-and-guardian-visit.md) | opd, vitals, front desk | Partly open |
| 0047 | 2026-10-07 | [Each counter PC runs its own print program (Windows), enrolled with a one-time code](0047-counter-print-program.md) | printing, front desk, admin | Partly open |
