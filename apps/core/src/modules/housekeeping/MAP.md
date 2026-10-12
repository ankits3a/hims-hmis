---
type: module-notes
title: "housekeeping — module notes"
description: "Why and traps of bed turnover on the task engine: one cleaning task per bed release from the bed's kernel events, terminal vs routine, verification that frees the bed in the same transaction, cancellation when the bed leaves cleaning, the Beds board's cleaning clocks and the supervisor board."
resource: apps/core/src/modules/housekeeping
tags: [housekeeping, tasks, ipd, beds]
generated: { by: agent:claude, at: 2026-10-12 }
verified: []
stale_after: 2027-01-12
---
# housekeeping — module notes

Hand-written notes: the WHY and the traps. Signatures, routes and tables are generated in
`docs/architecture/modules/housekeeping.md`. Paths are relative to `apps/core/src/modules/housekeeping/` unless they
start with a module name, `kernel/`, `scripts/`, `packages/` or `apps/`. Citations name a file and a symbol, never a
line number. Spec: SPEC-ipd-companions §3, §10, §11 and SPEC-ipd-core §4.1, §4.9 A (kept outside the repository);
issue #721, decision 0072.

## 1. Purpose
Bed turnover. A bed released into cleaning gets exactly one cleaning task on the shared task engine (`modules/tasks`);
the bed becomes `available` only when that task is CHECKED, and the check frees the bed in the same transaction. A
terminal clean is checked by the housekeeping supervisor alone. Also declares the spill and room-inspection kinds.
A leaf: it imports `tasks` and `ipd` only through their `index.ts`; nothing imports it except the kernel wiring.

## 2. Key files (owner of what)
- `names.ts` — permission strings, the consumer name `housekeeping.bed_turnover`, `HOUSEKEEPING_ACTOR` (one leaf
  file so manifest, kinds and consumer import no cycle).
- `kinds.ts` — `defineSkill("housekeeping" → support_staff)`, `defineSkill("housekeeping_round" → services_supervisor)`
  and the four kinds: `bed_clean_routine` (5/45 min, tap, verify by `ipd.beds.clean` OR `housekeeping.verify_terminal`),
  `bed_clean_terminal` (5/90 min, tap, verify by `housekeeping.verify_terminal` only), `spill` (3/15 min, ladder 0/10,
  no verify), `room_inspection` (supervisor's round, no verify). Both bed kinds carry `onVerified: bedCleanVerified`.
- `turnover.ts` — `handleBedEvent` (one event, one decision), `raiseBedClean`, `cancelBedCleans`,
  `bedTurnoverConsumer` (the worker's handler).
- `cleans.ts` — the person intents: `verifyClean` (terminal refused up front with `terminal_needs_supervisor`), `nudgeClean`.
- `reads.ts` — `bedCleans` (per bed, the newest open-or-done clean: clock, initials), `housekeepingBoard`
  (`taskBoard` over housekeeping's kinds).
- `housekeeping.controller.ts` — `GET /housekeeping/bed-cleans` (ipd.beds.view or housekeeping.view),
  `GET /housekeeping/board` (housekeeping.view), `POST /housekeeping/cleans/:id/verify` (ipd.beds.clean or
  verify_terminal; the intent re-checks), `POST /housekeeping/cleans/:id/nudge` (ipd.beds.manage, ipd.beds.clean or
  housekeeping.view).
- Contracts `packages/contracts/src/housekeeping.ts` (kinds, targets, wire shapes, refusals).
- Web: `apps/web/src/screens/housekeeping-board.tsx` (`/housekeeping`, the task board with a terminal flag in words
  and Check buttons), cleaning clocks in `apps/web/src/screens/ipd-beds.tsx` (`cleanLine`, `NudgeButton`),
  `apps/web/src/lib/housekeeping-api.ts`. Cleaners use the task engine's "My tasks" (`/tasks`).
- Tests: `acceptance/bed-turnover.acceptance.test.ts` (the five done-means), `housekeeping.test.ts`, fixture
  `apps/core/test/helpers/housekeeping.ts` (`mkHousekeepingWorld`, `deliverBedEvents`).

## 3. Main flows
- **Release → task.** ipd `releaseBedOccupant` → kernel `resource.released` (status `cleaning`); the reason
  (`clean:routine` / `clean:terminal`) is only in `resource_status_history`, read by (bed, to_status, the event's own
  `occurred_at`). An unblock into cleaning is `resource.status_changed` with the reason on the payload. Terminal =
  reason `clean:terminal` OR the bed's isolation ≠ none. Due = the event's instant + 45 / 90 min.
- **Exactly one.** Per-bed advisory lock; a bed-clean task for this bed created at/after the event's instant = seen →
  nothing. The bed must still be in `cleaning`. The engine's 10-minute merge rule is a second net.
- **Check → bed free.** `verifyTask` (engine) checks the kind's verifier list and the doer, marks verified, then runs
  `onVerified` in its transaction → `markBedCleanIn` (ipd). A bed no longer in cleaning is left alone.
- **Bed leaves cleaning any other way** (hand tap "Mark clean", block, assignment) → the consumer cancels the bed's
  OPEN cleans with the reason. A `done` clean waiting for its check is not open and stays for the supervisor.

## 4. Invariants and traps
- **Installed in BOTH processes.** The manifest's three subscriptions need `workerConsumers`' entry (one edit, or the
  worker refuses to boot), and importing the module defines the kinds — the worker's task clock needs their windows.
  Censuses that move with a consumer: `kernel/modules/manifests.test.ts` (worker shared list),
  `kernel/worker/seed-cursors.test.ts`, `test/worker-runtime.e2e.test.ts`.
- The consumer re-reads the bed at handling time, so late, duplicated or out-of-order delivery is safe; never decide
  from the payload alone.
- OT recovery bays are kernel `bed` rows too: only beds whose attributes parse as IPD bed attributes are housekept.
- The Beds board sees the cleaner's INITIALS only (it is also a wall display); the supervisor board shows names (the
  task engine's board), never a patient.
- A terminal clean refused to a nurse answers `terminal_needs_supervisor` (rule + fix); any other door still meets
  the engine's `not_permitted`.
- The web imports `@hmis/contracts` for TYPES only: routes and the terminal kind key are copied in
  `apps/web/src/lib/housekeeping-api.ts`.
- Owed (later lanes): photo proof, "verification failed → reopen with reason", scheduled area cleaning by area class,
  chemical log, vendor TAT report, Bed Flow ordering of the queue at night.

## 5. Who calls housekeeping
- kernel: `kernel/worker/worker.module.ts` (install + `bedTurnoverConsumer`), `kernel/modules/manifests.ts`,
  `app.module.ts` (`HousekeepingModule`).
- web: the Beds board (clocks, verify, nudge) and the housekeeping board.
