---
type: decision
id: "0018"
title: "Patient profile layout; recording a death requires the death certificate number"
description: "The patient profile follows the approved three-column board, and recording a death requires the death certificate number."
generated: { by: agent:claude, at: 2026-09-29 }
verified: []
status: stable
ruling: ruled
tags: [patients, front-desk, billing, legal]
supersedes: []
superseded_by: []
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0018 — Patient profile layout; recording a death requires the death certificate number

- **Date:** 2026-09-29   **Status:** Ruled
- **Area:** patients, front desk, billing, legal

## Decision

- The owner approved the patient profile board (https://claude.ai/artifact/NGo16XLKBEbzSDQa5npwbr). Layout of
  `/patients/:id`:
  - Left: identity, with an allergies band at the top.
  - Centre: a "Today" band, then one dated timeline with no filter chips.
  - Right: the actions this person's permissions allow.
  - Editing happens in a drawer.
  - A restricted record shows the alias; only the Medical Superintendent can break glass.
  - Front desk sees dues (decided by standard practice).
- **Law ruling:** "Record a death" cannot save without the death certificate number. For a death in this hospital
  that is the MCCD certificate (Form 4 / 4A) number. (Before this it saved with a date only.)
- **2026-09-30:** the front desk gets a NARROW permission to read one patient's dues — not `billing.invoice.read`,
  which would open the whole invoice list. The profile's "Today" band and its dues use it.

## Why

The Registration of Births and Deaths Act requires medical certification of cause of death for in-institution
deaths.

## Consequences / how to apply

Enforce the certificate number on the server (required field, refusal with a sentence), not only on the screen.
