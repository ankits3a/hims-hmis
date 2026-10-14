---
type: decision
id: "0075"
title: "A light insurance/TPA desk is built before IPD go-live; payroll is bought, not built"
description: "Owner 2026-10-15 took the standard defaults: R-5 answered yes (insurance-lite before IPD goes live), and HR payroll is a bought product integrated with HMIS staff and attendance records."
generated: { by: agent:claude, at: 2026-10-15 }
verified: []
status: stable
ruling: ruled
tags: [billing, insurance, ipd, hr, procurement]
supersedes: []
superseded_by: []
sources:
  - { id: issue-604, resource: "https://github.com/ankits3a/hims-hmis/issues/604", title: "Rule R-5: insurance / PM-JAY 46-lite before IPD" }
---
# 0075 — Insurance-lite before IPD go-live; payroll is bought

- **Date:** 2026-10-15   **Status:** Ruled
- **Area:** inpatient payers, TPA desk, HR

## What is ruled

**Owner, 2026-10-15:** *"go with your defaults, keep working"*, given in answer to the open questions on R-5
(#604) and payroll build-or-buy.

### R-5: a light insurance/TPA desk comes before IPD go-live
IPD already records the payer, a manual authorisation and the payer/patient split (decision 0073). Before IPD
goes live, a TPA desk adds what a corporate hospital's TPA desk works from every day:
- a pre-authorisation tracker per admission (sent, query, approved amount, enhancement, final approval), with
  documents attached and an ageing clock;
- PM-JAY and state-scheme package selection against the scheme's package master, with the package rate as the
  payer amount;
- a claim tracker after discharge (submitted, query, settled, short-paid, rejected), with the deduction reasons
  recorded;
- a TPA copilot card for pre-auths ageing and enhancements due.

Money rules of the desk (standard defaults, owner 2026-10-15, built in PR #822):
- An enhancement falls due at 90 % of the approved amount used.
- PM-JAY multiple packages pay 100 % / 50 % / 25 % (highest first).
- A package rate is fixed when chosen; a re-import never re-prices a stay.
- Lines above a package amount are absorbed by the hospital, never billed to the patient.
- TDS is typed from the settlement advice and counts as received.
- Payer deductions are recorded with a reason and never re-billed to the patient by the system; the billing
  manager decides on recovery.
- A settlement must add up to the paisa (net + TDS + deductions = claimed).
- The default claim amount is the package total for a scheme stay, otherwise the payer part of the bill; the desk
  may override it.

Portal filing stays manual (insurer and scheme portals). Automating the portals is a later phase.

### Payroll is bought
Payroll (salary, statutory deductions, PF/ESI filings, payslips) is bought as a product, not built. HMIS keeps
the staff master, roles and attendance (decision 0062) and exports what payroll needs. The vendor choice is a
procurement step for the owner.

## Not ruled here
- Which payroll product, and its cost.
- Scheme empanelment and package rates: they come from the scheme, not from us.
