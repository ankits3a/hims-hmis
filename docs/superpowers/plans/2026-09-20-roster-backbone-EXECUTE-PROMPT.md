# EXECUTE PROMPT — the roster backbone, phase R

**For the executing session (Opus), on the build host. Paste this file's path as the seed; read
nothing else first.**

---

## 0. What you are, and what you are not

You are the **main session of a phase under EXECUTE-METHOD-V3**, executing
`docs/superpowers/plans/2026-09-20-roster-backbone-IMPLEMENTATION-PLAN.md` (on `main`).

- **You code, task by task, sequentially, yourself: R1 → R10.** No coding subagents. No Workflow
  tool. Subagents are for exactly one thing: the two independent close reviewers (V3 §5A, §9.7,
  §9.10).
- **One lane, one PR per task.** `tools/lane.sh new roster-r<N>` per task, from `origin/main`;
  rebase before opening the PR; squash-merge when CI is green; drop the lane. **Every jest or vitest
  run goes through the test lock** (CLAUDE.md "Verify"): `$L run roster-r<N> …`. Two pools OOM the box.
- You are **not** authorised to deploy, to run anything against `/opt/hmis-prod*`, to widen your own
  permissions, to edit `kernel/auth/*`, `packages/contracts/*`, `kernel/copilot/*`, `apps/web/*`, or
  `opd_departments` / `opd_doctor_schedules` columns (plan §5 "Frozen").
- **Stop-loss: 900,000 tokens for R1–R9.** If you approach it, stop after the current task's PR is
  green and write the handoff (V3 §9.6). Do not re-tier.

## 1. Read, in this order, before the first tool call

1. `CLAUDE.md` at the repo root — the lane, the lock, the shared files.
2. `docs/superpowers/AGENT-RULES.md` — in full (rule 21: build the mutant, never predict it; §5 the
   finish block; §6 migrations are irreversible).
3. `docs/superpowers/EXECUTE-METHOD-V3.md` — §3, §5A, §6, §9.1, §9.6, §9.7, §9.8, §9.9, §9.10 only.
4. The plan: `docs/superpowers/plans/2026-09-20-roster-backbone-IMPLEMENTATION-PLAN.md` — in full.
   It is the only plan you execute.
5. The stress test, **§1, §2 and §4 only**:
   `docs/superpowers/brainstorms/2026-09-20-roster-units/01-STRESS-TEST.md` — it is why the plan
   says what it says; when a task tempts you toward T1's shape, that file is the reason not to.
6. For reference only, when a task names them: 20-U's §2 (NMC ground) and §8 (edge cases) in
   `docs/superpowers/plans/2026-09-20-phase1-20u-roster-unit-system.md`; Plan 20's D2/D4/D7 in
   `docs/superpowers/plans/2026-09-06-phase1-20-workforce-roster.md`.
7. **T1 as built, to PORT from, never to merge:** branch `lane/roster` (PR #264, draft), commit
   `29f5159d` — `apps/core/src/kernel/db/schema/roster.ts`, `apps/core/src/modules/roster/*`,
   `apps/core/src/kernel/db/schema/roster.test.ts`. Its 37 tests are ported into R2 and extended.
   Its migration `0108` is **not** carried: R1 takes the next free serial at rebase time.
8. Precedents each task transcribes: `apps/core/src/modules/aerb/` (a kernel-adjacent module with
   its own manifest), `apps/core/src/modules/ot/lists.ts` (draft/published/superseded), the
   four-edit permission recipe in the commit that added `opd.reports.read` (`git show 775a85da`).

Do **not** read `EXECUTION-LESSONS.md`, the plan-series index, the department brainstorm series or
the project brief. Do not read `00-BRAINSTORM.md` unless a task points at a section.

## 2. Before R1 — the kickoff block, recorded in the plan's §9.2

1. Re-measure every row of plan §1 with the command in its `how` column; correct the plan in place
   where a value moved. **G1 decides your migration serial** (`drizzle-when-silently-skips` trap 4:
   free ≠ reachable — take the serial after the one on `main`, at rebase, and drop the lane test DBs
   after any rebase that brings in a migration you did not have).
2. Confirm G6 (`Etc/UTC`) on your lane test DB: every IST test in the plan (V12 especially) is only
   evidence if the session is UTC.
3. Read `tools/lane.sh status` for lanes on the files plan §5 names, and coordinate R4 and R6 with
   any active one rather than racing it.

## 3. Executing the tasks

- **Tiers:** R1–R8 CRITICAL, R9–R10 ROUTINE. Every CRITICAL task builds its mutants as
  `*.mutant.ts`, runs them, records the kill in §9.5, and never stages them.
- **Fail-first is literal:** a new test is red against the code it guards before it is green. For a
  DB constraint (V1, V2, V11) the test writes rows *underneath* the domain code, as T1's schema
  suite did — a domain pre-check keeps a domain test green after the constraint is dropped.
- **Migrations:** one per PR; hand-carry every `EXCLUDE` and the `btree_gist` extension into the
  generated SQL and prove each exists from `pg_constraint` in the census test; generate on a **clean
  tree** (trap 3); never regenerate a migration that has merged.
- **Pinned censuses** (`seed-roles`, `manifests`, `standup-check`, the schema census, the scheduler
  job count in R7/R9): run them red, read the number off the failure, never predict it.
- **Verify discipline:** `pnpm typecheck && pnpm lint` before every verify; the suites you touched
  under the lock; the full core suite belongs to CI. Paste counts in the PR body. A test you did not
  run in that state is not green.
- **Commit hygiene:** stage by explicit path; `git status --porcelain` shows no `*.mutant.*`, no
  scratch, no foreign-lane file. Never `git add -A`. Never rewrite pushed history.
- **The four things the stress test found, restated so they cannot be lost in a port:** (1) an
  assignment names a **position**, not an RBAC role, and the resolver is **scoped**; (2) a small
  change is a **row-level amendment**, and a draft publishes only from the **live base** with the
  **hash the human reviewed**; (3) the vocabulary is **team / membership / position / requirement /
  slot / amendment / absence / credential** — nurses in wards are the same tables; (4) nights are
  **pooled at department level** by default, with a **cover scope** on the slot.

## 4. CLOSE (R10)

1. Fill the plan's §9.1–§9.5.
2. ONE fresh reviewer, restricted tools, briefed at the operands (V3 §9.7): the phase's commits,
   `AGENT-RULES.md`, the plan's §2–§4, the stress test's §1 and §4, the invariant table (plan §3)
   as the checklist — every V-id must be pointed at by a named test.
3. Remediate; a SECOND fresh reviewer over the remediation diff only (§9.10). Write §9.6.
4. `/token-audit`; record the actuals row (§9.7).
5. Commit the plan by path. **Do not deploy.** Report: the migration serials actually written, the
   pinned counts after R1 and after R9, the mutant tally, the harness result, and which of S / L / X
   / A / N may now be authored.

## 5. If you must hand off mid-work

Spend the remaining budget in this order: (1) `pnpm typecheck`, (2) the narrowest suite covering
what you changed, under the lock, exit value read, (3) the handoff note (V3 §9.6) in the plan's §9.
Uncompiled, unrun code is UNKNOWN and is reported as such.
