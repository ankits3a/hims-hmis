---
type: decision
id: "0093"
title: "Pharmacy go-live: quick desk stays on, the doctor agrees to an H/H1 brand swap, unknown-rate opening stock is an estimate"
description: "Three owner rulings from the 2026-11-13 pharmacy review: quick desk mode stays on in production, substituting a Schedule H/H1 brand needs the prescriber, and opening stock with no known purchase rate is valued at a flagged estimate."
generated: { by: agent:claude, at: 2026-11-13 }
verified: []
status: stable
ruling: ruled
tags: [pharmacy, materials, legal, money]
supersedes: []
superseded_by: []
sources:
  - { id: spec-1046, resource: "docs/specs/1046-pharmacy-counter-go-live.md", title: "Spec: pharmacy counter go-live" }
  - { id: spec-1047, resource: "docs/specs/1047-pharmacy-stock-in-go-live.md", title: "Spec: pharmacy stock-in go-live" }
---
# 0093 — Pharmacy go-live: quick desk stays on, the doctor agrees to an H/H1 brand swap, unknown-rate opening stock is an estimate

- **Date:** 2026-11-13   **Status:** Ruled
- **Area:** pharmacy, materials, law, money

## Decision

The owner answered three questions after the 2026-11-13 pharmacy architecture review:

- **Quick desk mode stays ON in production.** Asked "on or off at go-live", the owner chose **On**. Decision 0022
  stands unchanged: exactly three checks stand down while it is on.
- **A Schedule H/H1 brand swap needs the prescriber.** Asked whether the doctor must agree before the pharmacist swaps
  a Schedule H/H1 brand for another brand of the same salt, strength, form and route, the owner chose **Doctor must
  agree**. The swap goes to the prescriber's desk card, as the allergy override does (0007). Unscheduled (OTC) lines
  keep the patient's consent alone. Schedule X is never substituted (unchanged). Quick desk mode does not stand this
  check down.
- **Opening stock with no known purchase rate is an estimate, flagged.** Cost per pack = MRP per pack without GST
  (MRP ÷ (1 + the item's GST rate)) less 20% trade margin, rounded down to the paisa, and marked *estimated* so stock
  valuation and margin reports show it apart. A real rate typed on the row always wins.

## Why

The review found that today's code allows an H/H1 brand swap on the patient's consent alone, and that the opening
count has no rates for much of the shelf. The owner keeps quick desk mode for counter speed, knowingly (as in 0022).

## Consequences / how to apply

- Spec #1046 D7 builds the substitution rule; spec #1047 D7 builds the estimated cost.
- Do not "fix" quick desk mode as a defect; widening it still needs a new ruling (0022).
- The CA may later replace the 20% margin; that is a new ruling, not an edit of this one.
