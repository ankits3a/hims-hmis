---
type: module-notes
title: "doctor-desk — module notes"
description: "Why and traps of the Doctor Desk (DD-0, DD-1): the Tower read, waiting-on rows, Clocks Running, nudge and move, the act after an acknowledgement, the scope ladder, the phone boards, work ratings, the login brief and the agent-run log."
resource: apps/core/src/modules/doctor-desk
tags: [doctor-desk, opd, roster]
generated: { by: agent:claude, at: 2026-10-16 }
verified: []
stale_after: 2027-01-16
---
# doctor-desk — module notes

Plan: `docs/superpowers/plans/2026-10-04-doctor-desk-PLAN.md` §3.1 (DD-0), §3.2 (DD-1). Specs: issue #626;
`/opt/hmis-context/SPEC-doctor-desk-dd1-2026-10-16.md`. A LEAF (plan D-A): it owns `doctor_desk_briefs`,
`doctor_desk_nudges`, `doctor_desk_agent_runs`, `doctor_desk_reads`, and (DD-1) `doctor_desk_moves`,
`doctor_desk_acts`, `doctor_desk_ratings`, and writes no clinical row. It reads lab, radiology, opd, patients and roster through their `index.ts`.

## 1. Key files
- `tower.ts` — `towerView`: the one aggregated read behind `GET /doctor-desk/tower`.
- `scope.ts` — the doctor's unit at READ time (`doctorUnitsOn`, plan D-C) and its members (`teamMembers`).
- `waiting-on.ts` — Needs Your Attention rows: lab criticals, imaging criticals/unread, lab deltas, unfinished visits.
- `owed.ts` — Clocks Running: open obligation bell rows, lab criticals, unfinished visits of unit members, with due times.
- `nudge.ts` — once per row per sender; bell text names the sender and the kind, never a patient (GC6).
- `briefs.ts` — the login brief: built on a return after `BRIEF_GAP_MINUTES` (3 h); lifecycle `briefStage` (contracts).
- `agent-runs.ts` — append-only log; "nothing failed" is read from rows.
- DD-1: `scope.ts deskLevel` (own/member/unit/department/hospital, derived); `unit-board.ts` (owed oldest first, your
  people, units side by side); `moves.ts` (Move: head or SR; event `doctor_desk.row_moved` in `events.ts`); `acts.ts`
  ("What did you do?", critical→act); `phone.ts` (SR Now, Professor, Handled without you); `ratings.ts` (rate, my
  ratings vs anonymous averages, logbook CSV).
- DD-report v0: `report.ts` — `sendUnitReports` (worker job `sendUnitReports`, `dailyIst("08:00")` in `kernel/worker/jobs.ts`),
  `reportsFor` (GET `/doctor-desk/reports`, web `/doctor-desk/report`).
- `copilot-tools.ts` — DD-0.10: three floor-only Ask-bar intents (`doctor-desk.waiting_on_me`, `.unit_owes`, `.my_day`)
  through the module intent seam (#865). Named `doctor-desk.*`, not the plan's `doctor_desk.*`: the seam requires
  `<module key>.`. No menu, no help line, so the pinned chat system-prompt hash and the eval set are unchanged.
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
- Copilot answers are counts only (and a unit NAME); the cues stay two points clear of `patient_dues`'s bare `baaki`
  (MIN_MARGIN 2) — a new cue near "baaki" needs a routing row in `copilot.test.ts`.
- DD-0.11 lives in radiology (`modules/radiology/chasers.ts`): the unread-report chaser alerts the ordering doctor at 24 h, the
  duty-manager route 12 h later; those `imaging_chase` bells show in Clocks Running like any other.
- **Restricted tests** follow the kernel's rule (DD11, as `lab/patient-results.ts`): the NEXT card's results drop a
  restricted test unless the asker ordered it or holds `orders.read.restricted`, BEFORE the per-analyte pick. The
  Tower's lab readers are keyed on the asker's own orders; imaging uses radiology's `treatedBy` rule. Clocks Running
  rows name no patient and no test.
- Results are `verified` only (not `autoverified`), as the doctor's results reader. Merged patients: the NEXT card
  reads the whole merge chain (`listMergedLoserIds`).
- **D3 — a read-back is not the act.** A lab critical call the lab CLOSED stays on the Tower and in Clocks (`acked`,
  amber) for 7 days until a `doctor_desk_acts` row exists; an act removes open and closed alike. DD-0's "closing drops
  it" became this in DD-1.
- **Move never edits the source row.** The newest `doctor_desk_moves` row of a key decides the holder in `owedByUnit`
  (`withMoves`); a move to someone who left the unit is ignored. Audit = the event, in the same transaction.
- **Scope is derived.** HOD = officiating `hod` row in force, or a department-scoped `roster.periods.publish` grant (the
  rule leave uses); MS = the `medical_superintendent` role. An officiating head is `unit` only inside the window
  (`teamMembers` already returns them as head only then).
- **Ratings are never a league table.** Only the rated resident (own figures, own CSV) and the rater see a rating; the
  averages are anonymous shares with floors (`RATING_MIN_*` in contracts): the asker is LEFT OUT of the pool, which needs
  3 other residents and 10 ratings, settled days only (up to yesterday), rounded to the nearest 5 %. The CSV names no rater and no patient, and
  defuses a leading `= + - @`.
- **Copilot toggles are #861's** (`/opd/consult/copilot-settings`, opd's `cds_doctor_prefs`); the Desk only reads them on
  the web for the status line. Owed, nudge, move and act never read them (D1; `dd1.test.ts` DM7).
- **The unit report is an agent-run row** (`agent = unit_report`, report in `params.report`), not a table of its own: one
  per unit per report date, written under `pg_advisory_xact_lock` and only if none exists; the bell's source key is the
  same unit+date. `runsFor` hands the Tower only the flat params. Counts only — no patient, no person, no names in the
  bell. Medians use the ratings' floors (`RATING_MIN_OWN` for the unit; 3 units + 10 acts for department/hospital).
- **One job, three reports.** `sendUnitReports` also makes the HOD's daily (`department_report`, scope = `params.departmentId`;
  recipients `departmentHeads`) and, on a Monday, the MS's weekly (`hospital_report`, the 7 days before; recipients
  `superintendents`). Same `deliverOnce` (lock + row + bell key per scope per period); no new job name, so no new alert rule.
- **A new job is a seven-site census** (`kernel/worker/jobs.ts`, `kernel/worker/jobs.test.ts`, `kernel/worker/scheduler.test.ts` ×2,
  alerts-parity ×2, alerts.yml ×2, worker-runtime e2e). A `dailyIst` job leaves the interval pool sum (`kernel/db/client.test.ts`) unchanged.
- **Nobody appoints themselves.** `deskLevel` (unit and department) and `departmentHeads` ignore an officiating row whose
  `approved_by` is its own holder. The roster's `recordOfficiating` refuses self-appointment too (separate PR).
- **The Professor's asks are the server's**: `asksFor` reads the approver's worklist and keeps an ALLOWLIST of non-money
  kinds (`PROFESSOR_ASK_KINDS`), id + kind + time only. The phone never reads `/approvals` itself.
- **An act appends `doctor_desk.critical_acted`** in the act's transaction. **"Owed at 08:00"** is `owedByUnit(…, 08:00)`:
  rows that started later are left out and acts are counted as of that instant (`actedKeys(…, asOf)`).

