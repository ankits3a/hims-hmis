---
type: module-notes
title: "tasks — module notes"
description: "Why and traps of the shared task engine: the kind registry, dispatch from the roster, exactly-one accept, duplicate merge, the one-minute task clock and its escalation ladder, and the two screens."
resource: apps/core/src/modules/tasks
tags: [tasks, ipd]
generated: { by: agent:claude, at: 2026-10-12 }
verified: []
stale_after: 2027-01-12
---
# tasks — module notes

Hand-written notes: the WHY and the traps. Signatures, routes and tables are generated in
`docs/architecture/modules/tasks.md`. Paths are relative to `apps/core/src/modules/tasks/` unless they
start with a module name, `kernel/`, `scripts/` or `apps/`. Citations name a file and a symbol, never a line number.
Update this file in the same PR when you change a flow, an invariant or a trap below.
Spec: SPEC-ipd-companions §2, §10, §11 (kept outside the repository); issue #713, decision 0072.

## 1. Purpose
One engine for every service request — a bed to clean, a bag to collect, a patient to move. Owning modules
(housekeeping, bmw, transport, linen, maintenance) declare their KIND and raise tasks; the engine runs every kind
through the same states, dispatch, clock and escalation ladder. A task is: kind, place (a resource-registry node),
optional patient, priority, due time, skill, assignee (person today; team or machine later), proof, verify step.

## 2. Key files (owner of what)
- `kinds.ts` — `defineTaskKind` (the registry, at import time, once per kind), `defineSkill` / `skillRoles`
  (skill → RBAC role codes), `GENERAL_TASK` (the one shipped kind), `DEFAULT_LADDER_MIN`, `SERVICES_SUPERVISOR_ROLE`.
- `engine.ts` — every intent: `raiseTask`, `assignTask`, `acceptTask`, `startTask`, `completeTask`, `verifyTask`,
  `cancelTask`, `cancelTasksForPlace`, `returnToPool`; `dispatchInto` (offer a pool task). Each parses its input
  with the zod schema in `packages/contracts/src/tasks.ts`.
- `dispatch.ts` — `onDutyForSkill`, `dutyCovering`, `openLoad`, `pickWorker`: who is on and who gets the next task.
- `sweep.ts` — `sweepTasks`, the worker job (`kernel/worker/jobs.ts`, every minute).
- `reads.ts` — `myTasks` (a worker's list + the pool of their skills), `taskBoard` (the supervisor board).
- `errors.ts` — `TaskError` (code + sentence + fix, from `TASK_REFUSALS`), `taskHttpStatus`.
- `tasks.controller.ts` — the doors; `manifest.ts` — `tasks.view`, `tasks.work`, `tasks.supervise`.
- Schema `kernel/db/schema/tasks.ts` — `tasks`, `task_events` (append-only by trigger, migration `*_tasks_engine.sql`).
- Web: `apps/web/src/screens/my-tasks.tsx` (`/tasks`, phone), `apps/web/src/screens/tasks-board.tsx`
  (`/tasks/board`, 16:9), `apps/web/src/lib/tasks-api.ts`, styles `apps/web/src/screens/tasks.css`.
- Test fixture `apps/core/test/helpers/tasks.ts` — `seedTaskHospital`, `putOnDuty` (times relative to the real clock).

## 3. Main flows
### 3.1 Raise → dispatch
`raiseTask`: unknown kind / place refused. With a place, a transaction advisory lock on (kind, place) is taken and an
open task of the same kind, place AND patient (null-safe) raised within `MERGE_WINDOW_MS` (10 min), read
`FOR UPDATE` so a task closing under us is not merged into, is MERGED (`merged_count + 1`, event
`merged`, `merged: true` returned). Otherwise a row is inserted (`due_at` = given or now + `doneWithinMin`) and
`dispatchInto` offers it to `pickWorker`: holders of the skill's roles who are active, not on approved leave
(roster `absentUserIds`) and inside a published PRESENCE duty (roster `dutiesOf`); fewest open tasks, ties by
earliest shift start, then id. Nobody on → it stays `created` (the pool).

### 3.2 The worker's road
assigned → `acceptTask` (refused `wrong_skill` without a role of the task's skill, `not_on_duty` without a
covering presence duty — `assignTask` makes the same two checks) → accepted → `startTask` → in_progress → `completeTask` (proof checked) → done →
`verifyTask` → verified (only kinds with `verifyRequired`). `returnToPool` from any held state; `cancelTask` from any
open state (reason required).

### 3.3 The clock (`sweepTasks`)
Every pass selects only rows it can act on (in SQL: the next rung actually due, the accept window actually
past, a skill someone on duty holds), so a batch is never filled by rows it would skip; every pass and every
row has its own try/catch, so one failure stops nothing else.
1. Shift over: held task with `shift_ends_at <= now`, a NULL shift end and no duty now, or a holder on
   approved leave now (roster `absentUserIds`) → back to the pool + `task.returned` notice to the kind's
   `escalateTo` role, unless the worker has a back-to-back duty (the end moves on, no event).
2. Not accepted within `acceptWithinMin` → `redispatched` to the next worker (excluding the current one); nobody
   else → window restarts, no event.
3. Pool → offered again, skipping the worker it was last returned from (`lastReturnedFrom`).
4. Late → the next rung of the ladder (`ladderMin`, default due + 0 and due + 30 min) ONCE: `escalated_rung` is
   raised under the row lock, event `escalated`, `task.late` notice IN THE SAME TRANSACTION (a failing bell
   rolls the rung back and the next tick retries both) (`kernel/alerts/notices.ts` `raiseNotice`,
   source key `task:<id>:rung:<n>`).

## 4. Invariants and traps
- **Every row change bumps `version` and appends exactly one `task_events` row with `seq = version`, in the same
  transaction.** The pair (task_id, seq) is the primary key, so a skipped `updateTaskRow` shows as a PK clash or a gap.
  The two clock writes that change no hands (`shift_ends_at` carried forward, `assigned_at` restarted) deliberately
  bypass `updateTaskRow` and write no event.
- **Exactly one accept wins** because `acceptTask` is ONE conditional UPDATE (`state in (created, assigned)` and
  unassigned-or-mine). Never turn it into read-then-write: `acceptance/one-accept-wins.test.ts` holds the row lock
  in a third session and was red against exactly that mutant.
- Nobody holds a task off duty: accept and assign require a covering presence duty, and the clock returns a held
  task whose holder has none (or is on leave).
- **The kind registry is in-process.** A kind must be defined by code both the API and the worker import (an owning
  module's `index.ts`), or the worker's sweep sees an unknown kind (it falls back to a 5 min accept window and the
  default ladder, and tells no one, because `escalateTo` is unknown).
- Skills are RBAC roles, not roster positions: the roster has no skill concept. `general` → `support_staff`.
- Verification: the doer never verifies (`verifier_is_doer`); the verifier holds ONE OF the kind's
  `verifierPermission` (a string or a list; default `tasks.supervise`). The `/verify` door admits `tasks.work` too, so a
  kind may name a narrower permission; an owning module may also open its own verify door (housekeeping does).
- A kind's `onVerified(tx, task, actor, now)` runs inside `verifyTask`'s transaction after the row is verified; a throw
  rolls the verification back (housekeeping frees the bed there).
- `nudgeTask` (sweep.ts): a person escalates an open task now — an `escalated` event with `detail.nudge`, a
  `task.nudge` bell to the kind's escalation role and the holder; the ladder's rung is not moved; a second nudge
  within `TASK_NUDGE_WINDOW_MIN` (5) is refused `nudged_recently`.
- `raiseTask` input `sourceRef` (unique, `tasks_source_ref_ux`): one task per owning-module source — a second raise
  returns the first task with `duplicate: true` and skips the merge window. `raisedAt` stores when the need arose.
  `cancelTask(..., { closeDone: true })` lets an owning module also cancel a done-but-unchecked task.
- `taskBoard(db, now, { kinds })` is the same board over an owning module's kinds; `findTasks` / `getTask` let an owning
  module read its own tasks without touching the table.
- The board's counts are SQL over every open task; it sends at most `BOARD_ROW_LIMIT` rows and reports the rest
  as `counts.notShown`. The requester's free-text note is on the worker's own card only, never the board.
- No patient identity and no money on either surface (wall-board rule; decision 0058's spirit). `patient_id` is stored
  for the owning module, never rendered.
- Notices carry kind, place and minutes late — never a patient.
- The worker job holds one pool client per act; batches are `SWEEP_BATCH` (50) per pass.

## 5. Who calls tasks
- kernel: worker (`sweepTasks` every minute, `kernel/worker/jobs.ts`); manifests (`tasksManifest`, API only).
- housekeeping (E1.4): four kinds, `raiseTask`, `cancelTask`, `verifyTask`, `nudgeTask`, `findTasks`, `taskBoard`.
- Planned (later lanes): bmw, transport, linen, maintenance — each through `index.ts`: `defineTaskKind`, `defineSkill`, `raiseTask`, `cancelTasksForPlace`.
