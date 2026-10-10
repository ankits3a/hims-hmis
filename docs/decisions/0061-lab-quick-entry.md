---
type: decision
id: "0061"
title: "Lab quick mode: start (tests + blood collected) puts the patient in a queue; results, flags, an editable summary and print — no bill, no token, no signature for now"
description: "The owner's quick lab flow: find the patient (visit no., UHID or card QR), choose tests (doctor's advised list pre-filled), tick Blood collected, Start into a queue; later pick from the queue, type results against pre-filled parameters, high and low marked, edit the drafted summary, save, print. Billing, tokens and pathologist signing stay in other software for now."
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

The owner's flow, in their words: *"Patient arrives in Lab. Staff ... types visit ID from the
prescription slip or simply searches the patient ID and simply scans the QR code. The patient is
selected. The staff adds the tests ... or sees the list if doctor has already prescribed. ... checks
on 'Blood collected' and clicks on 'Start' to add the patient in the queue ... Patient leaves after the
staff verbally tells the patient to come back after few hours or after few days. Now on the web
screen user selects the patient from the queue and there he can see a form with all the pre selected
parameters from the first screen. The user now starts filling up the result. Once filled, the user
can now click on save and then print the test report."*

1. **Start:** find the patient by visit no., UHID (or mobile, name, token) or the card's QR; the
   doctor's advised tests come pre-filled and staff add or remove tests; "Blood collected" must be
   ticked before **Start**, which puts the patient in the queue.
2. **Results:** pick the patient from the queue; the form holds every parameter of the chosen tests;
   type the results; high and low are marked against the patient's own range (age and sex).
3. **A short report summary is drafted automatically** and staff may edit it; **Save**, then **Print**.
4. **No billing and no signing in quick mode for now** (*"payment and signing are handled in
   different software so skip it right now. We will introduce payment, token and signing very soon
   later."*). This sets aside, for quick mode only, decision 0010's "no token until billed" and
   "every report is signed by a pathologist". The ordered lab workflow (desk, collection, bench,
   verify, report centre) is unchanged and still follows 0010.

## DECIDED (standard practice, open to the owner's objection)

- **Who may use it:** Start needs `lab.desk.operate` (lab reception, which already finds patients at
  the lab desk); the queue and results need `lab.results.enter` (the technologist). A person who
  does both needs both roles. No new permission.
- **The queue keeps a patient until reported**, whatever day they started ("come back in two days").
  Reported rows stay listed for the day of reporting, for a reprint.
- **The summary is written by fixed rules, not AI:** each out-of-range value on its own line with
  its range, then one line for the rest. Once a person edits it, it is not overwritten.
- **Critical values are shown in bold red but do not start the critical call ladder.** The ladder
  belongs to ordered results with a doctor to call. Quick reports are kept apart from verified
  results so they never feed ABDM release, INR/platelet/creatinine checks or the delivery interlock.
- **A value outside the analyte's possible range is refused** (a typo such as 92 for a haemoglobin
  of 9.2). Text results are taken as typed.
- **Reports can be reopened and edited.** Start and every save are logged with who and when.
- **The phone app** gets the same Start screen in a follow-up app release; the web screen does both now.
- **Print** is a plain browser page: patient, values grouped by test, units, ranges, remarks. No signature block.
- **Who sees saved reports (owner asked 2026-10-09):** holders of `lab.results.read` — the doctor in the
  consult brief, the patient profile (admin, doctors), and lab staff through "Saved reports" on the quick
  lab screen (find the patient, read, print, reopen to edit). Every place labels them "Quick lab · not
  signed" and keeps them apart from signed results, which stay signed-only. A report with a sensitive
  test (HIV, HBsAg …) is hidden from anyone without `orders.read.restricted`. Each read is access-logged
  (`lab.quick_reports`).

## Consequences / how to apply

- Screen `/lab/quick`; API `GET /lab/quick/catalogue`, `POST /lab/quick/start`, `GET /lab/quick/queue`,
  `GET /lab/quick/ranges`, `GET|PUT /lab/quick/reports/:id`, `GET /lab/quick/patient/:patientId`; patient search is the lab desk's
  `GET /lab/desk/find`; table `lab_quick_reports`; events `lab.quick_started`, `lab.quick_reported`.
- When payment, tokens and signing come into HMIS, a new decision says whether quick reports then
  need an order, a bill and a signature, and this record is marked superseded.
