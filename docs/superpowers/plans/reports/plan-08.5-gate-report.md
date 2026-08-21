# Plan 08.5 — The Runtime Loop: gate report

**Run:** `wf_12f42493-2af`, 2026-08-21, 13:18–19:05 IST. 13 agents, **0 infrastructure failures**,
**6/6 tasks passed on the first rung** (32 consecutive tasks across Plans 07–08.5 without a
rejection). Seven commits, `265c758`..`50fbbfb`.

---

## VERDICT: **NOT SHIPPABLE. The roadmap is NOT flipped to SHIPPED.**

The code is substantially right, well tested and independently verified — and it does not work,
for two reasons neither of which any agent in the pipeline could have fixed:

| # | Blocking defect | Owner |
|---|---|---|
| **B1** | **`main` has been CI-RED since T2 — six of seven commits, including HEAD.** A deterministic config defect, not a flake. | T2's test, but nobody could see it |
| **B2** | **The alerts consumer is not wired into the worker.** The plan's headline outcome does not happen in production. | **the compile — mine** |
| **B3** | **M-S2 survives the shipped L14 census**, and the Assertion Book's own stated discriminating input for it does not discriminate either. | the Assertion Book |

Everything else in this report is the evidence for those three and for what did work.

---

## 1. Independent verification (main session, not agent self-report)

**`pnpm verify` on the build host: GREEN.** Detached, exit **VALUE 0** read from `.mainverify.exit`,
nothing else running under jest:

```
apps/core           126 suites / 807 tests     (baseline 119 / 763  →  +7 suites, +44 tests)
apps/web             31 files  / 147 tests     (baseline  30 / 144  →  +1 file,   +3 tests)
packages/contracts    3 suites /   7 tests     (unchanged)
```

No workspace total decreased and no test was deleted anywhere in the range.

**Per-commit `git show --stat` against the plan's Files lists: ALL SEVEN MATCH EXACTLY.** No path
outside any task's list, no frozen-path edit, in any commit.

| commit | task | files | notes |
|---|---|---|---|
| `265c758` | T1 | 12 | exactly the Files list |
| `e6f1e0f` | T2 | 11 | exactly the Files list, incl. `temp-roles.test.ts` (amendment 4) |
| `8efbb50` | T2 follow-up | 1 | `scheduler.test.ts` — a **new commit, not an amend** (rule 15 honoured) |
| `39e520d` | T3 | 2 | exactly the Files list |
| `d13de0f` | T4 | 12 | exactly the Files list — **but see B2: `worker.module.ts` is missing from it** |
| `983e6b5` | T5 | 18 | all nine comment files (amendment 5), `README.md` at root (2), `locales/*.json` not `i18n.ts` (1) |
| `50fbbfb` | T6 | 2 | exactly the Files list |

**Server tree clean.** `git status --porcelain` empty apart from the untracked findings inbox
(now committed by this report's commit); no `*.mutant.*`, `*.control.*`, `.verify.*` or scratch
residue anywhere under `/opt/hmis`.

**CI by FULL SHA (§2.42 — an empty result is "not checked", never "not failing"):**

```
265c758  success            ← T1
e6f1e0f  FAILURE            ← T2  ✗
8efbb50  FAILURE            ← T2 follow-up  ✗
39e520d  FAILURE            ← T3  ✗
d13de0f  FAILURE            ← T4  ✗
983e6b5  FAILURE            ← T5  ✗
50fbbfb  FAILURE            ← T6 = HEAD  ✗
```

---

## 2. B1 — `main` is CI-red, and it is not a flake

**One test, every time, since T2:** `apps/core/src/kernel/worker/scheduler.test.ts` ›
*"the registration census (L14) › invokes all six jobs within a faked 25 hours advanced from a
pinned instant"*. `Test Suites: 1 failed, 125 passed` / `Tests: 1 failed, 806 passed`.

**Root cause, from CI's own log:**

```
ZodError: [ { "expected": "string", "code": "invalid_type",
              "path": [ "DATABASE_URL" ],
              "message": "Invalid input: expected string, received undefined" } ]
  at loadConfig       (src/kernel/config.ts:71:31)
  at registerAllJobs  (src/kernel/worker/jobs.ts:69:25)
  at Object.<anonymous>(src/kernel/worker/scheduler.test.ts:168:24)
```

`registerAllJobs` calls `loadConfig()`, which parses the **process environment** and requires
`DATABASE_URL`. The build host has `DATABASE_URL` in `apps/core/.env` (it is a dev machine). **CI
sets only `TEST_DATABASE_URL`.** So a fake-clock unit test that touches no database hard-requires a
database URL, and it is green on exactly one machine in the world.

**This refutes verify-by-execution flag ⑧**, whose stated discharge was *"config defaults mean no
`.env` change on the server or CI — discharged by T2's worker boot on the server (an unmodified
`.env`) **and CI green at the T2 commit**."* CI was never green at the T2 commit. The new *worker
interval* keys do default correctly, exactly as D9 promised; what broke the promise is
`registerAllJobs` reaching for `loadConfig()` at all.

**Why six commits shipped red.** This is EXECUTION-LESSONS §2.33 recurring with its full cost.
`gh` is not installed on the build host and the repo is private, so CI is the one checklist item no
in-pipeline agent can run — every gate and checker correctly reported it *"delegated to main
session"*, exactly as their prompts instructed. And the main session was not in the gap, because
the Workflow tool runs waves back-to-back. I put mechanical-check agents on the ROUTINE tasks
specifically to give the wave-stall break teeth (§2.50) — and CI is precisely the check they
structurally cannot perform. **The hole I patched and the hole that swallowed this run were
different holes.**

---

## 3. B2 — the worker dispatches to nobody, and it is my compile defect

`apps/core/src/kernel/worker/worker.module.ts:58` contains a **comment**:

```ts
// T4 (amendment 6) adds: registry.install(alertsManifest);
```

and `apps/core/src/worker.ts:26` calls `registerAllJobs(scheduler, db, registry, {})`. T2 shipped
the seam exactly as amendment 6 specified. **T4 never filled it.**

**Executed evidence, from the five-minute demonstration below** — not inference:

```
 events | deliveries | alerts | cursors
--------+------------+--------+---------
     12 |          0 |      0 |       0
```

Twelve events in `hmis_dev`; zero deliveries, zero alerts, and **zero `event_cursors` rows** — the
dispatcher never even created a cursor, because `bus.consumers()` is empty so the per-consumer loop
never executes. `runDispatchCycle` heartbeated every two seconds for five minutes and did nothing.

**Whose defect this is: mine, and T4 behaved correctly.** I authored amendment 6, wrote it into the
plan's File Structure and into T4's task body — and **never added `worker.module.ts` to T4's `files`
array in the pipeline script**. The frozen-path block is GENERATED from that array (§2.25), so T4's
compiled brief listed twelve files and its generated frozen block told it, under a heading reading
*"OWNED BY OTHER TASKS — DO NOT TOUCH THEM, EVEN IF YOUR CHANGE WOULD BE CORRECT"*, that
`worker.module.ts` belonged to T2. T4 read its brief and obeyed it. The plan said do it; the brief
said don't; the brief won, which is what the rules require.

**This is §2.46 — the entry I wrote earlier the same day — committed by me one level up.** §2.25's
own sentence is *"two hand-maintained lists of the same fact drift by construction."* The plan's
Files list and the pipeline script's `files` array **are two hand-maintained copies of the same
fact**, and I amended one. The pre-flight asserted that the frozen block was *generated* and that
each task allowed its own files — it never asserted that the script's arrays **match the plan**.

**T4's coder and T4's gate both reported it into the findings inbox** as an owner call, and T6 read
it and worked around it. The §2.39 mechanism worked; what it could not supply was an agent with
permission to fix it.

---

## 4. B3 — a surviving required-DIED mutant, and a wrong Assertion Book row

The plan routed L14's M-S1/M-S2 and the bell's polling mutant to the discovery reviewer, because T2
and T5 are ROUTINE and owe no mutants in-task. Discovery built them. **M-S2 SURVIVED**, measured
with a passing control:

- `scheduler.ms2.mutant.ts` — a byte-copy of `scheduler.ts` with `istDayIndex`/`istHourMinute`
  computed from the **UTC** calendar instead of `+IST_OFFSET_MS`.
- Shipped census against the mutant: **`PASS … Tests: 4 passed, 4 total`** — SURVIVED.
- Control (real modules): `PASS … 4 passed`, isolation quoted from output.

It survives because the census asserts only the **set** of six job names invoked across a 25-hour
advance, and all three daily jobs fire within 25 hours under either calendar.

**And the Assertion Book's own stated discriminating input does not discriminate either.** Row L14
names *"the guardians job must fire in the tick window containing `2026-08-21T18:35:00Z`"* and
predicts the UTC-mutant fires it *"~5.5 h later"*. Executed: shipped **passed**, mutant **also
passed** — because `isDailyDue`'s `pastInstant` is a `>=` comparison, so at 18:35 UTC the mutant
sees hour 18 > 0 and fires guardians in that very window too. **The Book's prediction is wrong.**
This is rule 21's whole argument — a hand-walk is a prediction, and this one was wrong in the
direction that matters.

Per AGENT-RULES §3 this is disclosed, not silently fixed. The fix reaches outside every task's
scope, so it is booked, not applied.

**Also found: M-A1's Book shape is wrong in the same way.** The Book says *"the `ON CONFLICT … DO
NOTHING` **target** dropped"* but states the expected outcome as *"2 rows or a captured
unique-violation"* — only dropping the **whole clause** produces either. T4's gate built both:
whole-clause **DIED**, literal target-only **SURVIVED**, and disclosed it.

---

## 5. The demonstration Global Constraint 10 owes

Run by the main session against the dev compose (`hmis-db-1`, `hmis_dev`, migrated through 0014),
heartbeats cleared first so all states were observable.

**Boot — six jobs registered, under `tsx`:**

```
[Nest] Starting Nest application...
[Nest] WorkerModule dependencies initialized +15ms
worker started: jobs=runDispatchCycle,runDueTimers,sweepExpiredTempRoles,
                     sweepGuardianMajority,sweepAppointmentNoShows,runDailyClose
```

That the worker boots at all under `tsx` is FORK-A's measured fact paying off: every provider is
token-injected, exactly as the spike said it had to be.

**Five-minute real-clock transcript — heartbeats advancing:**

```
===== SAMPLE 1  13:49:34Z (IST 19:19:34) =====   ===== SAMPLE 3  13:51:34Z (IST 19:21:34) =====
 runDispatchCycle      | 13:49:33 | 0 ms          runDispatchCycle      | 13:51:33 | 0 ms
 runDueTimers          | 13:49:31 | 1 ms          runDueTimers          | 13:51:31 | 1 ms
 sweepExpiredTempRoles | 13:48:51 | 2 ms          sweepExpiredTempRoles | 13:50:51 | 2 ms
 sweepGuardianMajority | 13:47:21 | 10 ms         sweepGuardianMajority | 13:47:21 | 10 ms
```

All three **interval** jobs advance on their configured cadences (2 s / 20 s / 60 s).

**Four heartbeat rows, not six — and that is correct, not a shortfall.** `sweepGuardianMajority`
(daily 00:05 IST) fired once at boot because its window had already passed today and the heartbeat
table was empty, which is D2's designed catch-up. `sweepAppointmentNoShows` (23:55 IST) and
`runDailyClose` (23:59 IST) had **not** reached their windows at 19:21 IST, so they correctly wrote
no heartbeat. Six jobs registered; four windows reached.

**Graceful shutdown on SIGTERM:**

```
worker: SIGTERM received, stopping scheduler
worker: scheduler stopped, closing context
worker: context closed, exiting
```

**The `/health` leg could NOT be demonstrated, and the reason is itself a finding.** `/health`
needs the API, and **the API cannot boot under the documented command.** `pnpm --filter @hmis/core
start:dev` (`tsx watch src/main.ts`, the exact command README §"Run locally" step 3 gives) dies at:

```
TypeError: Cannot read properties of undefined (reading 'registerTopicSpace')
    at OpdRealtimeRegistrar.onModuleInit (apps/core/src/modules/opd/opd.module.ts:19:52)
```

`OpdRealtimeRegistrar` uses class-typed constructor injection; esbuild (tsx's transformer) emits no
`design:paramtypes`; Nest injects `undefined`. **This is PRE-EXISTING and not this plan's doing** —
`opd.module.ts` last changed at `f84f1b1` (2026-08-17, Plan 07) and no commit in this range touches
it. It has been broken for four days and three pipelines, invisibly, because everything is verified
through **ts-jest, which does emit decorator metadata**. The suite is green, CI's only complaint is
B1, and the documented way to actually run the application does not work. The spike flagged exactly
this as *"incidental, not measured — worth someone checking"*; this is the check.

`/health`'s three states are covered by T1's shipped `health.e2e.test.ts` under ts-jest, which is a
**test, not a demonstration**, and I am not counting it as discharging Global Constraint 10's
`/health` leg. That leg is undischarged.

---

## 6. What went right — it is most of the run

- **6/6 first-rung passes, 13 agents, 0 infra failures**, no wave stalled, no ladder rung advanced.
- **Every mutant the CRITICAL tasks owed DIED with a passing control**: M-D1…M-D5 (T3) and
  M-A1…M-A6 (T4), each with expected-vs-received quoted from the assertion. T3's gate independently
  **rebuilt and re-killed three of five** (M-D1, M-D2, M-D4); T4's gate rebuilt its own and found
  the M-A1 Book-shape defect above. T1's two absence-class mutants (M-T1, M-H1) DIED with controls.
- **L8 — the no-patient-identity absence assertion — DOES discriminate**, confirmed by discovery:
  the fixture carries the patient's name and UHID and asserts the event carries `patient_id` as its
  own leg, so the absence is not vacuous. This was the plan's most §3.14-exposed row and it holds.
- **T5's two web artefacts have real teeth** — discovery built both mutants; both DIED with passing
  controls.
- **The §2.39 findings inbox worked.** T2's checker, T3's gate, and T4's coder and gate all routed
  forward-looking findings into it; T6 read it and acted. T3's note in particular (the signature
  change, and that a throwing consumer blocks its queue ~30 s before parking) is exactly the class
  of finding that evaporated in pipeline C. **This fix is validated.**
- **All five File-Structure amendments were obeyed as amended** — four cleanly; the fifth
  (§2.44's class-closure grep) only representatively, see below.
- **Rule 15 held under pressure**: T2 needed a correction after pushing and landed it as a new
  commit rather than an amend.

---

## 7. Verify-by-execution flags

| flag | verdict |
|---|---|
| ① context boots + closes cleanly | **discharged** — T6's boot proof, and the demonstration above |
| ② advisory lock exists, stable, session-scoped | **discharged** by the spike transcript; no shipped test observes it (D3 honoured — none was written) |
| ③ fake-`Date` with `doNotFake` | **discharged** — T6's 23:46 IST reproduction and the slots teeth assertion |
| ④ `authorize` gates the frame path | **discharged** — L10's two legs, refusal AND frame absence |
| ⑤ pg-boss branch facts | **not consumed** — FORK-B took the loop |
| ⑥ widened `/health` body | **discharged** — T1, suite green with the assertion widened in place |
| ⑦ two-client interleaving harness | **discharged** — the spike reproduced it; it became T3's fail-first |
| ⑧ **config defaults ⇒ no `.env` change on server or CI** | **REFUTED — see B1.** CI was never green at the T2 commit |
| ⑨ `stop()` awaits in-flight runs | **partially** — the await holds, but discovery proved `stop()` does not prevent a job *starting* afterwards |

---

## 8. Cost

**~3.0M subagent tokens against a ≤1.5M target — 2× over.** Stated plainly because the plan's own
Pipeline Notes set that number and it was missed by a factor of two.

Basis vs actual: the plan budgeted six coders ≈ 0.9–1.1M, two opus gates ≈ 0.26M, discovery
≈ 0.15M, checks ≈ 0.03M. The overrun is concentrated in the coders and the two opus gates, both of
which did substantially more work than budgeted — T3's gate rebuilt three mutants, T4's gate
rebuilt its own and found a Book defect, and discovery built three mutants with controls and
executed a nine-flag walk. That work is why three of this report's findings exist. The budget was
set from pipeline C, whose four tasks were all web/vitest with no database; this pipeline's six
tasks are core/jest against a real Postgres, where every test run is an order of magnitude slower
and every mutant needs a database. **The basis was wrong, not just the estimate** — recorded in the
ledger rather than restated as a target next time.

Wall clock: 5 h 47 m, 1062 tool calls, 13 agents.

---

## 9. What must happen next, in order

1. **Fix B1 first — `main` is red.** `registerAllJobs` should not call `loadConfig()`; take the
   intervals as a parameter (the same shape amendment 6 already used for `consumers`), or have the
   test supply the env. One file plus its test.
2. **Land the amendment-6 wire, both files in ONE commit.** `worker.module.ts` needs
   `registry.install(alertsManifest)` and `worker.ts` needs
   `registerAllJobs(…, { [ALERTS_CONSUMER]: alertsConsumer(db) })`. **Never one without the
   other** — `jobs.ts:36-45` makes a declared subscription with no handler a boot error, so half
   the edit ships a worker that throws at startup.
3. **In that same commit, handle the backlog flood discovery predicted.** `event_cursors.last_seq`
   defaults to `0` and the dispatcher creates the row on first sight, so the first cycle after the
   wire lands reads `seq > max(0 − 5000, 0) = 0` and walks the **entire history** of
   `escalation.triggered` at 100 rows per 2-second tick, minting an alert and a WS frame for every
   recipient of every escalation ever recorded.
4. **Add the assertion this pipeline never made**: boot `createApplicationContext(WorkerModule)`,
   `ctx.get(MODULE_REGISTRY)`, and assert the bus built from the worker's **own** registry is
   non-empty. Every existing seam test builds a private registry, which is why the missing wire
   survived six tasks and two opus gates.
5. **Fix L14's census** so M-S2 dies, using discovery's measured discriminating input (pin
   `now = 2026-08-21T19:00:00Z` and seed a heartbeat, keying on the day index rather than the hour).
6. Then the smaller booked items: `Scheduler`'s `stopped` flag and `worker.ts`'s missing `.catch`
   (§3.48 verbatim in the SIGTERM path); the case-sensitive class-closure grep and its two
   survivors; `jobs.ts`'s false docstring and unthreaded `now`; the mark-read status code (201 vs
   D6's prose); and the pre-existing `tsx` dev-boot break.

**Plan 10 is NOT next.** It was to be written by a session that reads this report cold; that
session should read it and then write the remediation, because 08.5 is not shipped until the loop
actually loops.
