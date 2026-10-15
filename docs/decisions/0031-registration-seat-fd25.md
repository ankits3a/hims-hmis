---
type: decision
id: "0031"
title: "FD-25 seat screens: cashier grants, voice scribe UI only, Desk One off the nav"
description: "The cashier gains four front-desk grants, voice scribe is UI only, and screens 5-6 get no design pass (Desk One off the nav was later reversed)."
generated: { by: agent:claude, at: 2026-09-04 }
verified: []
status: stable
ruling: ruled
tags: [front-desk, security, web-shell]
supersedes: []
superseded_by: ["0020"]
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0031 — FD-25 seat screens: cashier grants, voice scribe UI only, Desk One off the nav

- **Date:** 2026-09-04   **Status:** Partly superseded — ruling 3 reversed by 0020
- **Area:** front desk, security (roles), web shell

## Decision

1. The `cashier` role gains `patients.read`, `tariff.read`, `opd.visits.read` and `opd.visits.open`.
2. **Voice scribe** is UI only, against the inert `POST /api/speech/transcribe`; the DPIA is not widened.
3. `/counter` (Desk One) stays working and stays OUT of the nav. **Reversed 2026-10-01 by 0020.**
4. No design pass for screens 5–6; extend the existing design language.

## Why

The cashier seat needs to find the patient and open the visit it bills; speech capture stays inert until the DPIA
covers it.

## Consequences / how to apply

- Ruling 1 adds grants, not vocabulary: the four permissions already existed.
- The FD-25 seat screens built under these rulings were rejected by the owner and rebuilt as Desk One projections
  (0032).
