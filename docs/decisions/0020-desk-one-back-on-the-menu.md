# 0020 — Desk One is back on the menu

- **Date:** 2026-10-01   **Status:** Partly open
- **Area:** web shell (navigation), front desk

## Decision

- Owner, on staging: *"On the dashboard screen of Front Desk staff, I can't see any menu items that would open
  /counter. We definitely need to work on menu and its UI and placement."*
- This REVERSES the FD-25 ruling of 2026-09-05 that `/counter` (Desk One) stays working but stays out of the nav.
  (That earlier ruling is recorded in the FD-25 registration-seat notes, not yet in this folder.)
- Desk One is a nav row again: first in the desk group, on permission `opd.visits.open`, labelled "Desk One"
  (`nav.billing` is already "Counter").

## Why

A door reachable only from the command palette is invisible to the person who looks at the menu.

## Consequences / how to apply

- Do not remove the Desk One row citing the 2026-09-05 ruling.
- The menu became a bar (PR #432): its own strip under the identity row, 13.5px ink labels, current place filled.
  Past ten visible places (`NAV_FOLD_AT` in `apps/web/src/router.tsx`) each group folds into one button with a
  panel; a front desk's seven stay flat.

## Open

- Whether the new bar is what the owner wanted was not yet confirmed.
- The "OPD" group holds 32 places for an owner (imaging, lab, theatre, pharmacy all under it) and wants regrouping.
