# 0035 — Staff reports: count the act, not the seat; MRD gets its own permission; history horizon by role

- **Date:** 2026-09-14   **Status:** Ruled
- **Area:** staff reports, security (permissions), mrd

## Decision

1. **No seat column.** Reports track the ACT, not the screen it was done from.
2. **The MRD register gets its own permission, `mrd.register.read`**, audited, with no typed reason. It is not a
   widening of the staff drill, and it is **not capped** by the history horizon (statutory retention runs to years).
3. **History horizon per role:** `front_office` 3 months and only their OWN figures; `front_office_supervisor`
   1 year; `medical_superintendent`, `staff_auditor` and `owner` unbounded.

## Why

Each was chosen over a cheaper option because the cheaper one changes what a number MEANS. Widening the staff drill
for MRD would turn supervision into bulk PHI export.

## Consequences / how to apply

- Horizons are permissions (`staff.reports.history.year` / `.full`), not a role-to-horizon map, because roles
  combine and permissions union.
- The owner role holds `staff.reports.read` with the unbounded horizon, deliberately not the drill.
- "New patient" and "department" each have two meanings and are never used bare (see 0036 for "New" on the OPD
  report).
- Plan: `docs/superpowers/plans/2026-09-14-phase1-staff-reports.md`.
