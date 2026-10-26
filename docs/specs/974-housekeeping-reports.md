---
issue: 974
status: approved
approved: 2026-10-26
---
# SPEC — Housekeeping HK-2: floor consumables, inspections, contractor SLA report, daily and monthly reports (#974)

Status: APPROVED 2026-10-26 by the owner ("go with your logical recommendation"). Builds on HK-1 (#973). The owner's rulings are in decision 0086.

## What

- **Floor stores.** Each floor's housekeeping cupboard is a materials sub-store (custodian: the floor supervisor). The
  supervisor raises an indent on the central store. The store keeper issues it, and the floor receives it. This is the
  existing indent and transfer flow, with no new stock path.
- **Monthly consumables.** For each floor and month, the report shows each item received (quantity and value at the
  store's cost), and the cost per occupied bed-day. Wards use IPD bed-days. Floors without beds show the total only.
- **Random inspections.** The system draws random C and D areas each shift (DECIDED: 2 per floor per shift). The
  supervisor scans the area, scores a short checklist and takes a photo. A failed inspection raises a rework task on
  the floor team, using HK-1's fail path.
- **Contractor SLA report.** For each contractor and month, the report shows: rounds done on time, rounds late or
  missed, discharge-clean turnaround (median and 90th percentile), first-time pass rate and inspection score. It is a
  report only, with no deductions (0086). The same view is shown for in-house staff, so the two can be compared.
- **Daily report.** For each floor and shift: rounds due, done and missed, bed turnarounds, requests raised and closed,
  fails and rework, and inspections.
- **Phone (Expo).** The attendant's list, door scan, checklist and photo, and the supervisor's Pass or Fail, on the
  staff app. These are the same doors as HK-1's web phone screens.

## Decisions (DECIDED by standard Indian corporate-hospital practice)

- A floor's consumption is what the floor receives in the month. There is no per-use count: issue to a floor store
  books the expense, as most hospitals do for housekeeping.
- Inspection checklists follow NABH housekeeping audit items. The pass mark is 80 %.
- Reports show company names and initials only. They show no attendant's full name.

## Done means

- **D1** A floor supervisor raises an indent for a floor store. The store keeper issues it, and the floor receives it.
  The month's report for that floor then shows the items, quantities and value.
- **D2** The monthly consumables report shows the cost per occupied bed-day for a ward floor.
- **D3** Each shift has random C or D areas drawn for inspection. A failed inspection opens a rework task for the floor
  team.
- **D4** The contractor SLA report for a month shows, for each contractor, rounds on time, late or missed, the
  turnaround median and 90th percentile, first-time pass rate and inspection score. It shows no deduction or money
  figure.
- **D5** The daily report for a floor and shift counts rounds due, done and missed, turnarounds, requests, fails and
  inspections, and matches the tasks behind each count.
- **D6** An attendant completes a task (scan, checklist, photo) on the staff app, and a nurse passes it there.
