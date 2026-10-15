---
type: decision
id: "0032"
title: "The front-desk seats are Desk One; billing keeps every money control"
description: "The registration and appointment seats are Desk One projected to one stage; /billing keeps every money control in Desk One's frame."
generated: { by: agent:claude, at: 2026-09-06 }
verified: []
status: stable
ruling: ruled
tags: [front-desk, billing, web]
supersedes: []
superseded_by: []
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
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
