# 0036 — OPD consultations report: PDF and CSV, "New" means new to the hospital, a week is Monday to Saturday

- **Date:** 2026-09-19   **Status:** Ruled
- **Area:** opd, reports, printing

## Decision

- **2026-09-19, the owner's ask:** a front-desk day report as **PDF and CSV**, with the hospital letterhead (logo,
  name, address); body = department-wise appointments booked and consulted, split New / Revisit / Renewal; then one
  PDF/CSV PER DEPARTMENT with a brief and patient rows (name, short address, age, gender, visit type).
- **"New" on this report = NEW TO THE HOSPITAL:** no completed consultation on an earlier day in any department,
  across the patient's merge family. It is not `visit_type = 'new'`, which is the per-department fee branch.
- **2026-09-20, periods:** Today / Yesterday / This week / This month, plus any single day. **A week is MONDAY TO
  SATURDAY.** A Sunday that carried consultations is named on screen and on paper, never silently dropped. A period
  containing today ends today; "this month" runs from the 1st to today.

## Why

The owner named the format; an earlier staff-reports plan that ruled PDF out contradicted this exact ask. Never
decide against a format the owner named.

## Consequences / how to apply

- DECIDED: "Renewal" also covers an existing patient's first visit to a department.
- The server owns `rangeFor(period, anchor)` so the sheet prints the rule the query counted by.
- PDF here = server-rendered HTML opened in a popup inside the click, then `print()`.
- Routes `/opd/reports/consultations…`, permission `opd.reports.read` (front office supervisor, medical
  superintendent, owner); code `modules/opd/report*.ts`. Phase doc `docs/superpowers/plans/2026-09-19-opd-day-report.md`.
