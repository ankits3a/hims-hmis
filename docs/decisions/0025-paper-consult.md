# 0025 — Doctors may prescribe on paper; the slip desk or scribe marks the visit consulted

- **Date:** 2026-10-06   **Status:** Ruled
- **Area:** opd, pharmacy, lab, radiology, security (roles)

## Decision

- Owner: some doctors struggle to type during consultation; there are no funds to hire typists; they are fine
  writing on paper. *"We already have 'Desk Scribe' module. Let's enable it to type the drugs as well as lab tests…
  if the Slip Desk or Scribe Desk staff by performing either clicking a picture of prescription slip or typing the
  prescriptions on their respective screen will mark the patient as Consulted even if the doctor hasn't marked or
  has not operated dashboard on web."*
- The Desk Scribe may type drugs and lab tests from the paper prescription.
- A slip photo (Slip Desk) or the scribe's typing (Desk Scribe) marks the visit Consulted.
- Answers to the two questions: **"A) Yes, allow the pharmacy to dispense. B) Yes, the slip desk and Desk scribe.
  Claude, go ahead."**
  - A: the pharmacy may dispense (and the lab may bill/act) from the scribe's typed entries BEFORE the doctor
    confirms, with the slip photo shown beside the typed lines.
  - B: only the Slip Desk and Desk Scribe roles may mark a visit consulted from paper; today's visits only, patient in
    that doctor's queue.
- **Second ruling, same day: "Yes, paper close that visit too."** A visit the doctor STARTED on screen and never
  completed (in consultation, parked or not) is closed by the paper road. DECIDED around it: the doctor's note and
  any typed-but-unissued medicines are kept and issued by nobody (pharmacy gets only the scribe's lines); the
  doctor's paper list shows them; the doctor's own screen acting on the closed visit is refused with a plain
  sentence (`closed_on_paper_state_conflict`).
- This supersedes FD-30's "draft-then-confirm — the doctor's tap" as a GATE (recorded outside this folder); the tap
  stays as an optional confirmation.

## Why

Paper is the signed original (kept as the slip photo); a patient must not sit "waiting" forever because a doctor
never opened the dashboard; doctors "will adopt sooner".

## Consequences / how to apply

- Scribe entries are labelled "typed from the doctor's paper prescription by <name>".
- Safety alerts are never dismissed by a scribe; they are flagged to the doctor.
- A supervisor can reopen a wrongly closed visit, with a reason (permission `opd.queue.transfer`).
- The doctor's confirmation is optional and never blocks the patient.
- New permission `opd.consult.paper` → `opd_scribe` and new role `opd_slip_desk`. The administrator must assign
  `OPD Slip Desk` / `OPD Door Scribe` in `/admin/users` before anything closes.
- Server: `apps/core/src/modules/opd/paper-consult.ts`, routes `/opd/paper/...`, migration 0180. Tests typed by the
  scribe are `advised_tests` items with `transcribedBy`; the lab desk and radiology's advised reader show
  `typedFromPaperBy`.
