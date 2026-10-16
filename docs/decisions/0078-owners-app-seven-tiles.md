---
type: decision
id: "0078"
title: "The owner's app is seven tiles; the Medical Superintendent sees everything except the Money page; the Staff page ships without attendance"
description: "Owner 2026-10-09: the owner's phone home is seven tiles (money, consultations with/without prescription per doctor, tele-calls and appointments, pharmacy, learning, compare, staff) over today/week/month/custom; the MS sees all but Money. Read-only counts and sums. Shipped in #564 (#561)."
generated: { by: agent:claude, at: 2026-10-15 }
verified: []
status: stable
ruling: ruled
tags: [owner, mobile, reports, money, billing, staff]
supersedes: []
superseded_by: []
sources: []
---
# 0078 — The owner's app: seven tiles

- **Date:** 2026-10-09 (recorded 2026-10-15, #648)   **Status:** Ruled
- **Area:** mobile staff app (owner home), reports (billing, opd, pharmacy, roster)

## The owner's words (2026-10-09)

*"'Owner's app screen' should add: Money today in detail. consultations with prescription on record vs not, per
doctor. Tele-calls and appointments today. week, month, custom. Pharmacy today. … Learning … Compare … Staff …"*

*"Home as seven tiles (drawn). … Medical Superintendent too but Money page for owner alone. Staff page without
attendance, as described: acceptable for now."*

## What is ruled

1. The owner's phone home is **seven tiles**: Money, Consultations (with a prescription on record vs not, per
   doctor), Tele-calls and appointments, Pharmacy, Learning, Compare, Staff — each over today, week, month or a
   custom range.
2. The **Medical Superintendent** gets the same home **except the Money page**, which is the owner's alone.
3. The **Staff** page ships **without attendance** for now (attendance arrived later, decision 0060).

## DECIDED (standard practice)

- **No new permission.** The tile home is shown to a login holding `staff.reports.read` + `staff.reports.history.full`
  + `opd.reports.read` + `roster.read` (owner and MS). The Money tile also needs `billing.reports.read`, which the MS
  role does not hold — that is how "Money for the owner alone" is enforced.
- Every read is **read-only, counts and sums only**, at most 92 days, no future dates; pharmacy rupees only with
  `pharmacy.reports.read`. The owner role gained `opd.masters.manage` (to undo a learned nickname).
- A tile with no real data behind it is not drawn (per-counter pharmacy split, staff absences before attendance).

## Consequences / how to apply

- Routes: `GET /billing/reports/owner-money`, `GET /opd/reports/appointments-summary`, `GET /opd/reports/learning`,
  `GET /pharmacy/office/reports/owner-summary`, `GET /roster/staff-today`; `/opd/reports/recording` takes `from`/`to`.
- Shipped in #564 (joined staging build 0.15.0), which carried #561.
