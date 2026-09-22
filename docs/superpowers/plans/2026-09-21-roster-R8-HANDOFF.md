# HANDOFF — phase R, resume at R8

**For the next session (Opus), on the build host. Paste this file's path as the seed. Read this file
first and in full; it tells you which other files you need and, more importantly, which you do not.**

---

## 0. What you are

You are continuing **phase R (the roster backbone)** under EXECUTE-METHOD-V3's LIGHT lane. Seven of
ten tasks are built; **R1–R6 are merged to `main`** and **R7 is PR #280, armed to auto-merge**.
If #280 has landed by the time you start, branch your lane from `origin/main`; if it has not, branch
from `lane/roster-r7` and expect the squash collision in trap 1. You are picking up at
**R8**, then **R9**, then **R10 (close)**.

The rules of engagement are unchanged from the original execute prompt
(`2026-09-20-roster-backbone-EXECUTE-PROMPT.md`, §0): you code task by task, sequentially, yourself.
No coding subagents. No Workflow tool. Subagents are for exactly one thing — the two independent
close reviewers at R10 (V3 §5A, §9.7, §9.10). One lane, one PR per task. **Every jest run goes
through the test lock.** You are not authorised to deploy.

> **The stop-loss was RAISED by the owner on 2026-09-20** when R1's measured cost projected R1–R9
> at ~1.3–1.5 M against the prompt's 900 k. The owner asked for R1 → R10 in one run. Do not re-tier
> and do not halt on the original number; record the actuals at R10 as usual.

---

## 1. Read, in this order, and read nothing else first

1. **This file**, in full.
2. `CLAUDE.md` at the repo root — the lane, the lock, the shared files.
3. `docs/superpowers/AGENT-RULES.md` — in full. Rule 21 (build the mutant, never predict it), §5 (the
   finish block), §6 (migrations are irreversible).
4. **The plan's §0, §3 and §4 R8 only** —
   `docs/superpowers/plans/2026-09-20-roster-backbone-IMPLEMENTATION-PLAN.md`. §0 is the standing
   rulings (four of them now), §3 is the invariant table you must keep grepping for, §4 R8 is your task.
   **The document is 62 KB / ~15.5 k tokens and §9 is now most of it.** Read §9.4 (findings) once, at
   R10, when you write the close — not now.
5. **The stress test's §1 and §4 only** —
   `docs/superpowers/brainstorms/2026-09-20-roster-units/01-STRESS-TEST.md`. §1 is the four structural
   findings the whole phase exists to fix; §4 is the act/actor matrix R8 must not widen.
6. For R8's rule seeds, and only when you reach them: **20-U §2 (NMC ground) and §8 (edge cases)** in
   `docs/superpowers/plans/2026-09-20-phase1-20u-roster-unit-system.md`.

**Do NOT read** `EXECUTION-LESSONS.md`, the plan-series index, the department brainstorm series, the
project brief, or `00-BRAINSTORM.md`. Do not read the phase document end to end.

---

## 2. State, in one paragraph

The roster backbone exists as a module (`apps/core/src/modules/roster/`, ~8,100 lines including
tests) with **no HTTP route, no controller and no screen** — the module seam is deliberately inert
(the S-series is gated on the owner's sign-off of four design boards). Six migrations are on `main`
(`0108`–`0113`) and **none is deployed**. The hospital's departments, duty positions, teams, units,
memberships, officiating, delegations, absences, credentials, the publication gate, the scoped
resolvers and the calendar are all built and tested. What is missing is the thing that says whether
a roster is any *good*: requirements, rules, the validator, and the proposer that uses them.

### Commits

| task | merged as | what it added |
|---|---|---|
| R1 | `a5e41562` (#273) | `org_departments` (24), `roster_positions` (17), `rosterActPolicy` |
| R2 | `c485fcec` (#275) | periods, slots, amendments, the publication gate |
| R3 | `9d7c0527` (#276) | 27 units, memberships, officiating, delegations, the CRMI intern year |
| R4 | `70eebfdb` (#277) | `staff_absences`, `staff_credentials`; OPD leave becomes a projection |
| R5 | `2489e106` (#278) | the scoped resolvers behind `ROSTER_RESOLVER_ENABLED` |
| R6 | `77327031` (#279) | `roster_escalation_targets`; two kernel consumers ask the roster |
| R7 | **`c7eac768`, PR [#280](https://github.com/ankits3a/hims-hmis/pull/280) — armed to auto-merge** | the calendar: cycles, overlay, holidays, materialised windows |
| — | `b92ab7b8` (#271) | not a phase-R task: two IST-midnight clock bombs, one of them mine |

---

## 3. The seams R8 builds on — what exists and what to call

Everything is exported from `modules/roster/index.ts`. **Import through the index**, never a
module's internals (lint-enforced, spec §4).

- **`rosterActPolicy(actor, act, via)`** (`policy.ts`) — the one place `never` lives. Pure, total,
  a cell per act per actor kind. **R8 must not add an act without adding a row to the matrix AND to
  its hand-transcribed twin in `policy.test.ts`.** R4 added `request_absence` this way; copy that shape.
- **`requireRosterAct(exec, actor, act, scope, via)`** (`access.ts`) — policy first, then
  `hasPermission` at department scope, then the delegation path. There is **no** "hospital fallback"
  call and there must not be (F4).
- **`publishPeriod` / `publishPeriods`** (`periods.ts`) — **R8 edits this**: the publish gate must
  consult the validator and refuse on an unaccepted `block` finding. The advisory lock, the V3
  stale-base check and the V4 content hash all happen before any write; put the validator call with
  them, in step (2), before step (3) supersedes anything.
- **`whoIsOn` / `onDutyNow` / `calloutList`** (`resolve.ts`) — scoped, flag-gated, clock injected.
- **`absentUserIds`, `attendanceProjection`** (`absences.ts`) — what the validator subtracts and projects.
- **`holdsCredential`, `expiringCredentials`** (`credentials.ts`) — the credential rules' source.
- **`teamMembers`, `nightPoolFor`** (`teams.ts`) — `nightPoolFor` is what makes S4's feasibility
  test answerable: pooled nights vs unit-only nights is the difference between red and green.
- **`expandCycle`** (`calendar.ts`) — **pure, and the only generator** (V15). If R8 needs to reason
  about a hypothetical calendar, call this; do not write a second expander.
- **`CYCLE_TEMPLATES`** (`templates.ts`) — the six patterns. R8 owes each a feasibility line in
  **hours per week and residents per unit**.

---

## 4. Traps — each of these has already cost this phase time

1. **The stacked-PR squash collision, which recurs at every task.** Your lane stacks on the previous
   one. When the parent PR squash-merges, your branch goes `DIRTY`. **Do not rebase** — it is pushed,
   and AGENT-RULES 15 forbids rewriting pushed history. Instead: `git merge origin/main`, then
   `git checkout --ours` every conflicted roster file (your side is the parent's content PLUS yours,
   i.e. the superset), commit the merge, re-run the module suites, push. Then
   `gh pr merge <n> --squash --auto --delete-branch` so it lands when CI is green — branch protection
   requires up-to-date, so every movement of `main` otherwise costs a manual cycle. To refresh a
   pushed branch without rewriting it, `gh pr update-branch <n>`.
2. **`array_length('{}', 1)` is NULL, and a CHECK whose expression is NULL PASSES.** Always
   `coalesce(array_length(col, 1), 0)`. This accepted exactly the row it was written to refuse (F6).
3. **An emptiness check reads GREEN on an empty box.** *"No rule is violated"* is true of a hospital
   with no rules. Any census row must require the population to EXIST first (F10, and
   `radiology_devices_licensed` before it).
4. **Re-cutting an unmerged migration**: delete the `.sql` **and** `meta/NNNN_snapshot.json`, remove
   the journal entry, **drop the lane test DBs** (`hmis_lane_<name>_test_1`/`_2`), then regenerate.
   Skipping the DB drop leaves the old shape applied and the next run is green against a database
   nothing in git describes. R2 and R4 both needed this.
5. **`drizzle-kit generate` names migrations randomly.** Rename the `.sql`, patch the journal `tag`,
   and hand-append any EXCLUDE — drizzle models none of them, so `schema/roster.test.ts` asking
   `pg_constraint` by name is the only thing that knows they exist.
6. **A new scheduler job moves SEVEN censuses** (R9 will hit this): `jobs.test.ts`,
   `scheduler.test.ts` (the array AND a spy), `worker-runtime.e2e.test.ts`, `alerts-parity.test.ts`,
   and **`docker/prod/prometheus/alerts.yml`** — the daily staleness leg (the two legs are asserted
   disjoint) plus an `absent()` term. Run the whole `test/` directory: a `toHaveLength` grep cannot
   find a census expressed as a named array.
7. **The export census in `policy.test.ts` will go red on every new export.** That is the friction
   working. Classify each as ACTING (with the `reaches` it declares — the fixpoint follows private
   helpers too) or NOT_ACTING with a reason.
8. **The schema census in `schema/roster.test.ts`** pins every column of every table. Transcribe from
   the schema file, run it, and read any mismatch off the failure.
9. **Fixed dates read through a rolling window are time bombs.** Two went off during this phase at
   IST midnight. What drifts is the DISTANCE between a fixed fixture and a moving cap — age is no
   defence. R8's rule windows (12 h rest, 1-in-3) are exactly this shape.
10. **Do not truncate the database mid-test.** It drops the roles the position seed depends on, and
    the test then fails on its own setup (F29). Use a second department instead.

---

## 5. Standing rulings (plan §0) — four, and two are new

- **The college and hospital are in BIHAR** (owner, 2026-09-20).
- **R8 SEEDS NO `state` RULE ROWS** (owner, 2026-09-21). Knowing the State is not knowing Bihar's own
  mandates, and a rule row carrying a citation nobody checked is worse than an absent one. The book
  works without them: `nmc`, `nmc_recommended`, `central_law`, `central_directive`, `court`,
  `accreditation` and `institution` carry it, and a hospital adds `state` rows when somebody has read
  them. **Keep the `state` value in the authority vocabulary** — the column must be able to hold one.
- **The stop-loss is raised; run R1 → R10.**
- The unit establishment (5/5/3/3/4/2/2/1/1 + Respiratory Medicine) is **ours, not the regulator's** —
  UG-MSR 2023 dropped the units table. Seeded inactive; each HOD confirms. No screen may present it
  as the NMC's.

Two rulings already inside the rule book, which R8 seeds rather than re-decides: **74 h/24 h is
`nmc_recommended`**; **12 h/48 h is `central_directive` and WARNS**, because it is sub judice (the
Supreme Court hears *United Doctors Front* on 27.10.2026). A weekly off is a **warn with reason**,
not a block — PGMER says "subject to exigencies".

---

## 6. Verify

```
L=/opt/hmis-lanes/.orchestrator/bin/test-lock.sh
pnpm typecheck && pnpm lint                                        # no lock; not a pool
$L run roster-r8 pnpm --filter @hmis/core exec jest -w 2 src/modules/roster
$L run roster-r8 pnpm --filter @hmis/core exec jest -w 2           # full core, ~12 min
```

Start the lane with `tools/lane.sh new roster-r8 lane/roster-r7` (or from `origin/main` once R7
merges — check first, and take the next free migration serial **at rebase**, not at start).

**As of this handoff the full core suite is 533 of 533 suites and 5,826 of 5,826 tests, green** (measured on R7's tree, 2026-09-21). Any failure you see that is not in
`src/modules/roster` is worth diagnosing before assuming it is yours — §9.9.7: a red full verify is
diagnosed, never re-run until green.

---

## 7. What R8 owes, and the two judgement calls inside it

Plan §4 R8 is the specification. The two things it does not settle:

1. **Where the validator runs at publish.** It must be in `publishPeriods`' step (2) — with the
   empty-period, hash and stale-base checks, **before** step (3) supersedes the live version. A
   validator called after the supersede means a refused publish has already taken the old roster out
   of effect inside the transaction; the rollback saves you, but the ordering is the thing a reviewer
   will ask about, so put it where the other refusals are and say so.
2. **`simulate()` must write nothing, and that must be asserted rather than intended.** Same input,
   same output, and a row count before and after. `excluded[].reason` is a **rule code**, and an
   absence is reported as `unavailable` — **never its kind**, because a leave kind leaks why somebody
   is away to whoever is looking at a what-if.

R8's own invariant is **V16**: a supernumerary slot never satisfies a requirement, and a vacant slot
is a hole. `roster_positions.counts_toward_requirements` is already false for exactly one position
(`intern`), and `roster_team_memberships.supernumerary_until` carries the dated case.

---

## 8. Open findings and where they live

**None blocking.** Twenty-nine findings (F1–F29) are recorded in the plan's **§9.4** with their
disposition; every one is closed. Four of them are about my own instruments rather than the code —
read F21 and F22 before you trust a measurement you take yourself.

The phase's §9.1 (commits), §9.2 (kickoff), §9.4 (findings) and §9.5 (mutants — thirty-one built,
thirty-one died) are filled as far as R7. **§9.3, §9.6 and §9.7 are yours at R10**: the spike
answers, the two review passes, and the `/token-audit` actuals row.

**R10's close** is: fill §9; ONE fresh reviewer briefed at the operands (V3 §9.7) with the invariant
table (plan §3) as the checklist — every V-id must be pointed at by a named test; remediate; a SECOND
fresh reviewer over the remediation diff only (§9.10); `/token-audit`; commit the plan by path.
**Do not deploy.** Report the migration serials actually written, the pinned counts, the mutant
tally, and which of S / L / X / A / N may now be authored.
