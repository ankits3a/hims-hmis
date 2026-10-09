---
type: decision
id: "0061"
title: "Lab quick entry: search a patient, type values, an editable flagged report — no bill, no token, no signature for now"
description: "The owner asked for a quick mode in the lab: pick a patient, add tests or parameters, type results, see high and low marked against the patient's range, and edit an auto-drafted summary. Billing, tokens and pathologist signing stay in other software until they are brought into HMIS."
generated: { by: agent:claude, at: 2026-10-09 }
verified: []
status: stable
ruling: ruled
tags: [lab, billing, printing]
supersedes: []
superseded_by: []
sources: []
---
# 0061 — Lab quick entry

- **Date:** 2026-10-09   **Status:** Ruled
- **Area:** lab

## What is ruled (owner, 2026-10-09)

1. **A quick mode for lab results.** Staff search the patient, pick them, add tests or single
   parameters from the catalogue and type each result.
2. **High and low are marked as they type**, against the patient's own range (age and sex).
3. **A short report summary is drafted automatically** and staff may edit it before saving.
4. **No billing and no signing in quick mode for now** (*"payment and signing are handled in
   different software so skip it right now. We will introduce payment, token and signing very soon
   later."*). This sets aside, for quick mode only, decision 0010's "no token until billed" and
   "every report is signed by a pathologist". The ordered lab workflow (desk, collection, bench,
   verify, report centre) is unchanged and still follows 0010.

## DECIDED (standard practice, open to the owner's objection)

- **Who may use it:** anyone holding `lab.results.enter` (the bench technologist). No new permission.
- **The summary is written by fixed rules, not AI:** each out-of-range value on its own line with
  its range, then one line for the rest. Once a person edits it, it is not overwritten.
- **Critical values are shown in bold red but do not start the critical call ladder.** The ladder
  belongs to ordered results with a doctor to call. Quick reports are kept apart from verified
  results so they never feed ABDM release, INR/platelet/creatinine checks or the delivery interlock.
- **A value outside the analyte's possible range is refused** (a typo such as 92 for a haemoglobin
  of 9.2). Text results are taken as typed.
- **Reports can be reopened and edited.** Every save is logged with who and when.
- **Print** is a plain browser page: patient, values, units, ranges, remarks. No signature block.

## Consequences / how to apply

- Screen `/lab/quick`; API `GET /lab/quick/catalogue`, `GET /lab/quick/ranges`,
  `GET|POST /lab/quick/reports`, `PUT /lab/quick/reports/:id`; table `lab_quick_reports`; event
  `lab.quick_report_saved`.
- When payment, tokens and signing come into HMIS, a new decision says whether quick reports then
  need an order, a bill and a signature, and this record is marked superseded.
