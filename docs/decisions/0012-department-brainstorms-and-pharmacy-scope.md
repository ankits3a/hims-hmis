---
type: decision
id: "0012"
title: "Each remaining department gets its own brainstorm; pharmacy only for now"
description: "Every remaining department gets its own brainstorm; only pharmacy is in scope now, with no patient GSTIN, no old MRP and no home delivery."
generated: { by: agent:claude, at: 2026-09-28 }
verified: []
status: stable
ruling: ruled
tags: [pharmacy, ipd, emergency, insurance-tpa, blood-bank, dialysis, immunisation, ambulance, mortuary]
supersedes: []
superseded_by: []
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0012 — Each remaining department gets its own brainstorm; pharmacy only for now

- **Date:** 2026-09-28   **Status:** Ruled
- **Area:** pharmacy, ipd, emergency, insurance/TPA, blood bank, dialysis, immunisation, ambulance, mortuary

## Decision

- *"IPD, Emergency, Insurance/TPA, Blood Bank, Dialysis, Immunisation, Ambulance, mortuary each will have individual
  brainstorm session. For now, let's only focus on Pharmacy department."*
- Pharmacy rulings the same day (the owner answered "No." to each):
  - Patient GSTIN on the pharmacy bill: **NO.** Every pharmacy bill stays B2C.
  - Old MRP shown beside the new MRP at the counter: **NO.**
  - Home delivery / online orders: **NO.** Do not build them.

  These settle PD-D22 and PD-D19, which 0007 had left to the standing "top hospital standards" instruction.

## Why

The second pharmacy review listed hospital-wide gaps (no tables for any of those departments). The owner wants
each designed in its own session, not folded into pharmacy work.

## Consequences / how to apply

- Do not build a department table, route or screen for those eight departments as part of pharmacy work.
- Pharmacy items that depend on IPD wait for the IPD brainstorm: ward issue, ward returns, IP bill, OPD/IPD toggle,
  MAR.
- TPA credit on the pharmacy bill waits for the Insurance/TPA brainstorm.
- Pharmacy items that do NOT depend on them stay open: ADR/PvPI, medication-error log, fridge temperature log,
  crash-cart/tray checks, the Reserve-antibiotic gate, and the rest of the gap-closure stages.
