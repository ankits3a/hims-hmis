---
type: module-notes
title: "roster — module notes"
description: "Why and traps of the duty roster: duty periods, unit take and backup cycles, absences, covers and swaps, and the who-is-on readers."
resource: apps/core/src/modules/roster
tags: [roster]
generated: { by: agent:claude, at: 2026-10-07 }
verified: []
stale_after: 2027-01-05
---
# roster — module notes

Hand-written notes: the WHY and the traps. Signatures, routes and tables are generated in
`docs/architecture/modules/roster.md`. Paths are relative to `apps/core/src/modules/roster/` unless they start
with a module name, `kernel/`, `scripts/` or `apps/`. Citations name a file and a symbol, never a line number.
Update this file in the same PR when you change a flow, an invariant or a trap below.
Owner rulings that bind this module: `docs/decisions/` (units and the e-Rx header: 0024).

## 1. Purpose
Who is on duty, when, in which unit: duty periods (draft → publish), unit take/backup cycles, absences, covers
and swaps, and the readers every other module asks ("who is on now", "which unit holds today's OPD").

## 2. Key files (owner of what)
- `policy.ts` — `rosterActPolicy`: the act × actor matrix, and the ONE place `never` lives. Permissions:
  `roster.read`, `roster.periods.manage`, `roster.periods.publish`.
- `access.ts` — `requireRosterAct(db, actor, act, { departmentId })`, delegations included. A team-scoped
  delegation counts only when the act names that unit.
- `masters.ts` — `org_departments` and `roster_positions`.
- `periods.ts` — draft, assign, unassign, amend, publish; `asKnownAt` / `publishedAsKnownAt` answer "as published
  then". Publish runs the presence-overlap check.
- `teams.ts` / `memberships.ts` — units are `clinical_unit` teams, seeded inactive until confirmed;
  `unitCountsAt` / `countingUnits` count only CONFIRMED units.
- `calendar.ts` — cycles, duty windows (take / backup / opd …), holidays: `unitOnTake`, `backupUnit`,
  `windowAsKnownAt`, `holidaysBetween`, `materialiseWindows`.
- `templates.ts` — cycle templates (single_unit_call … five_unit_rolling); multi-unit templates carry a `backup`
  = yesterday's take unit.
- `resolve.ts` — `whoIsOn`, `onDutyNow`, `calloutList`, `dutiesOf`. Behind `ROSTER_RESOLVER_ENABLED`.
- `proposer.ts` — `proposeMonth`. `validator.ts` — `validate`, `blockingFindings`. `rules.ts` — `seedRosterRules`.
- `opd-units.ts` — `opdUnitsOn`: which unit holds a department's OPD on a date (Desk One, OPD day report).
- `doctor-units.ts` — `doctorUnitsOn`: drives the web doctor label "Dr. X · Unit I · Asst. Prof.".
- `evidence.ts` + `evidence-print.ts` — duty-evidence sheet; `aebas.ts` — the AEBAS to-do list.
- `escalation.ts` — `dutyManagersAt`: roster flags page the duty manager.
- `board.ts` / `board-print.ts` — `onNowBoard`, and the board auto-print job.
- `month.ts`, `as-it-stood.ts`, `declarations.ts`, `swaps.ts`, `absences.ts` — screen read models and acts.
- `copilot-tools.ts` — copilot tools `roster.who_is_on`, `roster.unit_on_take`, `roster.my_duties`,
  `roster.ask_cover`.
- `roster-board.controller.ts` — every route's door is `roster.read`; the real act check is inside the domain call.
- Web: `apps/web/src/screens/roster-on-now.tsx`, `apps/web/src/screens/roster-month.tsx`,
  `apps/web/src/screens/roster-my-duties.tsx`,
  `apps/web/src/lib/roster-api.ts`, frame `apps/web/src/components/doctor-desk/frame.tsx`.

## 3. Main flows
### 3.1 Month: propose → validate → publish
1. `proposeMonth` (proposer.ts) drafts slots. Shift shapes: cover 08–20, night 20–08, routine 09:00–17:30.
   Pooled nights are drafted once per department (`cover_scope='department'`, no team). Leave and membership are
   applied per day; no routine duty on Sundays or holidays.
2. Humans edit the draft (`month.ts` editSlot; `periods.ts` assign / unassign / amend).
3. `validate` (validator.ts) produces findings; `blockingFindings` must be empty or accepted before publish.
4. Publish (`periods.ts`) runs presence-overlap, then the period is "as published" for every later reader.

### 3.2 Cycles and the nightly window sweep
1. A published cycle (`calendar.ts`) from a template defines which unit takes on which day.
2. `materialiseWindows` writes concrete duty windows; the nightly job `sweepRosterWindows` extends them.
3. The job acts as `MATERIALISER_ACTOR` (`{ type: "system" }`) with act `extend_published_windows`, honoured only
   for a cycle whose status is `published`; anything else is judged as `publish`, which a machine never holds.
4. `extendWindows` resumes from the last window written, so a missed night self-heals on the next good run.

### 3.3 "Who is on" (every other module's question)
- `whoIsOn` / `onDutyNow` (resolve.ts) answer from published windows and periods. With the env flag off, every
  answer is the static role-holder answer (`source: "static"`).
- The answer silently subtracts people who are absent, inactive or whose membership is closed; the validator names
  them.

## 4. Invariants and traps
- **Take runs 08:00 → 08:00 IST.** At 02:40 it is still yesterday's take unit. Use `unitOnTake`, never the calendar
  date.
- Only CONFIRMED units count, in every reader (`countingUnits`). Unconfirmed seeded units stay invisible.
- `unassign` locks the row and must delete exactly one row.
- `rest_after_duty` blocks a night followed by a contiguous day; a single 24 h take slot is legal. Skeleton mode
  relaxes only the faculty ratio and rest rules. The validator still ignores each rule's `appliesTo`.
- Cycles published before backups existed have no backup unit; they must be republished to get one.
- **Adding a `RosterAct`** costs four edits: `ROSTER_ACTS`, `MATRIX` (policy.ts), the expected table in
  `policy.test.ts`, and `node tools/arch/gen.mjs`.
- **A machine job must act as a `system` actor with its own act.** A user-typed actor with no grants is refused
  `not_permitted`; this silently stopped the nightly sweep until PR #522. `window-sweep.test.ts` runs every roster
  job through `registerAllJobs` against a hospital WITH a published cycle, and fails on any refusal: add every new
  roster job to its list.
- **Deploy does NOT seed the roster.** `docker/prod/deploy.sh` never runs `seed:roster`; rules and masters reach a
  database only when `scripts/seed-roster.ts` is run by hand at go-live. It is idempotent and never overwrites an
  edited rule.
- `scripts/setup-units.ts` reads its data from a `.ts` module, not `.json`: the production image copies only `tsc`
  output, so a `.json` beside a script is missing in prod (guard: `test/scripts-data-compiles.test.ts`).
- **No direct roster → ot import.** The OT evidence read is registered by OT (`ot/duty-evidence.ts`, in the OT
  module's init); a direct import made a module load cycle.
- Evidence and AEBAS screens never use verdict words; leave shows "on record" with no kind or reason.
- `ask_cover` (copilot) only drafts (`roster_cover_draft`) and never writes; the human's tap calls the cover route.
  Copilot answer cards are LIGHT, never dark slabs (owner).
- Board auto-print prints only to a destination granted to a relay (`duty_board_a4`); otherwise it records
  `no_printer` rather than failing.

## 5. Who calls roster
- opd: `opdUnitsOn` (Desk One department card, OPD day report), `doctorUnitsOn` (doctor label), prescriber print
  (e-Rx header: Unit Number = unit, else Doctor ID; Dept. Regn = that day's unit head).
- ot: registers the duty-evidence reader into roster (the dependency points ot → roster, never back).
- radiology: imports roster through `index.ts` (see the architecture page's dependency graph).
- kernel: copilot (tool registration through the manifest), alerts (`roster.flag_raised` → duty manager), worker
  (the nightly window sweep and the board print job).
