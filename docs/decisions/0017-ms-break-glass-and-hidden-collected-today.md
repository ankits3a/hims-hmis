# 0017 — The Medical Superintendent holds break-glass; "collected today" is hidden from the cashier

- **Date:** 2026-09-28   **Status:** Ruled
- **Area:** security (roles), patients (confidential records), billing (cash sessions), pharmacy

## Decision

1. **The Medical Superintendent gets break-glass.** The `medical_superintendent` role holds the break-glass
   permission (it had been deliberately withheld pending a ruling). This unblocks merging sealed records: the MS
   records a break-glass, then approves (PR #373).
2. **"Collected today" is hidden from the cashier.** On any screen, the cashier (and a pharmacist at their counter)
   does not see their own "collected today" until their count is submitted. The receipt count may still show.
   Supervisors still see the figure.

## Why

- Indian corporate hospital cash control: float plus collected reveals roughly the expected cash, which defeats the
  blind count (0014).
- The MS is the custodian of confidential records.

## Consequences / how to apply

- Adding a permission to a role owes the README role-table prose and moves the pinned counts in `seed-roles.test`.
- Seed changes need `seed-roles` run on deploy.
