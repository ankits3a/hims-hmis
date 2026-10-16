---
type: module-notes
title: "doctor-desk — module notes"
description: "Why and traps of the Doctor Desk (DD-0): the Tower read, waiting-on rows, Clocks Running and the nudge, the login brief lifecycle and the agent-run log."
resource: apps/core/src/modules/doctor-desk
tags: [doctor-desk, opd, roster]
generated: { by: agent:claude, at: 2026-10-16 }
verified: []
stale_after: 2027-01-16
---
# doctor-desk — module notes

Plan: `docs/superpowers/plans/2026-10-04-doctor-desk-PLAN.md` §3.1 (DD-0). Spec: issue #626. A LEAF (plan D-A):
it owns `doctor_desk_briefs`, `doctor_desk_nudges`, `doctor_desk_agent_runs`, `doctor_desk_reads` and writes no
clinical row. It reads lab, radiology, opd, patients and roster through their `index.ts`.

## 1. Key files
- `tower.ts` — `towerView`: the one aggregated read behind `GET /doctor-desk/tower`.
- `scope.ts` — the doctor's unit at READ time (`doctorUnitsOn`, plan D-C) and its members (`teamMembers`).
- `waiting-on.ts` — Needs Your Attention rows: lab criticals, imaging criticals/unread, lab deltas, unfinished visits.
- `owed.ts` — Clocks Running: open obligation bell rows, lab criticals, unfinished visits of unit members, with due times.
- `nudge.ts` — once per row per sender; bell text names the sender and the kind, never a patient (GC6).
- `briefs.ts` — the login brief: built on a return after `BRIEF_GAP_MINUTES` (3 h); lifecycle `briefStage` (contracts).
- `agent-runs.ts` — append-only log; "nothing failed" is read from rows.
- Wire + lifecycle rules: `packages/contracts/src/doctor-desk.ts`. Web: `apps/web/src/screens/doctor-desk-*.tsx`.

## 2. Invariants and traps
- **No money** (decision 0058): the OPD line comes from `opd.doctorDayLines`, which selects no fee column; a test
  scans the whole Tower payload for money words.
- **No model.** Briefs are templates over facts. Prose waits for the decision-0006 toggle (DD-1.6) and must then go
  through `kernel/inference` with counts only and fail closed.
- **Absent, not zero:** OPD tiles only on a day with an OPD session; inpatient figures are not drawn at all.
- A stored brief keeps patient IDs only; names are resolved when read, so a later seal hides them.
- One source failing drops its own rows, never the Tower.
- Door is `opd.consult`; there is no doctor-desk permission (seed-roles untouched).
- **Restricted tests** follow the kernel's rule (DD11, as `lab/patient-results.ts`): the NEXT card's results drop a
  restricted test unless the asker ordered it or holds `orders.read.restricted`, BEFORE the per-analyte pick. The
  Tower's lab readers are keyed on the asker's own orders; imaging uses radiology's `treatedBy` rule. Clocks Running
  rows name no patient and no test.
- Results are `verified` only (not `autoverified`), as the doctor's results reader. Merged patients: the NEXT card
  reads the whole merge chain (`listMergedLoserIds`).
