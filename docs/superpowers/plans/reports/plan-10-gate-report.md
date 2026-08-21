# Plan 10 — The Notifications Gateway · GATE REPORT

**Verdict: SHIPPED, with two MAJOR gaps in protection booked and one CI criterion undischarged.**

Six task commits, five waves, thirteen agents, no rung escalations, no wave stall, no halt.
`origin/main` is at `b6d5647`, CI green, and the system now speaks to someone outside the building
for the first time — through a console sink, demonstrated live below.

Written by the compiling/verifying main session, 2026-08-22. Every number in this report was
re-derived by that session on the build host; nothing here is copied from an agent's self-report
without having been reproduced, and where I only reasoned, I say so.

---

## 1. What shipped

| task | commit | subject | files |
|---|---|---|---|
| T1 | `48f118e` | `feat(core): migration 0015 — the notifications outbox, opt-in and deceased columns, staff phone` | 9 |
| T2 | `0f512c3` | `feat(core): the template registry — five templates, two languages by type, four notify events` | 3 |
| T3 | `b7546cf` | `feat(core): channel adapters — console WhatsApp/SMS, provider selection, three defaulted keys` | 4 |
| T4 | `342cea5` | `feat(core): the notification pump — claim-before-send, the suppression gauntlet, quiet hours, the ladder` | 7 |
| T5 | `bb0b4ad` | `feat(core): the notify consumer — five subscriptions, the owner-SMS dead-end, one importable consumers map` | 12 |
| T6 | `b6d5647` | `feat(web): opt-in at registration, deceased on the patient record, the notify strings` | 9 |

Every subject is the plan's exact table entry. Three docs-only commits from the owner's machine
(`ca2cf55`, `cedce86`, `b4da495`) landed interleaved with these during the run — rule 11 anticipates
exactly that, T5's coder rebased over one of them cleanly, and none of the three is this pipeline's.
*(The T5 gate's inbox entry says the six commits sit in `git log` "with nothing between them from
another source"; that is the one factual error I found in the inbox, and it is harmless.)*

**The gateway as built:** an outbox table every would-be message becomes a row in first; a pump that
is the seventh job on 08.5's `Scheduler`, claiming rows with `FOR UPDATE SKIP LOCKED` **before** any
adapter call; a versioned code registry of five templates in two languages enforced by the type
system; a `kernel.notify` consumer on the shipped dispatcher that enqueues and does nothing else;
and a desk flag that turns an unreachable patient into a human task instead of a silent failure.

---

## 2. Independent main-session verification

Not an agent's report. Run by me, on `root@62.238.106.231:/opt/hmis` at `b6d5647`.

**`pnpm verify`, detached, exit VALUE read from `/opt/hmis/.mainverify.exit`: `0`.**

| workspace | baseline (5641931) | now (b6d5647) | delta |
|---|---|---|---|
| `apps/core` | 126 suites / 811 tests | **132 suites / 908 tests** | +6 / +97 |
| `apps/web` | 31 files / 147 tests | **31 files / 152 tests** | +0 / +5 |
| `packages/contracts` | 3 suites / 7 tests | 3 suites / 7 tests | — |

No workspace total decreased. No test was deleted anywhere in the range. Zero failures in the run.
`verify` is `pnpm typecheck && pnpm lint && pnpm test`, so exit 0 certifies typecheck and lint too.

**Per-commit Files-list audit** — every path in every commit's diff matched against that task's
Files list by glob, mechanically, for all six commits: **IN-SCOPE, six for six.** Not one
out-of-scope path in the whole range.

**Frozen-path audit over `1eac9ab..b6d5647`:**
- `*package.json` / `pnpm-lock.yaml`: **no diff anywhere.** No dependency entered the repo;
  `pg-boss` did not.
- `apps/core/src/kernel/events/dispatcher.ts`: **3 insertions, 0 deletions**, and they are exactly
  the three D5/GC10 permits —
  ```
  +  occurredAt: Date | string;                    (the WindowRow field)
  +             e.occurred_at as "occurredAt",     (the one added select column)
  +        occurredAt: new Date(row.occurredAt),   (the one construction line)
  ```
  The window predicate, the delivery claim, the cursor arithmetic and the backoff are byte-identical.
  `event_cursors` semantics untouched (prompt trap 6 respected).

**Server tree:** `git status --porcelain` reports exactly one entry — the untracked
`docs/superpowers/plans/reports/plan-10-findings-inbox.md`, which is the pipeline's own §2.39
channel and is committed alongside this report. A `find` sweep for `*.mutant.*`, `*.prefix.*`,
`.*.log`, `.*.exit` and `dr-*.test.ts` under `/opt/hmis` returns **nothing**. Every agent cleaned up
after itself, including the discovery reviewer, which built four mutants and left none.

---

## 3. CI — and this is the section that is not clean

| commit | run | duration | verdict |
|---|---|---|---|
| `48f118e` T1 | 32511993986 | 351 s | **GREEN** |
| `0f512c3` T2 | — | — | **NO RUN EXISTS. UNDISCHARGED.** |
| `b7546cf` T3 | 32517439216 att.1 | 400 s | RED — and it genuinely ran |
| `b7546cf` T3 | 32517439216 att.2 | 445 s | **GREEN** on re-run of the identical commit |
| `342cea5` T4 | 32522798156 | 441 s | **GREEN** |
| `bb0b4ad` T5 | 32530580284 | 433 s | **GREEN** |
| `b6d5647` T6 | 32533430721 | 410 s | **GREEN** |

Every duration is minutes, not seconds, so none of these is §2.59's third state. The account's
billing block is not active; the repo is still PUBLIC.

### 3a. T3 went RED, and it was a flake — proved by re-running, not by arguing

The failure was one test:

```
FAIL src/kernel/worker/scheduler.test.ts
  ● Scheduler › the registration census (L14) › invokes all six jobs within a faked 25 hours…
    expect(received).toEqual(expected)
    - Set { "runDailyClose", "runDispatchCycle", "runDueTimers",
            "sweepAppointmentNoShows", "sweepExpiredTempRoles", "sweepGuardianMajority" }
    + Set {}
    at src/kernel/worker/scheduler.test.ts:235:34
  Tests: 1 failed, 849 passed, 850 total
```

`invoked` came back **completely empty** — not five of six, none. `scheduler.jobs()` had already
passed six lines earlier, so registration worked and the 25-fake-hour advance simply did no work
before `stop()` latched. **I re-ran the same job on the same commit: attempt 2 is GREEN in 445 s.**
That is an executed answer, not an inference — and it matters, because the inference available
without it ("T3 broke the census") is false: T3's diff is four files, none of them the scheduler,
the census, or `jobs.ts`.

**Booked as a real defect anyway**, because a flaky census is a census that can be green for the
wrong reason: `scheduler.test.ts`'s 25-hour advance is starvation-sensitive under CI's slower
container. This is the third time this file has produced a lesson (§2.57, §2.60, now this).

### 3b. T2's commit has no CI run at all, and this is a new failure mode

`0f512c3` has **no workflow run of any kind** — not a billing-blocked one, none. T2 and T3 ran in
parallel in wave 2; the push that carried T2's commit to `origin` also carried T3's, and GitHub
Actions raises one `push` event per push, for the tip. **A wave's parallel tasks can coalesce their
commits into one push and silently deprive the earlier commit of CI**, and nothing in the method
watches for that. `ci-watch.sh` cannot see it either (§3c).

I cannot create the run retroactively: the workflow declares only `on: [push, pull_request]`, and
`workflow_dispatch` on a bare SHA is refused (`422 No ref found`). Adding a trigger would be a
`.github/workflows` edit outside this plan's File Structure, so I did not.

**Honest status: the criterion "CI green at `0f512c3`" is UNDISCHARGED.** What I *can* state, and
did verify: T2's three files (`templates.ts`, `templates.test.ts`, `events.ts`) are **byte-identical**
at `0f512c3`, at `b7546cf` (green, 445 s) and at `HEAD` (green, 410 s) — `git diff` between those
commits over those three paths is empty — and the tree at `0f512c3` differs from the CI-green tree
at `b7546cf` only by T3's four added files. That is discharge by equivalence, and it is not the
same thing as CI at that SHA. I am not going to call it green.

### 3c. `ci-watch.sh` ran for the whole pipeline and caught nothing

It was started before the first task commit and left running, exactly as the execute prompt
requires. It reported nothing useful for five and a half hours. Its loop walks
`git rev-list --reverse origin/main -20` and, on rc 2 (pending *or* did-not-run), `continue`s
**without adding the sha to `seen`** — so every sweep re-reports the same three historical
billing-blocked commits (`840c746`, `99d0f1b`, `b0f00f6`) forever, and the log fills with them. Its
last line for the entire run was `0f512c3  no run yet`, which is true and permanent, because that
run will never exist.

So the artefact §2.55 built to close the "six commits shipped red" hole **did not fire on the one
commit that went red in this pipeline.** I found T3's red by querying `gh` myself in Phase 4 — i.e.
in the epilogue, which is precisely the position §2.55(b) says is too late. The tool needs fixing;
the lesson is in §8.

---

## 4. The Assertion Book — every row, with expected-vs-received

Fifteen rows. **Twenty mutants built across T4 and T5, twenty DIED, zero survived**, every kill by
an assertion's own failure with counts quoted from isolated output. T5's gate independently
**rebuilt all nine of its mutants from scratch** and all nine died again. No required-DIED survivor
was silently fixed or silently accepted, so AGENT-RULES §3's two branches were never reached.

| # | task | verdict | the kill |
|---|---|---|---|
| **N1** | T4 | **DIED ×2** · `2 failed, 24 skipped, 26 total` | Deceased check deleted. `expect(calls).toEqual([])` → `+ [{ channel:"whatsapp", to:"9876500001", text:"अस्पताल में आपका स्वागत है…" }]`. Shipped: `suppressed` row + `notification.suppressed(deceased)` + **zero adapter calls**, with the patient marked deceased AFTER enqueue. Second kill is the merge-chain leg: the mutant messaged the survivor of a chain whose survivor is deceased |
| **N2** | T2 + T4 | **DIED** · `1 failed, 12 skipped, 13 total` | Leg (a): refusal deleted → `Received promise resolved instead of rejected / Resolved to value: {"id":"01M0JZ1650Y6J7VW8P5141ADEG"}` — the mutant inserted the promotional row. Leg (b), the honest pin (catalog has zero promotional entries), ships in T2's `templates.test.ts`, labelled as a pin. **Both legs shipped; the pin alone would have been a task failure** |
| **N3** | T4 | **DIED** · `1 failed, 25 skipped, 26 total` | Expiry gate deleted → adapter called on a `patient_welcome` whose `occurredAt` is 72 h back. This is the replay defense |
| **N4** | T4 | **DIED** · `1 failed, 25 skipped, 26 total` | Claim moved after the send. A fake adapter reads its own row's status from the DB when invoked: `expect(observed).toEqual(["sending"])` → `- "sending"` / `+ "queued"` |
| **N5** | T4 | **DIED ×2 twice** · `2 failed, 20 skipped, 4 passed, 26 total` (each) | **§7.4 prediction — see §4a.** N5a (both boundary comparisons flipped): 21:00:00.000 IST `Expected 2026-08-22T02:30:00.000Z / Received null`; 08:00:00.000 IST `toBeNull() / Received 2026-08-21T02:30:00.000Z`. N5b (IST offset dropped): same two instants, same expected-vs-received |
| **N6** | T5 | **DIED** · `4 failed, 8 passed, 12 total` | Dedupe key varied → `Expected length: 6 / Received length: 12` |
| **N7** | T4 | **DIED** · `1 failed, 25 skipped, 26 total` | Rung-advance arm deleted. Three WhatsApp throws → `expect(advanced.rung).toBe(1)` → `Expected 1 / Received 0`: the mutant stays on WhatsApp forever |
| **N8** | T5 | **DIED ×2** · a: `3 failed, 5 passed, 8 total`; b: `4 failed, 4 passed, 8 total` | a: `notification.failed` branch neutered → no desk flag. b: the Book's literal "delete the branch" → falls through to the escalation parser, ZodError `expected string, received undefined` — which is itself the second reason the manifest subscription and the branch are one edit |
| **N9** | T4 | **DIED** · `1 failed, 25 skipped, 26 total` | Phone-null check deleted → `+ [{ channel:"whatsapp", to:"" }]`. The mutant needed one purely type-level substitution to compile; the obstacle was the LANGUAGE, not the assertion (rule 21), and it is disclosed as such |
| **N10** | T5 | **DIED** · `2 failed, 10 passed, 12 total` | Consumer copies `e.patientId` into staff/owner params → `toEqual` +1: `"patientId": "01M0K4F8PD…"`. Whole-object equality, from a patientful `escalation.triggered` |
| **N11** | T5 | **DIED ×2** · `1 failed, 10 passed, 11 total` (each) | a: select `now()` → `Expected 2026-05-04T09:17:23.000Z / Received 2026-08-21T21:44:03.908Z`. b: drop the projection → `Received Date { NaN }` |
| **N12** | T5 | **DIED ×3** · a/b: `3 failed, 3 passed, 6 total`; c: `1 failed, 5 passed, 6 total` | a: drop the `kernel.notify` consumers-map entry → boot error. b: drop `kernel.alerts` instead → boot error naming "alerts". c: drop `registry.install(notifyManifest)` — **which boot cannot catch** — → dies on the pairs whole-equality, the entire `kernel.notify` element missing. Both legs have teeth |
| **N13** | T4 | **DIED** · `1 failed, 25 skipped, 26 total` | Append outside the won-flip guard. Second completion against one `sending` row → `Expected false / Received true`, and the event count would have been 2 |
| **N14** | T4 | **DIED** · `1 failed, 25 skipped, 26 total` | Recovery arm re-queues instead of flagging → `+ [{ channel:"whatsapp", notificationId:"01HT4PUMPSTUCKROW00000001", to:"9876500001" }]`. **The mutant re-sent a message that may already be with the patient** |
| **N15** | T4 | **DIED** · `1 failed, 25 skipped, 26 total` | Merge chain not walked → `Expected "9876522222" / Received "9876511111"` |

Every mutant was `cmp -s`-checked against its source before running (no silent no-op edits), and
every one typechecked — so **no kill in this table is a TS2532-class or nominal-typing artefact**
(rule 21's two traps, §2.26 and §2.61). T5's fail-first was a typecheck-only red (`TS2741
'occurredAt' is missing`), correctly disclosed under §2.5 as proving the field's absence and
nothing semantic; the semantic reds are N11a/N11b.

### 4a. N5 was the plan's one pre-declared prediction, and the honest answer is mixed

**Verdict: the Book's stated inputs discriminated — but only two of the five.** Confirmed by
execution: **21:00:00.000 IST** and **08:00:00.000 IST** each separate the shipped function from
*both* mutants. The other three do not, and T4 said so rather than letting the row read as fully
confirmed:

- **20:59:59.999 IST** passes under both mutants — hour 20 is outside every variant of the window.
- **07:59:59.999 IST** passes under both — under N5b the two errors cancel and it returns the
  correct `2026-08-21T02:30:00.000Z`.
- **the urgent row at 23:00 IST** is an absence pin, not a discriminator: urgency short-circuits
  before any boundary arithmetic runs.

All five inputs shipped. Two are the teeth; three are honest bounds. **No input adjustment was
needed**, so the §7.4 branch that routes to "adjust the input" was not taken. This is exactly what
§2.57 asks for: the Book's stated input is a prediction, and the shipping task confirmed by
execution which parts of it actually separate the implementations.

---

## 5. The flag-④ demonstration — a real scheduler, not a test

Dev compose (`hmis-db-1`, `hmis_dev`), migration 0015 applied, four outbox rows seeded, the real
`pnpm --filter @hmis/core start:worker` booted and left running for ~20 s (four pump intervals at
the shipped 5000 ms default), then SIGTERM.

**Four rows, not the three the flag names, and the fourth is the point.** The run happened at
**04:41 IST**, which is *inside* quiet hours (21:00–08:00). A fresh patient/routine row would
therefore be *deferred* by design — so a three-row demonstration whose "one send" was a patient row
would have failed through correct behaviour, and one whose send was a staff row without saying why
would have quietly hidden that. Row D is the control that makes the transcript honest.

### The transcript

```
> @hmis/core@0.1.0 start:worker /opt/hmis/apps/core
> tsx src/worker.ts

[Nest] 3642196  - 08/21/2026, 11:13:04 PM     LOG [NestFactory] Starting Nest application...
[Nest] 3642196  - 08/21/2026, 11:13:04 PM     LOG [InstanceLoader] WorkerModule dependencies initialized +24ms
worker started: jobs=runDispatchCycle,runDueTimers,sweepExpiredTempRoles,sweepGuardianMajority,sweepAppointmentNoShows,runDailyClose,runNotifyPump
{"channel":"whatsapp","to":"9810000001","notificationId":"01KDEMOROWA00000000000AA","text":"Escalation: \"opd_triage\" is at state \"waiting\" (rung 1, role duty_manager). Plea"}
```

**Exactly one console send line.** Note the boot line: **seven** jobs, the pump registered last —
this is amendment 7's census, live. And note the body: a staff escalation carrying `defKey`,
`state`, `rung`, `role` and **no patient identity** (GC5/N10), truncated at 80 characters as D11
specifies.

### The rows afterwards

| row | audience / template | status | last_error | channel | next attempt (IST) |
|---|---|---|---|---|---|
| A fresh, urgent | staff / `staff_escalation` | **`sent`** | | whatsapp (v1) | |
| B stale | patient / `patient_welcome` | **`expired`** | | | |
| C deceased patient | patient / `patient_welcome` | **`suppressed`** | `deceased` | | |
| D fresh, routine, alive | patient / `patient_welcome` | `queued` | | | **2026-08-22 08:00:00** |

### The events appended

```
 seq |          name           |  reason  |     template     | channel
-----+-------------------------+----------+------------------+----------
  13 | notification.sent       |          | staff_escalation | whatsapp
  14 | notification.expired    |          | patient_welcome  |
  15 | notification.suppressed | deceased | patient_welcome  |
```

**One send, one `expired`, one `suppressed(deceased)` — the flag discharged.** Plus row D held to
`08:00:00` IST exactly, which is D7's boundary observed in production code rather than in a fixture.
Row C had a phone, was not expired, and was not promotional: the *only* reason it did not send is
the D-33 hard stop, and the suppression event is the audit trail that proves the stop fired.

The dev database retains these rows and their three events as the record of the demonstration;
append-only event rows are not something to hand-delete. The dev DB holds no `patient.registered`,
`appointment.booked` or `escalation.triggered` events, so the first-boot cursor flood the 08.5 gate
report predicted **could not be exercised here** and remains untested — Plan 11's cursor-seeding
step is still the thing that closes it.

---

## 6. Amendment 7 — what the compile-time sweep bought

Run before a single brief was written, and it found one **HALT-class** defect the plan's own §7.1
path sweep structurally could not: the defect was not a *wrong* path but a *missing* one.

T4 registers a seventh scheduler job and widens `JobIntervals`. Three shipped artefacts break the
instant it does, in two files T4's Files list did not name:

- `src/kernel/worker/scheduler.test.ts` — owned by **nobody**, therefore frozen to all six tasks.
  It holds `THE_SIX`, `spyOnTheSix`, and `const CENSUS_INTERVALS: JobIntervals = { …three keys }`,
  an object literal that stops typechecking the moment the `Pick` widens.
- `test/worker-runtime.e2e.test.ts` — its own `THE_SIX` census. Owned by **T5**, one wave later.

And the plan named the wrong file for the work: *"the census in `jobs.test.ts`"*. `jobs.test.ts`
holds no job-name census at all.

Under §2.25 the frozen block is generated from the Files lists, so T4's brief would have told it
that the correct action was the forbidden action — B2's exact shape — and T4's `pnpm verify` could
not have been green. The fix added no task and touched no design: T4 gained both files,
`worker-runtime.e2e.test.ts` became a deliberate two-owner file across sequential waves 3 → 4 named
in both briefs, and self-review item 7's "Two-owner files: none" was corrected in place rather than
left standing. **Landed in the plan and in the pipeline script in one commit (`1eac9ab`) — §2.54.**

The pre-flight that guarded it: **196 assertions, exit VALUE 0, five negative controls observed to
fail**, including the §2.54 plan-vs-script `files` comparison in both directions — the assertion
08.5's 83-assertion pre-flight lacked, and the one that cost that plan its headline deliverable.

---

## 7. Findings booked, not fixed

The discovery reviewer read all six commits together, ran four mutants on the build host, and
cleaned up after itself. **The shipped code is correct in every case below**; what is booked is
missing *protection*, plus one genuine cross-commit chain.

### 7.1 MAJOR — nothing pins the suppression gauntlet's ORDER, and the consequence reaches a person

**`pump.ts` prepareRow · executed, with the harm executed too.**

The D-33 deceased hard stop can be relocated from gauntlet position 2 to the very end of
`prepareRow` — after expiry, the promotional belt, quiet hours, channel resolution and render — and
**the entire shipped T4 suite stays green**: `pump.gauntletorder.mutant.test.ts` → `Tests: 26
passed, 26 total`, exit 0. Both N1 tests pass, because their patient has a phone, so the relocated
stop still fires before any adapter call.

The harm is in the case N1 does not cover. A patient who is **both deceased and phoneless** (D-34's
designed path) no longer takes the deceased stop at all under the mutant — they take the `no_phone`
rung, which appends `notification.failed`, which `alertsConsumer` turns into a `manual_notify` desk
task reading *"Notify manually: patient_welcome … Please contact the patient from the record linked
below"* for every duty manager. **That is an instruction to a human being to phone a dead patient's
family** — precisely what D10 says the hard stop exists to make structurally impossible. Executed
side by side: shipped → `{ status:'suppressed', suppressed:1, failed:0 }`, zero adapter calls;
mutant → `{ status:'undeliverable', suppressed:0, failed:1 }`, zero adapter calls but a desk task.

**This also corrects an inbox entry.** T4's gate booked the order as unenforced (inbox item 5) and
concluded *"both orders are non-sends, so nothing reaches a person either way"*. That holds for the
expiry/deceased swap it built and **does not hold** for a relocation past channel resolution. A
routed finding is a claim (§2.60) — this is the second specimen, and this time the claim was true
but too narrow.

**The missing assertion is one row:** a deceased AND phoneless patient must be
`suppressed(deceased)` with zero `notification.failed`. I did not write it — that is a code change
beyond this pipeline's six tasks and beyond a gate report. **Recommended as the first item of any
Plan 10 remediation.**

### 7.2 MAJOR — `NOTIFY_STUCK_AFTER_MS` is a dead configuration key

**Executed.** `config.ts` parses it and exposes `cfg.notifyStuckAfterMs`; `jobs.ts:151` registers
`runNotifyPump(db, { now })`; `JobIntervals` was widened for `workerNotifyIntervalMs` **only**. No
`AppConfig` value reaches the pump, which always falls back to its own module constant
`DEFAULT_STUCK_AFTER_MS = 300_000`. An operator who sets the key gets nothing.

Proved rather than argued: `loadConfig({… NOTIFY_STUCK_AFTER_MS:'1000'})` → `cfg.notifyStuckAfterMs
=== 1000`; a `sending` row two minutes stale, put through the **production call shape**
`runNotifyPump(db, { now })`, stayed `sending`; the same call with `{ now, stuckAfterMs:
cfg.notifyStuckAfterMs }` flipped it to `undeliverable`. The row was recoverable all along; the
only missing thing is the wire.

Two things make it more than a dead key. `pump.ts:54`'s comment says it *"mirrors
NOTIFY_STUCK_AFTER_MS's zod default"* — a duplicated literal that can drift with nothing noticing.
And `config.test.ts:38-43` asserts the three keys **parse**, which looks like protection and is
§2.60's exact class: configuration set with no assertion that it took effect.

**This is the `WORKER_DAILY_TICK_MS` specimen, repeated inside the plan that was told about it.**
`NOTIFY_PROVIDER`'s non-consumption *was* disclosed (inbox item 4, with a candid docstring at
`pump.ts:66-75`); this one was disclosed by nobody. Fix is one line either way: thread it, or delete
the key and state the window is design law like the quiet-hours bounds.

### 7.3 MINOR — a defect shipped dormant by T4 and armed by T5

**Executed end to end.** T4 and T5 disagree, in code, about whether an `audience='patient'` outbox
row with no `patient_id` can exist. T4 says it can: `pump.test.ts:490` constructs exactly that row
and calls it *"the shape that reaches the pump when something else writes the table"*, and tolerates
it gracefully. T4's own stuck sweep then converts it, five minutes later, into
`notification.failed(stuck_sending, audience:'patient')` whose envelope carries `patientId` null.
T5 then shipped `alerts/consumer.ts:176-181`, which **throws** on precisely that combination and
documents it as *"Structurally unreachable"*. It is unreachable through `enqueueNotification` — the
only writer today — but not through the path T4's own test says to expect, and the chain crosses a
commit boundary, so no per-task gate could see both halves. Consequence when it fires: a handler
throw on `kernel.alerts`, i.e. a head-of-line stall then a dead letter. *(The onward stall is
REASONED from documented dispatcher behaviour, not observed.)*

### 7.4 NOTE — the pump's cadence binding is unasserted (REASONED, not executed)

The census asserts a `Set`, so it proves `runNotifyPump` fires within 25 fake hours but cannot see
*which* interval key it was registered with. Changing `jobs.ts:150` to any other `JobIntervals`
member compiles (all four are `number`) and still fires. Amendment 7 bought protection that the key
*exists* — `CENSUS_INTERVALS` stops compiling when the `Pick` widens — but a type cannot pin which
of four numbers a registration reads. Low severity: a wrong cadence is a throughput bug, not a wrong
message. The reviewer states plainly it did not build this mutant.

### 7.5 NOTE — `paramStr` renders the string `"undefined"` rather than throwing (REASONED)

`String(value)` on a missing param means three of the five templates cannot take D3's render-error
arm: `patient_welcome` would send *"Your UHID is undefined."* to a real patient. No live producer
can trigger it today — every param comes from a `payloadSchema.parse` result whose fields are
non-optional — so this is defensive-design debt, not a bug. Making `paramStr` throw would route
these to the desk, which is the outcome D3 chose.

### 7.6 Host residue I did not touch

Two orphaned shells are still spinning on the build host, first flagged by T5's gate and confirmed
by T6's and by me:

```
3501080  bash -c while pgrep -f "jest-worker|jest/bin/jest.js" >/dev/null; do sleep 5; done; echo CLEAR
3502071  (identical)
```

Their own command line contains `jest-worker`, so **they match themselves and can never exit** —
and they will make the next agent's rule-20 probe look like a live jest suite. Three agents and I
all declined to kill them under rule 8 (never infer from a process who started it). They consume a
`pgrep` every five seconds and nothing else. **Recommend the owner kills them**; naming them here is
the alternative to guessing.

---

## 8. What this run cost, honestly

**2,643,332 subagent tokens against a ≤1.2M target — 2.2× over.** 13 agents, 950 tool uses,
5 h 25 m wall clock. Reported rather than rounded, because the target was in the prompt.

Where it went, and what I think is true about it:

- **Thirteen agents at ~203k each is the Plan 08 rate**, the exact number EXECUTE-METHOD v2 §7 set
  out to cut to ~1.3–1.5M. The review split worked as designed — 4 cheap mechanical checks instead
  of 4 opus gates — and the total still doubled.
- **The tiering dial did not pay here, and §8's calibration note predicted that.** It says to count
  the required-DIED mutants before promising a number. This plan's Book has **fifteen rows**, of
  which T4 and T5 own thirteen, and they produced **twenty mutants**. That count *is* the plan's own
  risk assessment, and a 1.2M target was not consistent with it. The target was mine to sanity-check
  at compile time against §8's own rule, and I did not.
- **The gates re-earned part of their cost.** T5's gate rebuilt all nine mutants from scratch —
  expensive, found nothing this time, and is the same practice that caught 08.5's surviving census
  mutant. I would not cut it.
- **The discovery reviewer was the best-value agent in the run.** It produced both MAJOR findings
  with executed evidence, corrected a false-in-part inbox entry, and cost one agent.

**The honest read: 1.2M was the wrong number for this plan, not a budget this run overspent.**
A plan with twenty mutants on the send path costs what it costs.

---

## 9. Lessons (appended to EXECUTION-LESSONS.md the same session)

1. **§2.62 — parallel tasks in one wave can coalesce their pushes and silently deprive a commit of
   CI.** `0f512c3` has no run at all, and no checklist in this project looks for *absence* of a run
   at a SHA that is not HEAD.
2. **§2.63 — `ci-watch.sh` stalls permanently on the first commit that has no run**, because rc 2
   `continue`s without marking the sha seen. §2.55's own artefact did not fire on the one red commit
   in the pipeline it was written for.
3. **§2.64 — the L14 25-hour census is starvation-flaky under CI load**, and a red that a rerun
   turns green is the mirror of §2.59's third state: the job ran, and was still not evidence about
   the code. Re-run before diagnosing a red whose diff cannot explain it.
4. **§2.65 — the compile-time sweep's forward-reference pass catches a class the path sweep cannot:
   a file that no task names and that a widened type will break.** §2.46 resolves the paths a plan
   *wrote down*; §2.47 finds the ones it did not.
5. **§2.66 — `pkill -f <pattern>` matches its own invoking shell**, exactly as `pgrep -af` does
   (§2.53) — but where `pgrep` merely misleads, `pkill` *acts*: mine killed my own SSH session
   mid-demonstration and orphaned the worker. Kill by PID.
6. **§2.67 — a routed finding can be true and still too narrow** (§2.60's second specimen): T4's
   gate correctly booked the gauntlet order as unenforced and wrongly concluded it was harmless,
   because it built the one mutant whose relocation stayed inside the non-send region.
7. **§2.68 — check the token target against the Assertion Book's own row count at compile time.**
   EXECUTE-METHOD §8 already says the tiering dial pays in proportion to routine work and to count
   the required-DIED mutants first. Twenty mutants and a 1.2M target were never compatible.

---

## 10. Status and what is NOT next

**Plan 10 is SHIPPED.** Gateway only, by owner ruling 1. The relay half — `apps/relay`, signed
tokens, queue-position and document-verification pages — remains split out, awaiting the **E-1 /
deployment-topology decision** (spec :793), which is still open and which also blocks Plan 11.

Booked out of this run, in the order I would take them:

1. The deceased-and-phoneless assertion (§7.1) — one test row, on the surface where a polite pass is
   the worst outcome.
2. `NOTIFY_STUCK_AFTER_MS` (§7.2) — thread it or delete it.
3. `ci-watch.sh`'s stall (§2.63) and the coalesced-push blind spot (§2.62).
4. The patient-audience-without-patient_id chain (§7.3).
5. The two orphaned host shells (§7.6) — owner's call.

Still booked where 08.5 left them and untouched here: `start()`-clears-latch, `shutdownWorker`'s
logger `.catch`, `TS151002` noise, the OPD `SubmitButton` retrofit, `POLL_MS`. **Closed by this
plan:** 08.5 gate-report booked item 1 — `workerConsumers` is now the one importable place the
production consumers map exists, and N12's three mutants prove deleting either entry fails.

**This session stops here.** The relay plan, Plan 10.5 and Plan 11 belong to a session that reads
this report cold.
