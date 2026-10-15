---
type: decision
id: "0044"
title: "The OPD report counts the visits the desk opened; \"Booked\" reads \"Appointments\""
description: "The OPD report gains Visits opened and Left unseen columns that add up, and 'Booked' is renamed 'Appointments'."
generated: { by: agent:claude, at: 2026-10-07 }
verified: []
status: stable
ruling: ruled
tags: [opd, reports, front-desk]
supersedes: []
superseded_by: []
sources:
  - { id: pr-528, resource: "https://github.com/ankits3a/hims-hmis/pull/528", title: "feat(opd-report): Visits opened and Left unseen, Booked reads Appointments, a ? on every column, who opened the visits (owner 2026-10-07)" }
---
# 0044 — The OPD report counts the visits the desk opened; "Booked" reads "Appointments"

- **Date:** 2026-10-07   **Status:** Ruled
- **Area:** opd, reports, front desk

## Decision

- Owner, on the OPD Day report: *"I can see column names like 'Booked', 'Consulted', 'New'..... what does 'Booked'
  mean?"* and then *"How would I know how many visits/appointments were opened by front desk?"*
- Proposed, and answered **"Yes please"**:
  1. A **Visits opened** column: every visit the front desk opened that day in that department, whatever happened to
     it afterwards.
  2. A **Left unseen** column, so the columns add up: Visits opened = Consulted + Still open + Left unseen.
  3. **Booked** is renamed **Appointments** — it counts appointments, not visits.
  4. A "?" on each column saying what it counts.
  5. A line under the table, "Opened by: Asha Devi 12 · Suresh Pillai 9 …", only for users allowed to see staff
     numbers. The printed report and the CSV get the same.

## The columns, as they now read (screen, printed sheet, CSV)

| Column | What it counts |
|---|---|
| Appointments | Appointments FOR these days that stood: booked, checked in, or no-show. Not cancelled, moved away or needing re-booking. Counted on the day the appointment is for. |
| Visits opened | Every OPD visit the desk opened in the department in the period. Always Consulted + Still open + Left unseen. |
| Consulted | Consultations completed — on the doctor's screen or marked from the doctor's paper (0025). |
| New / Revisit / Renewal | The split of Consulted. New = new to the HOSPITAL (first completed consultation anywhere). |
| Still open | Opened and not yet completed (waiting, vitals, with the doctor). |
| Left unseen | Visits closed without a consultation: the patient left, or the desk cancelled the visit. |

## DECIDED around the ruling (not ruled; the owner may overturn)

- **A desk correction is one visit, not two.** "Wrong department? Move patient" and "change the doctor" abandon one
  visit and open another for the same person. The abandoned half is counted NOWHERE — not as opened, not as left
  unseen; the visit that stands is counted, in the department it ended up in. Recognised by the move's own reason
  (`wrong department — …`), or by a later visit for the same patient on the same day opened at or after the
  abandonment. Consequence: a patient who truly left and came back the same day reads as one visit.
- **A visit reopened from paper (0025) counts once** — it is the same visit.
- **"Still open" and "Left unseen" are always drawn**, zero or not (Still open used to hide at zero): a row has to
  be addable.
- **"Opened by" needs `staff.reports.read`** as well as `opd.reports.read`. `opd.reports.read` is a department's
  load; what a named clerk did is the staff report's subject (07c), and a reader without it is sent nothing — the
  JSON carries `openedBy: null`, the sheet and the CSV carry no such line.
- **The wire key stays `booked`.** Only the words changed (English "Appointments", Hindi "अपॉइंटमेंट"); the CSV has
  no machine keys, only headers, and its header changed with the screen.
- **Laboratory walk-ins and pharmacy-only visits stay out**, as before.

## Where

`apps/core/src/modules/opd/report.ts` (definitions comment, `isCorrection`, `tally`), `report-render.ts`,
`opd-reports.controller.ts`; `apps/web/src/screens/opd-report.tsx`, `components/opd-report-panel.tsx`.
