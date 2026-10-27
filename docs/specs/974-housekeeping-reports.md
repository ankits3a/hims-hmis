---
issue: 974
status: built
approved: 2026-10-26
built: 2026-10-26
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

## Build notes (2026-10-26)

Built on lane `hk-reports-974`, stacked on `hk-rounds-973`. Acceptance checks:
`apps/core/src/modules/housekeeping/acceptance/reports-974.acceptance.test.ts` (D1–D5) and
`apps/mobile/__tests__/acceptance/housekeeping-974.test.tsx` (D6). Choices made by standard practice, none of them money
or law:

- A floor is linked to one materials store; indents, issues and receipts stay in materials. The month is the IST month,
  and a receipt counts on the day it is received. The value is the batch's landed cost on the transfer.
- Occupied bed-days use the midnight census (00:00 IST). A floor with no IPD bed shows the total only.
- The two inspections per floor are drawn by a hash of the floor and the shift. A floor that already has its draw is
  skipped, so a rerun draws nothing new. The supervisor scans the area's own QR, answers eight NABH items and takes one
  photo.
- A failed inspection raises a new task, "Rework after inspection". It goes to the floor team's pool, is proved like any
  other clean, and is checked by the supervisor through HK-1's Pass/Fail.
- The contractor report credits work to the company recorded with the attempt. A round nobody finished goes to its
  holder's company. Rounds are counted by due time, turnaround by release time, first-time pass by the first attempt,
  and inspections by the company that last worked the area.
- The floor supervisor (`services_supervisor`) now holds `materials.stock.read` and `materials.stock.receive`, so it can
  raise and receive the floor store's indents.
- On the staff app, the attendant's list is behind `tasks.work`. The check list is behind `ipd.beds.clean`, and also
  opens for `housekeeping.confirm` or `housekeeping.verify_terminal`.

