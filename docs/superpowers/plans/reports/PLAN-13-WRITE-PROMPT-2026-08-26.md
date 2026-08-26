# Plan 13 write-prompt — Resource Registry (kernel)

**Written 2026-08-26, immediately after Plan 16a closed.** Paste the fenced block below into a fresh
Claude Code session on the build host. It is a PLANNING prompt: the session it starts writes one
phase document and executes nothing.

**Its ground-truth block is written to be RE-MEASURED, not trusted.** Those numbers were true at
16a's close; Plan 09a is still open at T2–T4 and will move at least the migration head when it
lands. Plan 16a's first two findings were both stale ground truth in a plan document written nine
days before it ran — this file is deliberately shaped so the same thing cannot happen quietly.

---

```
Plan 13 — Resource Registry (kernel). BRAINSTORM AND WRITE THE PHASE DOCUMENT. Do not execute
anything: no code, no migrations, no commits beyond the plan document itself.

You are on the build host, in /opt/hmis, which is the checkout that produces evidence. Plan 16a
(formulary & prescribing safety) closed 2026-08-26; Plan 13 is next on the critical path.

═══ READ IN THIS ORDER, AND MIND THE CONTEXT BUDGET ═══

An agent pays for its whole context on every tool call, so what you read is re-billed on every
turn (EXECUTE-METHOD-V3 §9, and ledger §2.101 measures the cost).

  1. docs/superpowers/plans/2026-08-11-phase1-plan-series.md — the "## Plan 13" section (line ~379)
     and the "## Sequencing notes" section. This is the roadmap's standing ruling on Plan 13.
  2. docs/superpowers/EXECUTE-METHOD-V3.md (16k) — the method you must follow. §1 one document per
     phase, §2 the lane ruling, §6 stop-loss from actuals, §9 the context budget.
  3. docs/superpowers/AGENT-RULES.md (24k) — the execution contract the plan's executor will obey.
  4. docs/superpowers/specs/2026-08-10-hmis-architecture-design.md §11.18 (line ~492), §11.2,
     §11.19-A, §4. These are design law; never re-litigate them in a planning session — open
     questions go to the owner.
  5. docs/superpowers/plans/2026-08-25-phase1-16a-formulary-prescribing-safety.md — read its §6
     CLOSE only, as the most recent worked example of a phase document under v3.

DO NOT READ docs/superpowers/plans/reports/EXECUTION-LESSONS.md in full. It is 330KB / ~82k tokens
and re-reading it is the single most expensive habit available to you. Cite entries BY NUMBER; if
you need one, grep for it. The ones that bear on this plan: §2.54 (two copies of one fact drift),
§2.93 (verify a formula in the regime where its operands differ), §2.101, §2.102.

═══ MEASURED GROUND TRUTH, 2026-08-26 (re-measure before you trust any of it) ═══

  · Migration head: 0027_perfect_korg.sql. Plan 13 generates 0028.
  · ALL_MANIFESTS holds TWELVE manifests; manifests.test.ts pins the census by key, in order, and
    app.module.ts must agree. A thirteenth is a deliberate three-file change.
  · Permission census: 77 declared = 63 held + 14 not-yet-modelled (test/seed-roles.test.ts). Any
    new permission moves this number AND the README's cell-for-cell parity table.
  · Suite: apps/core 212 suites / 1847 tests; apps/web 43 files; packages/contracts 4/21.
  · There is NO `resources` table anywhere. OPD has privatised what Plan 13 is meant to own:
    opdRooms, opdDoctors, opdDoctorSchedules, opdDoctorLeaves in kernel/db/schema/opd.ts.
  · The SPA route census is pinned at 25 in test/caddyfile-parity.test.ts; the deploy seed census
    at 11 in test/deploy-parity.test.ts. A file that pins a number joins the Files list of the task
    that moves it.

═══ WHAT THE ROADMAP ALREADY RULES (do not re-decide; build on it) ═══

One kernel table family: `resources` (id, kind: floor|ward|hall|room|bed|theatre|store|bench|
analyzer|device, parent_id, class, attributes JSONB, status, occupant_ref, since, site_id) plus
`resource_status_history`. Events resource.status_changed / assigned / released. Read endpoints
(tree, board snapshot by kind/parent). Module tables REFERENCE resources. Manifest registration of
resource kinds per module.

Traps the roadmap names: it is NOT a projection (transactionally owned, like `patients`); NOT a bed
-management module (IPD owns admissions, assignment rules, gender segregation, isolation, quota —
rules OVER the registry); one table family; no AI; no dashboard; Class-B/C change control on
masters via the workflow engine.

Plan 13 is a HARD GATE before the IPD cluster and was pulled forward because the mini-OT, its two
recovery bays, pharmacy stores, lab benches/analyzers, housekeeping rooms and BMW collection points
all reference it.

═══ QUESTIONS THAT ARE THE OWNER'S, NOT YOURS — ASK THEM, DO NOT ASSUME ═══

  1. SEQUENCING. The ruling says "immediately after Plan 09". Plan 09 is LIVE-BUT-NOT-CLOSED (its
     independent review is still pending) and Plan 09a is open at T2–T4. Plan 16a set the precedent
     of running in parallel with 09. Does 13 start now, or wait?
  2. THE OPD MIGRATION. The roadmap says OPD rooms migrate onto the registry and doctor availability
     stays in OPD "until the roster module — the seam is named, not moved". Does Plan 13 actually
     move opd_rooms (a data migration on a LIVE deployment with real rooms), or only establish the
     registry and name the seam? This is the single biggest scope question in the phase.
  3. SITE_ID. What does it mean today, with one hospital? Is it nullable, defaulted, or deferred?
  4. Anything §11.18 leaves genuinely open that the mini-OT (Plan 15) will need first.

═══ WHAT THE PHASE DOCUMENT MUST CONTAIN (v3) ═══

One document, at docs/superpowers/plans/2026-08-XX-phase1-13-resource-registry.md, carrying: THE
LANE ruled at write time with its reasoning; a stop-loss computed as 1.5 × the last comparable
phase's PER-TASK rate × this phase's task count (never from a total — ledger §2.95); a SPIKE whose
questions are answered at kickoff by read-only SQL against the production database; the design
decisions the plan rules beyond the spec; the tasks with tiers, exact Files lists and exact commit
messages; an inline Assertion Book for every CRITICAL task (assertion · mutant · discriminating
input); and an empty CLOSE section appended as the phase runs.

═══ FOUR THINGS PLAN 16a LEARNED THE HARD WAY — LET THEM SHAPE THIS PLAN ═══

  1. AN ASSERTION BOOK ROW'S "DISCRIMINATING INPUT" IS A PREDICTION UNTIL SOMEBODY RUNS IT. 16a's
     plan named an input that did not discriminate; only building the mutant showed it. Prefer
     inputs you can argue will differ, and expect the executor to correct them.
  2. A FILES LIST THAT OMITS THE FILE PINNING A NUMBER MAKES THE TASK UNBUILDABLE. 16a hit this
     four times (seed-roles census, README parity, SPA route census, deploy seed census). For every
     task, ask what number it moves and name the file that pins it.
  3. FIXTURES WHOSE FIELDS COINCIDE HIDE THE DEFECTS THAT DISTINGUISH THEM. 16a's review found
     three CRITICALs invisible to its own tests because every fixture set drug-text equal to
     brand-name and kept the formulary fully active. For every fixture, name the field identical to
     another and require one leg where they differ (§2.102).
  4. THE INDEPENDENT REVIEWER IS THE ONLY INSTRUMENT THAT REFUTES. 16a passed eleven green verifies
     and eight green CI runs, then a 181k-token reviewer found three patient-safety CRITICALs. Plan
     for it, and do not let the phase be written up as cheap before it has run (§9.4).

═══ THE HARD STOP ═══

This session PLANS. It writes one document and commits only that document. It writes no application
code, generates no migration, and executes no task. If the plan looks ready to start, say so and
stop — execution is a separate session with its own approval.
```

---

## Two notes for whoever pastes it

**Settle question 2 before any drafting.** Whether Plan 13 migrates `opd_rooms` on a live
deployment changes the lane, the task count and therefore the stop-loss. It is the difference
between a kernel-table phase and a kernel-table-plus-data-migration phase.

**The ground truth above will drift.** Plan 09a is open at T2–T4 and takes the next migration
number when it lands; a session that trusts `0028` without re-reading the head will collide with it,
which is exactly the collision 16a's kickoff caught between itself and 09a over `0026`.
