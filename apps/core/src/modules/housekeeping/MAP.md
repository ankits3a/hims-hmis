---
type: module-notes
title: "housekeeping — module notes"
description: "Why and traps of bed turnover on the task engine (one clean per release, check frees the bed) and of HK-1 rounds: areas and door QR, the shift rota and its eligibility, the rounds clock, proof of work, Pass/Fail, door requests and the supervisor board."
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
- **Release → task.** ipd `releaseBedOccupant` → kernel `resource.released` (status `cleaning`, payload `reason`
  `clean:routine` / `clean:terminal`; for older events the status history row of that instant is the fallback). An
  unblock into cleaning is `resource.status_changed` with the reason. Terminal = `clean:terminal` OR isolation ≠ none.
  `raised_at` = the event's instant; due = that + 45 / 90 min.
- **Exactly one, decided by the event.** The clean's `source_ref` is `resource-event:<seq>` (unique index
  `tasks_source_ref_ux`): a second delivery returns the first task. A release ALWAYS records its clean; if the bed has
  already moved on when it is handled, the clean is raised and cancelled at once ("Bed re-occupied before cleaning").
- **Seeding.** `seedCursors` (deploy, before the worker starts) puts the consumer at `max(seq)` and then runs
  `workerBackfills` → `backfillBedCleans`: every IPD bed in cleaning with no clean owed gets one, keyed on the event that
  put it there. Idempotent; runs every deploy.
- **Check → bed free.** `verifyTask` (engine) checks the kind's verifier list and the doer, marks verified, then runs
  `onVerified` in its transaction → `markBedCleanIn` (ipd). A bed no longer in cleaning is left alone.
- **Bed leaves cleaning any other way** (hand tap "Mark clean", block, assignment) → the consumer cancels the bed's
  cleans raised up to that event's instant that are open OR done-unchecked (engine `cancelTask` `closeDone`), whatever
  the bed's status now. The clocks (`bedCleans`) show only beds whose status is `cleaning`.
- **Verify compares state, not version** (DECIDED): the only change after the screen's read is a nudge, which bumps the
  version; the engine still refuses anything not `done`. The Beds board refetches after a nudge.

## 4. Invariants and traps
- **Installed in BOTH processes.** The manifest's three subscriptions need `workerConsumers`' entry (one edit, or the
  worker refuses to boot), and importing the module defines the kinds — the worker's task clock needs their windows.
  Censuses that move with a consumer: `kernel/modules/manifests.test.ts` (worker shared list),
  `kernel/worker/seed-cursors.test.ts`, `test/worker-runtime.e2e.test.ts`.
- Duplicates are stopped by `source_ref`, not by the clock or the bed's present status; cancellation is bounded by the
  event's instant, so a late event never cancels a newer clean.
- OT recovery bays are kernel `bed` rows too: only beds whose attributes parse as IPD bed attributes are housekept.
- The Beds board sees the cleaner's INITIALS only (it is also a wall display); the supervisor board shows names (the
  task engine's board), never a patient.
- A terminal clean refused to a nurse answers `terminal_needs_supervisor` (rule + fix); any other door still meets
  the engine's `not_permitted`.
- The web imports `@hmis/contracts` for TYPES only: routes and the terminal kind key are copied in
  `apps/web/src/lib/housekeeping-api.ts`.
- Owed (later lanes): chemical log, vendor TAT report, Bed Flow ordering of the queue at night. (Photo proof, fail →
  reopen with reason and scheduled area rounds arrived with HK-1, §4A.)

## 4A. HK-1 — rounds, rota, proof, confirm, door (issue #973, decision 0086, spec `docs/specs/973-housekeeping-rounds.md`)
- **Files.** `places.ts` (a place's chain up the register, its floor, its nearest area), `setup.ts` (checklists, areas,
  door QR, contractors, staff; `setupView`), `rota.ts` (draft/publish; `hkEligible`, `hkPoolOnly`), `rounds.ts`
  (`runRoundsClock`, `roundsOf`), `work.ts` (`finishWork`, `hkBeforeDone`, photo, `workForm`, `proofOf`), `cleans.ts`
  (`confirmClean`), `door.ts` (`raiseDoorRequest`), `door-throttle.ts`, `board.ts` (`supervisorBoard`). Tables
  `kernel/db/schema/housekeeping.ts` (`hk_*`). Web (`apps/web/src/screens/`): `apps/web/src/screens/housekeeping-board.tsx` (side
  panel), `apps/web/src/screens/hk-work-sheet.tsx` (inside My tasks), `apps/web/src/screens/hk-confirm-sheet.tsx`,
  `apps/web/src/screens/hk-rota.tsx`, `apps/web/src/screens/hk-setup.tsx`, `apps/web/src/screens/door-request.tsx`
  (public `/door#<token>`).
- **Door QR** = `a1.<areaId>.<qrVersion>.<hmac(SECRET_KEY)>`; the printed QR is the door page's address with the token
  in the FRAGMENT (never logged). Revoke = bump `qr_version`. A QR alone is weak proof (a photo of it passes): the photo
  and the signed-in person are the evidence.
- **Proof of work.** A housekeeping task whose place is, or lies inside, an active area finishes ONLY through
  `finishWork`: a genuine current QR of the task's place or an ancestor, every item of the NEAREST area's checklist, a
  photo when that area says so or the task is a bed clean. The attempt row (`hk_work`, attempt = rejections + 1, company
  snapshot) and `completeTask` commit together; every worked kind's `beforeDone` (`hkBeforeDone`) refuses any other
  completion (`work_missing`). A place with no area keeps the old tap — this is what keeps the E1.4 locked checks valid.
- **Rota → eligibility.** Only while a rota covering `now` is PUBLISHED: placed on the area/bed itself (preferred) →
  the floor's floor-mode people → anyone whose `floor_ids` include the floor; narrowed by trained skill (A `critical`,
  terminal `terminal`, spill `spill`). Bed cleans are pool-only for the floor team then (the clock's pool pass skips
  them). No published rota = the engine's old dispatch. A supervisor's assign is never narrowed. `room_inspection` has no
  eligibility (it is the supervisor's own round).
- **Rounds clock** rides `runTaskAndWasteClocks` while `housekeeping` is on: per area, the slot holding now (unique
  `(area, slot)` + `sourceRef hk-round:<area>:<slot>`); never back-fills; `due` → `done` when its task is done, →
  `missed` after `HK_ROUND_GRACE_MIN`. Shifts 07–15, 15–23, 23–07 IST (design board); slots per class in contracts
  (`hkSlotAt`). Classes A/B raise `area_round_checked` (unit side confirms); C/D `area_round` (no per-round confirm).
- **Confirm.** Pass = `verifyTask`; Fail = reason + engine `rejectTask` (back to the doer on duty, else the pool). The
  second fail rings `services_supervisor` (`housekeeping.needs_you`) and lists the task in "Needs you". Terminal: only
  `housekeeping.verify_terminal` (supervisor, `infection_control`).
- **Door.** `@Public()` POST, token in the body, per-address cap in memory (20 / 10 min) plus 4 an hour per area in the
  database under an advisory lock. No patient field, no free text; the address only as an HMAC.
- Owed (HK-2, #974): contractor SLA report, consumables per floor, department reports, random inspections of C/D areas,
  Expo app screens.

## 5. Who calls housekeeping
- kernel: `kernel/worker/worker.module.ts` (install + `bedTurnoverConsumer`), `kernel/worker/jobs.ts` (`runRoundsClock`), `kernel/modules/manifests.ts`,
  `app.module.ts` (`HousekeepingModule`).
- web: the Beds board (clocks, verify, nudge) and the housekeeping board.
