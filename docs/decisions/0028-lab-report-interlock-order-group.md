---
type: decision
id: "0028"
title: "An unpaid reflex test holds its whole order group's report"
description: "An unpaid reflex test held the report of every paid order in its order group (superseded: a reflex test is billed on its own bill)."
generated: { by: agent:claude, at: 2026-08-30 }
verified: []
status: deprecated
ruling: superseded
tags: [lab, billing]
supersedes: []
superseded_by: ["0010"]
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0028 — An unpaid reflex test holds its whole order group's report

- **Date:** 2026-08-30   **Status:** Superseded by 0010 (ruling 9)
- **Area:** lab, billing

## Decision

- Finding F45 of Plan 17b: the owner CONFIRMED the **order-group grain** for the report-delivery interlock.
- While an unpaid reflex sibling stands in the same order group, the report of the PAID order is held too, so the
  counter collects once while the patient is there.

## Why

Under either grain the unpaid reflex test's own report stays blocked, so no unpaid result is released either way.
The real choice was between collecting the money and withholding goods already paid for; the owner chose
collection.

## Consequences / how to apply

- **Superseded 2026-09-25 by 0010 ruling 9:** a reflex test is billed on its OWN bill and the per-invoice interlock
  holds only that part of the report. Do not build the group hold from this record.
- Interlock design DD23 of Plan 17b. Handoff: `docs/superpowers/plans/reports/2026-08-30-plan-17b-HANDOFF.md`.
- Related: 0013 (releasing an unpaid report needs the owner; "held until paid is not credit").
