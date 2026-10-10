---
type: decision
id: "0065"
title: "Copilot questions are logged only with a staff notice, and are deleted after 180 days by their own job, separate from the patient-record retention sweep"
description: "The owner ruled that the copilot ledger records staff questions on production only together with a one-time notice to each user, and that copilot question rows are deleted after 180 days by their own always-on nightly job, while the patient-record retention sweep stays switched off until counsel signs its values."
generated: { by: agent:claude, at: 2026-10-10 }
verified: []
status: stable
ruling: ruled
tags: [copilot, ai, privacy, retention, staff, law]
supersedes: []
superseded_by: []
sources:
  - { id: copilot-plan, resource: "docs/superpowers/plans/2026-10-10-copilot-PLAN.md", title: "Staff copilot plan v2, epic E0.1" }
---
# 0065 — Copilot ledger: staff notice first, and its own 180-day deletion

- **Date:** 2026-10-10   **Status:** Ruled
- **Area:** copilot ledger (`kernel/copilot/ledger.ts`, `copilot_asks`, `copilot_acts`)

## What is ruled (owner, 2026-10-10)

1. **Notice first.** The ledger is a per-employee activity log, and staff are data principals under the DPDP Act.
   It records on production only together with a one-line notice each user sees once before their first copilot
   question: "Copilot questions are logged for 180 days for safety and quality. No one sees a per-person list."
   (English and Hindi). The phone app shows the same notice when its copilot arrives (plan E1.3).
2. **Own 180-day deletion.** Copilot question rows (`copilot_asks`) are deleted after 180 days by their own nightly
   job (`pruneCopilotAsks`), which runs whether or not `RETENTION_ENABLED` is set. They are staff operational rows,
   not patient-event records, so legal holds on patient records do not govern them.
3. **Unchanged:** the patient-record retention sweep stays inert (owner ruling 6) until counsel signs its values.
   Copilot act rows (`copilot_acts`) are kept as long as the record they changed and are never edited or deleted.

## Why

The ledger makes goals G1, G3, G4 and G6 of decision 0064 measurable. Without its own deletion, the notice's
"180 days" would have been untrue on production, where the general retention sweep is switched off.
