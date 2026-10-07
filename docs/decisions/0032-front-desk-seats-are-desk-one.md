# 0032 — The front-desk seats are Desk One; billing keeps every money control

- **Date:** 2026-09-06   **Status:** Ruled
- **Area:** front desk, billing, web

## Decision

- The owner rejected FD-25's three seat screens: *"Just mimic the Desk One screen but bifurcated in three. Don't
  change the UX or UI… the current build has made it worse."*
- `/registration` and `/appointment` are Desk One projected to one stage; `/counter` is Desk One whole.
- **`/billing` keeps EVERY money control** and only wears Desk One's frame. Desk One's bill stage is a strict subset
  (it lacks hand-built lines, discounts with approval, mixed and partial tenders, credit, PAN / Form 60, package
  balances, invoice print), so the billing counter is not cut down into a stage.
- The seats **own the viewport**, like Desk One.

## Why

A copy of a screen drifts by construction; one component with a seat parameter cannot. Money controls that already
ship are not removed for the sake of a look.

## Consequences / how to apply

- One component, `DeskOne({ seat })`; `seat` defaults to `"counter"`, the identity. Billing wears
  `desk-one/seat-shell.tsx`; `billing-counter.tsx` is not edited into a stage.
- Staff reports track the act, not the seat (0035), because the same act writes the same row from any seat.
- Related: 0029 (Desk One chosen), 0031 (the FD-25 screens this replaced), 0020 (Desk One on the menu).
