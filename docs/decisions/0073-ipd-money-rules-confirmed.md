---
type: decision
id: "0073"
title: "IPD money rules confirmed; IPD stays off production until all modules are built"
description: "Owner 2026-10-14: the money rules chosen during the IPD build (billing days, visits, deposits, dues, supplementary bill, lab and imaging on the running bill) are confirmed; IPD is tested on staging and not deployed to production until the other modules are built."
generated: { by: agent:claude, at: 2026-10-14 }
verified: []
status: stable
ruling: ruled
tags: [ipd, billing, tariff, planning]
supersedes: []
superseded_by: ["0085"]
sources:
  - { id: issue-712, resource: "https://github.com/ankits3a/hims-hmis/issues/712", title: "IPD core spec" }
---
# 0073 — IPD money rules confirmed; IPD stays off production until all modules are built

- **Date:** 2026-10-14   **Status:** Ruled. "Not deployed to production until the other modules are built" is superseded by
  0085 (IPD/ER merge to main dark, behind a module switch); the money rules below stand.
- **Area:** IPD billing (charges, visits, deposits, discharge, supplementary bill, inpatient orders)

## What is ruled

**Owner, 2026-10-13:** *"once ready I will test in staging. We won't deploy it on production until all other
modules are built."* IPD pull requests stay drafts; staging carries an integration branch.

**Owner, 2026-10-14:** *"money rules: confirmed."* The rules below were chosen by standard practice during the
build and listed in each pull request for confirmation. They now stand.

### Admission and deposits
- A non-covered line under a scheme, and a deposit waiver, are approved by the billing manager or the medical
  superintendent.
- Deposits are taken in cash, UPI or card.
- Cashless and corporate patients pay a deposit for non-payables, set per bed class in the tariff.

### Bed-day and visit charges
- The admission day is always billed. The discharge day is free when the patient leaves before 14:00.
- One chargeable visit per consultant per patient per day. A repeat visit on the same day is free.
- A consultant of the treating unit bills a visit; a consultant of another unit bills a cross-visit.
- A visit on a bed class without a visit rate bills at the general rate. A missing cross-visit rate raises a
  bill-desk exception; it does not fall back.
- A remote (phone) review is recorded and not charged.
- A round entered late is charged only for the current day, or for the previous day when entered before 10:00.
  Older ones go to the bill desk to charge or waive, with a reason.
- A patient on insurance reimbursement is billed as self-pay.

### Final bill, dues and supplementary bill
- No patient is detained for dues: dues are recorded against a signed undertaking and the gate pass issues.
- The settlement day belongs to the settled bill and is billed as a full day. Charges after settlement go on a
  supplementary bill under the same 14:00 rule.
- A settled bill is changed only by a void (credit note) approved by a second person, never by an edit. A void
  is refused once a refund is paid out, once the payer's claim is settled, or while a gate pass is issued and
  not yet scanned.

### Lab and imaging for inpatients
- Lab and imaging orders post to the IPD running bill at the tariff version locked at admission. No separate
  invoice is raised and no report is held for payment.
- A test cancelled before the work is reversed; after the work, or after the bill is settled, billing decides.
- An inpatient scan ordered while imaging is switched free (0067) posts at ₹0.

### Bio-medical waste
- A weight gap of 6 % or more between the hospital's and the operator's record raises a dispute.

## Not ruled here
- GST treatment of the rate-card categories `room_rent_icu` and `ipd_care` (SAC 999311): for the chartered
  accountant to confirm.
- Who approves a price-list revision (today the billing manager): asked, not yet answered.
- Billing of ward-issued medicines (issue #787) and the inpatient pharmacy store.

## Where it lives
The ipd module notes (`apps/core/src/modules/ipd/MAP.md`) carry each rule beside its code; the pull requests
are #751, #756, #758, #760, #762, #775, #786 and #788.
