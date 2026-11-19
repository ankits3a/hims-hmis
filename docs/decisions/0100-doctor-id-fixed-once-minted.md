---
type: decision
id: "0100"
title: "The Doctor ID is fixed once minted; an admin cannot change it"
description: "OPD Admin cannot edit a doctor's Doctor ID (DR-nnnn) after the doctor is created; the server refuses a change."
generated: { by: agent:claude, at: 2026-11-19 }
verified: []
status: stable
ruling: ruled
tags: [opd, printing, legal]
supersedes: []
superseded_by: []
sources:
  - { id: spec-1127, resource: "docs/specs/1127-opd-doctors-panel.md", title: "Spec: OPD Admin → Doctors works like the Users screen" }
---
# 0100 — The Doctor ID is fixed once minted

- **Date:** 2026-11-19   **Status:** Ruled
- **Area:** opd; printing, law (#1127)

## Decision

While the Doctors tab of OPD Admin was redesigned (#1127), the owner was asked whether an admin may edit a doctor's
Doctor ID. The owner answered: "No, admin should not be able to edit doctor id."

The Doctor ID (`DR-nnnn`, minted at creation) is what every hospital prescription prints (decision 0033). Once a
doctor exists it never changes: the Doctors panel shows it with no box to edit it, and `PATCH /opd/doctors/:id`
refuses a `code` with `doctor_id_fixed`. Creating a doctor may still take a hospital's own faculty number in place of
the minted one; that is not an edit.

## Why

A changed id makes every prescription already printed under the old one name nobody.
