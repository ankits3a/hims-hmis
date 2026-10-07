---
type: decision
id: "0029"
title: "The registration counter is Desk One; agent information sits in the line of sight"
description: "Desk One is the registration counter design, with agent information kept in the counter's line of sight."
generated: { by: agent:claude, at: 2026-08-31 }
verified: []
status: stable
ruling: ruled
tags: [front-desk, web, copilot]
supersedes: []
superseded_by: ["0039"]
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0029 — The registration counter is Desk One; agent information sits in the line of sight

- **Date:** 2026-08-31   **Status:** Ruled — copilot placement on counter screens partly superseded by 0039
- **Area:** front desk, web (counter screens), copilot

## Decision

Three registration-counter prototypes were put to the owner (greyscale stages with a right AI rail; Desk One;
Counter Cockpit). Rulings, by anchored comments on 2026-08-31:

- **Desk One is the winner** and the converged design.
- KEEP the minimised bottom agent bar (footer dock: ticker, ask box, pull-up log).
- KEEP the search-first find screen ("Who is in front of you?", "a duplicate stopped here costs nothing").
- KEEP the Ctrl+K command button in the header.
- KEEP the "N waiting · Q" live queue pill in the header.
- Real-time agent information cards: YES, but **in the line of sight, never in a sidebar**.
- Counter Cockpit got no element approvals; its implied backend list stays roadmap, not scope.

## Why

The owner liked Desk One's level of detail and wanted the agent's help where the clerk is already looking.

## Consequences / how to apply

- Winning prototype: `docs/design/2026-08-31-registration-counter/desk-one.html` (the other two are kept beside it).
- Build prompt: `docs/superpowers/plans/2026-08-31-EXECUTE-PROMPT-registration-counter.md`.
- Later rulings that build on this: 0032 (the seat screens are Desk One), 0020 (Desk One back on the menu).
- **Partly superseded by 0039 (2026-09-25)** for counter and desk screens: with a patient in hand the copilot panel
  opens in the right column, and large dark "agent speaks on pine" surfaces are replaced by light cards.
