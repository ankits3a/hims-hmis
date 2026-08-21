# Prompt — write Plan 08.5 (The Runtime Loop)

> **For a Fable 5 session. BRAINSTORM AND WRITE THE PLAN. DO NOT EXECUTE ANY OF IT.**
> No pipeline, no compile, no agents, no code under `apps/`. The plan is executed by a different
> session later. Written 2026-08-21 at `eb283eb`.

---

## 0. What you are producing

**Two artefacts, in this order:**

1. **A spike brief** (~50k, one agent, throwaway branch, nothing merged) — see §3. The repo's own
   method (EXECUTE-METHOD v2 §1) requires the spike BEFORE the plan, and the roadmap says so
   explicitly for this plan. You cannot run it, so you write it, and you write the plan so the
   spike's answers slot in without a re-plan.
2. **`docs/superpowers/plans/2026-08-2X-phase1-08.5-runtime-loop.md`** — the plan, in the exact
   shape of `2026-08-18-phase1-08-billing-counter.md` (owner rulings → design decisions D1..Dn →
   Global Constraints → File Structure → per-task Steps/Files/acceptance criteria → Assertion Book
   → verify-by-execution flags → self-review → Pipeline Notes with the tier map).

**Do not restate the roadmap entry as a plan.** It is already near-plan-quality; your job is the
part it does not do — the design decisions, the exact file list, the Assertion Book with a named
killing mutant per assertion, and the acceptance criteria a compiler can paste into a brief.

---

## 1. Read first, in this order (ranges are deliberate — do not `cat` whole files where a range is given)

| # | file | what to take |
|---|---|---|
| 1 | `docs/superpowers/AGENT-RULES.md` | the binding contract. v2, amended 2026-08-20. §6 (migrations) matters most here |
| 2 | `docs/superpowers/EXECUTE-METHOD.md` | v2: spike → plan → compile → run → verify; risk tiers; the review split |
| 3 | `docs/superpowers/plans/reports/ARCHITECTURE-REVIEW-2026-08-20.md` | **the whole file.** This plan exists because of it. §5 (what the audit missed), §8 (the order), §9 (the single most important next act) |
| 4 | `docs/superpowers/plans/2026-08-11-phase1-plan-series.md` | `sed -n '1,60p'` (banner + open decisions) and `sed -n '165,182p'` (**the Plan 08.5 entry — your specification**) and `sed -n '260,270p'` (sequencing) |
| 5 | `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` | `sed -n '1,215p'` (§1–§2, incl. the new §2.39–§2.45) and `sed -n '300,400p'` (§3.34, §3.41, §3.42–§3.49) and the §5 "what is working" tail. **SKIP §4, the cost ledger** — history, not instruction |
| 6 | `docs/superpowers/plans/reports/plan-08-pipeline-C-notes.md` | §4 (carried forward), §5 (method notes), §7–§8 (the two post-pipeline fixes). This is the freshest evidence about how this repo actually fails |
| 7 | the code the plan touches | `kernel/events/{dispatcher,append,subscriptions}.ts`, `kernel/events/schema` + `event_cursors`, `kernel/workflow/timers.ts`, `kernel/realtime/{tail,gateway,realtime.module}.ts`, `kernel/modules/{manifest,loader}.ts`, `apps/core/src/main.ts`, `apps/core/src/app.module.ts`, `apps/core/package.json`, `docker/` |
| 8 | spec | the `(v4.6)` amendments: §2 v4.3 process split · §4 · §9 · §10.2 · §10.3 · §11.13 · §11.19-C fixes 11 & 29 · §16 · §17 · §19 |

---

## 2. Ground truth — verify it, do not trust it

- **HEAD `eb283eb`** on `main`. Build host `root@62.238.106.231`, checkout `/opt/hmis`.
- **Baseline has MOVED since the roadmap entry was written.** Re-measure before you quote anything:
  **apps/core 119 suites / 763 tests · apps/web 30 files / 144 tests · packages/contracts 3 suites / 7 tests.**
- **The next migration is `0014`.** `0013_billing_idempotency` landed 2026-08-21.
- **Pipeline 8C is CLOSED.** Roadmap trap (7) — "do not touch `apps/` while 8C is open" — is
  discharged; its gate report is `plan-08-pipeline-C-notes.md`.
- **A CI perf gate flaked at `2bf324f` and was fixed on 2026-08-21** (statistic changed to min-of-5;
  budgets unchanged) — see §6.1. Confirm the current CI state yourself before you write anything
  that depends on "CI is green".
- Every number in the roadmap's "measured facts the plan must start from" bullet must be re-verified
  at compile time. Several were measured at `ce8b6e7`, four commits ago.

---

## 3. The spike problem — read this before you plan anything

The method says: **spike first, then write the plan against measured behaviour.** You cannot
execute. Resolve it this way, and say in the plan that you did:

**Write the spike brief as a first-class deliverable** covering the four questions the roadmap
names — (a) a Nest application context without HTTP from the same module graph (does the realtime
gateway's `HttpAdapterHost` dependency fight a headless boot? is a `WorkerModule` cleaner than
reusing `AppModule`?); (b) pg-boss under this jest harness (its own `pgboss` schema beside drizzle's,
per-suite reset, `start()`/`stop()`, cron registration, singleton semantics) **or** the fallback of a
plain interval loop per job under `pg_try_advisory_lock(hashtext(jobName))`; (c) **reproduce the
dispatcher's out-of-order-commit skip** — tx A allocates `seq N` and stalls, tx B allocates `N+1`
and commits, a dispatch cycle runs, then A commits; assert `N` is never delivered; (d) how the
manifest `subscriptions` seam actually binds to `SubscriptionBus` today.

**Then write the plan so every spike-dependent decision is an explicit FORK with both branches
already designed**, not a blank to fill in. The big one is T2: pg-boss vs the advisory-lock loop
changes the dependency, the migration story, the tier (CRITICAL if pg-boss, ROUTINE if the loop) and
the harness risk. Write both, state the decision rule (*"if pg-boss needs any change to
`jest.config`/`test/helpers/db.ts` to coexist, take the advisory-lock loop"*), and let the executing
session pick from the spike's measurements without re-planning.

**This is the repo's own §3.4 discipline** — a verify-by-execution flag is an admission that
something was written that could not be checked. Flag them loudly rather than pretending the spike
happened.

---

## 4. What the plan must carry (EXECUTE-METHOD v2 §2 + this repo's plan shape)

- **A risk tier on every task** (CRITICAL | ROUTINE) and a model per task. The roadmap's tier map is
  a starting point, not a conclusion — justify it. §2.30: **opus wherever correctness rests on
  proving an assertion has teeth**, which here means T3 (dispatcher concurrency) and T4 (per-user
  alert data) at minimum.
- **NO per-task test-count targets.** Removed in v2 (they cost four gate findings in one pipeline).
  The rule is AGENT-RULES §4: the workspace total must not decrease, no test is deleted, and the
  runner's own summary line is quoted by exact path. **The pipeline-C ladder was one FILE wrong from
  its first rung onward** and four acceptance criteria carried pairs no task could satisfy — do not
  repeat it.
- **An Assertion Book row per assertion, each naming its killing mutant AND the exact discriminating
  input.** §3.37: a row that names the right mutant with the wrong stated mechanism ships a
  non-discriminating test. Give the instant/interleaving, not a prose description of it.
- **Verify-by-execution flags**, each with its own discharging assertion named in the task that owns
  it. §3.30: a flag that bundles two claims ("compiles AND serializes") must name a separate
  discharging assertion for each.
- **A Files list that names every file each Step touches**, including generator output sets (§3.16)
  and the truncate helper (§3.12 — 08.5 adds ~4 tables: `scheduler_heartbeats`, `event_deliveries`,
  `event_dead_letters`, `alerts`; any table that FKs into an existing truncate group must be named in
  the SAME statement).
- **Frozen-path list generated FROM the Files lists**, never hand-written beside them (§2.25).
- **The rollback path for the migration, stated before the generator ever runs** (AGENT-RULES §6).
  For reference, `0013` was additive-only — one `CREATE TABLE` + one `CREATE UNIQUE INDEX`, rollback
  `DROP TABLE` — and that is the shape to aim for. If any 08.5 table needs an FK into an existing
  table, say what that does to `truncateAll` and prove it against §3.35's actual Postgres rule
  (`TRUNCATE` checks FK constraint EXISTENCE, not row counts or statement order — **quote §3.35,
  do not paraphrase it; the last paraphrase inverted it and cost 934k tokens**).

---

## 5. What changed since the roadmap entry was written (2026-08-20 → now)

Four commits, and three of them bear on this plan.

1. **`2bf324f` + `eb283eb` — billing idempotency.** A new kernel-adjacent pattern now exists:
   `modules/billing/idempotency.ts` claims a key with `INSERT … ON CONFLICT DO NOTHING` **before**
   doing the work, stores the response, and replays it. **08.5's `event_deliveries(consumer, seq)`
   claim is the same idea one layer down** — read that module before designing T3, and say in the
   plan whether the two should share a helper or stay separate (they have different lifetimes; my
   read is *stay separate*, but rule on it explicitly rather than by omission).
2. **`242ed8b` — `SubmitButton`.** Every billing write button is now single-flight, enforced by a
   source sweep + per-screen census in `submit-button.test.tsx`. **08.5 adds a web surface (the
   alerts bell with `POST /alerts/:id/read`).** Decide: is single-flight a *billing* convention or an
   *app* convention? If the latter, the census must grow and the sweep's scope must widen — and per
   §3.34 that decision needs an owner and an assertion, not a sentence in six briefs.
3. **New ledger entries you must apply, not just read:**
   - **§2.40 — the shared mirror. FIXED 2026-08-21; one residual is YOURS.** A pipeline-C reviewer
     accused a compliant agent of breaking a hard rule on the strength of a contaminated mirror.
     AGENT-RULES **22(a)** now mandates a per-agent mirror directory
     (`<SCRATCH>/mirror-<taskid>-<role>`), 22(c) moved with it, and a new **22(g)** forbids the
     inference that did the damage (*a mirror is not evidence about the server's tree*). **The
     residual: the compiled brief's `MIRROR` block RESTATES rule 22 instead of pointing at it, and
     that second copy is what drifted.** Pipeline C's script was left unedited on purpose — it is a
     completed artefact and editing it would falsify what its agents received. **When 08.5 is
     compiled, that block must be rendered from the amended rule or reduced to a pointer.** Say so
     in the plan's Pipeline Notes so the compiling session cannot miss it.
   - **§3.49 — a design decision needs a mutant that INVERTS the decision, not one that breaks a
     line.** The idempotency claim-before-work mutant passed six of seven tests and died only on the
     concurrency case. **T3 is exactly this shape**: cursor-advance vs delivery-claim, look-back
     window size, poison-parking order. Write the inverting mutants into the Assertion Book.
   - **§2.45 — a mutant that dies by TIMEOUT is not a kill**, for the same reason one that dies at
     typecheck is not. `await expect(x).rejects` on a promise the mutant makes RESOLVE hangs forever.
     08.5 is full of refusal-and-concurrency tests; write them to assert the invariant and capture
     the loser's outcome (§3.13), never to await a rejection that may not come.
   - **§3.48 — a `void`-ed async IIFE turns a rejecting handler into an unhandled rejection**, and
     the runner bills it to whatever file is running. **A worker that fires jobs is nothing but
     `void`-ed async calls.** T1/T2 must name where every job's rejection is caught, and assert it.
   - **§2.44 — scope a fix to the class and make the class mechanically enforced.**

---

## 6. Things needing attention — rule on each, in the plan or in a decisions list

### 6.1 The CI perf gates were flaky and are now FIXED — inherit the reasoning, do not redo it

**Resolved 2026-08-21, before this prompt was finished.** Recorded here because 08.5 adds a worker
that does periodic database work, i.e. more contention on exactly the resource these budgets
measure, and because the reasoning generalises to every timing assertion this plan writes.

`test/perf-opd-queue.test.ts` failed CI at `2bf324f` — *"openVisit median over 5 runs under 100 ms"*,
`Received: 107.35`. The commit contained no OPD, perf, queue or encounter file. The next commit,
`eb283eb`, **contains that same code and PASSED**:

| run | openVisit timings (ms) | median | verdict |
|---|---|---|---|
| `2bf324f` | `107.3, 230.0, 275.9, 59.4, 48.3` | 107.3 | failure |
| `eb283eb` (contains it) | `20.2, 19.2, 23.7, 22.3, 21.3` | 21.3 | success |

A 5x swing in the median on identical code: a contended runner, not a regression. **The decisive
number is the minimum.** Across those two runs `boardSnapshot`'s fastest sample moved 225.0 -> 225.8
(0.4%) while its median moved 242 -> 243 and its worst sample moved 731 -> 433; measured again on
the build host it was 219.6. Three machines, three load conditions, ~3% apart.

**The fix was the STATISTIC, not the threshold.** All five gated budgets in
`perf-opd-queue.test.ts` and `perf-patient-search.test.ts` now compare `fastest(times)` instead of
`median(times)`; every budget number is unchanged; both figures are still logged. Contention only
ever ADDS time, so the minimum is the least-noisy estimator of the cost worth gating.

Note what was NOT done and why, because the tempting fix was wrong: raising the ceiling. Normal
`openVisit` is ~21 ms against a 100 ms budget, so the budget was never tight — absorbing a contended
window would have meant raising it past ~300 ms and destroying the gate. `boardSnapshot` is the
cautionary case: its ceiling was already raised 300 -> 500 for this exact reason (ledger §4,
2026-08-17), and it still threw a 433 ms sample in a PASSING run.

**Proof the gate still gates:** a mutant adding a fixed 150 ms to the measured block raises the
floor to 176.7 and fails — `Expected: < 100 / Received: 176.65`. And on the recorded failing
distribution, `min(107.3, 230.0, 275.9, 59.4, 48.3)` = 48.3, so the run that went red now passes
with 2x headroom.

**What 08.5 must take from this.** (a) Any timing assertion this plan writes — sweep latency, the
dispatcher's cycle, the five-minute transcript — gates on the *fastest* observation or on an
invariant, never on a mean or median taken under whatever load the box had. (b) The worker itself
adds background load to the same box the perf gates run on; if a sweep interval is short enough to
matter, say so and measure it. (c) This was the THIRD occurrence of "a CI-enforced perf ceiling
authored from an isolated measurement" — if the plan authors any new budget, derive it under
parallel load and record the distribution in the plan.

### 6.2 A dated-suite bomb, in a scheduling plan

`apps/core/test/opd-lifecycle.e2e.test.ts` fails for the **last 30 minutes of every IST day** —
three legs at `expect(slot).toBeDefined()`, because the day's last bookable slot is 23:50 IST and
the test needs one >20 minutes out. Proven without ambiguity: a **docs-only commit** (`f76f82e`,
zero code changed) went CI-red on it. §3.41's class, in a file no pipeline-C task could reach.
**A plan about clocks and schedulers should not ship on top of a suite that fails on the clock.**
Recommend: fold the fix into 08.5 (inject `now`, per the repo's own Global Constraint that every
clock-reading service takes `now: Date = new Date()`), or book it explicitly.

### 6.3 Carried forward from pipeline C — triage each

None are 08.5's subject; all need an owner. Say which 08.5 absorbs and which get a slot:

- **The 15 s polling convention has ZERO teeth on `billing-office.tsx`** — mutant SURVIVED 11/11
  with all three `refetchInterval` lines deleted, while the README promises the behaviour by name.
  §3.34's third specimen. **08.5 adds another polling surface (the bell)** — decide the ownership
  rule now or make it a fourth specimen.
- **`eie_advance_refunded` renders as an ordinary retryable error** in the back office; T14 handed it
  forward in a source comment and T16 never received it (§3.46). The guard cost ~380k tokens to add.
- **The cashier holds no `tariff.read`**, so "Add service" 403s on a runbook-seeded deployment.
  Needs an owner ruling — README/seed are the fix, not a screen.
- **`MoneyInput` flashes a refusal on the decimal keystroke** of every rupees-and-paise entry and
  `paiseToRupeeText` is dead code that will misbehave on the first negative seed.
- **Flag ⑧ has no discharging assertion** — `billing-counter.test.tsx` mocks the router outright, and
  the OPD→counter deep link it describes **does not exist in the app at all** (no OPD screen
  references `/billing`). D8's pay-before-consult loop has no navigation. §3.30's second occurrence.
- **`router.tsx` has no test file** and now carries five `validateSearch` blocks and fifteen routes.
- **Two more unpaginated, undated list routes** (`GET /billing/refunds`, `listMismatches`), both
  polled every 15 s; `listMismatches` resolves patient names the screen never renders.
- **K41's fixture cannot separate "the typed amount" from "the tender total"** — a surviving
  unprompted mutant on the plan's most load-bearing money assertion. One extra keystroke closes it.
- **The PAN projection has no test teeth** — replacing it with `{ ...row }` leaves the suite green.

### 6.4 Owner decisions with lead time that no pipeline can produce

From the architecture review §8, still open and still gating: **(ii)** deployment topology + the
second server (blocks Plan 11); **(iii)** inference locus + who authors the DPIA (blocks 12a);
**(iv)** clinical knowledge sourcing — drug/interaction database, terminology, IDSP lists (gates
stage 2 and every clinical drafter, and is unbudgeted). **Do not design around these; list them as
decisions and say what stalls without each.**

---

## 7. Traps specific to this plan (the roadmap's nine, plus what the last pipeline taught)

Carry the roadmap's traps (1)–(9) verbatim — the worker is never load-bearing for a human flow; the
tail and the dispatcher are different cursors and must never be merged; jest runs sweeps directly,
never through the scheduler; no Redis, no broker, no second scheduler; quiet hours are Plan 10's;
the alerts consumer is idempotent on `source_event_id` and **never fans out patient identity**;
Plan 11's partition floor must stay one added predicate; the worker heartbeat is 12a's precedent.
Trap (7) is discharged (8C is closed).

Add these, earned in the last 48 hours:

- **The alert body rule is a §14 public-surface rule, and it needs a MUTANT, not a comment.** "Never
  patient identity" is exactly the shape of §3.34's untested convention. Name the mutant that renders
  a name and the assertion that kills it.
- **`/health` reporting `degraded` when the worker is stale is a claim about an absence.** §3.14:
  for every "assert X is absent", name the fixture field that would have made X appear and confirm
  the fixture carries it.
- **The five-minute real-clock transcript in the gate report is not a test.** It is a demonstration.
  Say so, and name the deterministic test that actually proves each sweep is registered (the roadmap
  already asks for a fake-clock test that every registered job is invoked).
- **Four new tables land in one migration.** State the rollback before generating, list the full
  generator output set, and add every table to `truncateAll` in the correct statement.

---

## 8. Hard constraints

- **Write nothing under `apps/`. Run no pipeline. Compile nothing. Spawn no coder agents.** If you
  want a measurement you cannot take, make it a verify-by-execution flag or a spike question.
- Reading the repo is fine and expected. Running read-only commands on the build host is fine.
- **≤ 6 tasks, ONE consumer, one pipeline.** The roadmap is emphatic and the review's §9 is
  emphatic. If your design needs a seventh task, cut scope rather than adding one — and say what you
  cut and why.
- Target ≤ 1.5M subagent tokens for the eventual pipeline; note the estimate and its basis.
- The plan is a document, committed to `docs/superpowers/plans/`. Nothing else changes.

---

## 9. The one thing to keep in view

The architecture review's §9: *"The day it ships, the OPD wait ladder fires, approvals escalate, the
daily close closes, no-shows become events, and — for the first time — the system does something
nobody asked it to do at that moment. That is the operating system switching on."*

Six written, tested sweeps do not run. Every OPD visit's SLA and every approval's closure SLA are
rows that never mature. The plan that fixes that should be the smallest one in the series, and its
risk is concentrated in exactly one place: **the dispatcher's correctness under concurrency.** Spend
the verification there and keep everything else boring.
