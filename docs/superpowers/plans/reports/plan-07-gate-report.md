# Plan 07 — OPD: Encounters, Appointments, Queues, Vitals · Gate Report

**Executed:** 2026-08-16 → 2026-08-18, **three pipelines, sixteen tasks**, strictly sequential within each. **Plan:** [`2026-08-15-phase1-07-opd-encounters.md`](../2026-08-15-phase1-07-opd-encounters.md) (authored `6c98374`).
**Owner approval:** in-conversation 2026-08-15, of the plan as written including its three-pipeline split, its tier map, its single-migration rule, and its 52-row Assertion Book.
**Workflows:** pipeline A `wf_… (2026-08-16)` · pipeline B `wf_f4eb0d48-a85` + remediation `wf_d0eeaf1f-c7e` · **pipeline C `wf_3aecc306-a6e`**, script `plan07-pipelineC.js`.

**Headline: 16 of 16 tasks shipped and gate-passed. The plan's whole surface — twelve tables, one migration, 47 routes, a new realtime kernel and six web screens — is on `main`, CI-green, with `apps/core` at 93 suites / 536 tests and `apps/web` at 21 files / 80 tests.**

The organizing rule was tripwire 21: *an unexecuted discrimination claim is a prediction*. Across the plan it earned its cost repeatedly, and pipeline C is its clearest outing — **every one of the fourteen required-DIED rows in C was rebuilt independently by its own gate rather than accepted from the coder's report, and all fourteen died.** More valuable still, the gates built **eight mutants nobody asked for**, and **three of them survived** — each one exposing an acceptance criterion or a stated convention that claimed more proof than its tests deliver. That is the mechanism working exactly as designed: the passing tasks were correct, and the *evidence* about them was overstated in three specific, now-recorded places.

---

## 1. Final state

| | |
|---|---|
| Plan 07 commits | **24** on `main`, `f395a0a` → `7705590`, linear. `2e5144b` (Plan 06.2) and `f7dce8b` are ancestors of HEAD — **no history rewrite anywhere in the plan** |
| `apps/core` | **93 suites / 536 tests** (from 69 / 396 at `2e5144b`) |
| `apps/web` | **21 files / 80 tests** (from 11 / 37 — byte-untouched until pipeline C) |
| `packages/contracts` | 3 suites / 7 tests — **unchanged all plan** |
| `pnpm verify` | exit **0**, read from a captured file (tripwires 16–18), re-run independently by the main session after pipeline C |
| CI | **green on every commit except `f84f1b1`** — see §5 |
| Migrations | exactly one: `0010_silent_victor_mancha` (+ `meta/0010_snapshot.json`, rewritten `_journal.json`). 11 total in the repo |
| Server tree | HEAD == `origin/main` == `7705590`; `git status --porcelain` **empty**; zero mutant or scratch residue |

**Test-count ladder, `apps/core`:** 396 → **408** (T1) → **425** (T2) → **445** (T3) → **454** (T4) → **474** (T5) → **483** (T6) → **500** (T7) → **517** (T8) → **524** (T9) → **535** (T10) → **536** (R1 remediation).
**Test-count ladder, `apps/web`:** 37 → **48** (T11) → **57** (T12) → **63** (T13) → **68** (T14) → **76** (T15) → **80** (T16).

**Every rung hit its predicted number exactly.** No task padded, split, deleted or invented a test to reach a count. The one deviation from the plan document — `apps/core` finishing at 536 rather than the plan's 535 — is the remediation task R1 adding one tail test, and it was recorded in the plan's Pipeline Notes before pipeline C compiled.

---

## 2. Task outcomes

| # | Task | Tier | Commit | Attempts | Outcome |
|---|---|---|---|---|---|
| T1 | Schema — twelve tables, migration 0010, truncate group, IST helpers | opus | `f395a0a` | 1 | pass |
| T2 | Events catalog, config, masters, weekly schedules, pure slots | sonnet | `4985112` | 1 | pass — disclosed the D8 event-count discrepancy |
| T3 | Encounter spine — definition, sessions, tokens, visit type | opus | `48a0012` | 1 | pass — **falsified flag ③** |
| T4 | Appointments — book/reschedule/cancel/check-in, sweeps, leave cascade | sonnet | `9cf9e5e` | 1 | pass |
| T5 | Queue — pure engine, property tests, call/skip/start, serializer | opus | `ccaa949` | 1 | pass |
| T6 | Vitals — age-banded rules, danger flags, `seed:opd` | sonnet | `63b12a9` | 1 | pass — gate mutant V4 **SURVIVED** (§3.29) |
| T7 | Consultation + e-Rx, allergy warning, FHIR, signed QR | opus | `00d93ea` | 1 | pass — **falsified flag ⑪** |
| T8 | Realtime kernel — event tail + WS gateway, OPD topic router | opus | `56ccb4c` | 1 | pass — shipped a dormant shutdown race |
| T9 | Module surface — manifest, three controllers, 47 routes, first e2e | opus | `f84f1b1` | 1 | pass — **CI red**, armed T8's race |
| T10 | Lifecycle e2e over HTTP+WS, CI perf gate, docs | opus | `b378df1` + `2b7c436` | 2 | pass — rung-1 rejection on an unachievable 300 ms budget |
| R1 | Remediation — tail shutdown + wall-clock vitals fixtures | opus | `f7dce8b` | 1 | pass — **falsified a prescribed evidence mechanism** (§2.17) |
| T11 | Realtime client + hook, wire types, dev proxy, masters admin | opus | `6d14df0` | 1 | pass — **discharged flag ⑱** |
| T12 | Appointments screen, patient picker, token slip, print isolation | sonnet | `26d7429` | 1 | pass |
| T13 | The OPD desk — walk-in, arrivals, live queue, abandon, transfer | opus | `4e2d37d` | 1 | pass — one harness stall, retried same rung |
| T14 | Vitals desk — band-aware required fields, danger flags, allergy | sonnet | `bd88f38` + `ce2d104` | 2 | **gate rejection** — see §7.1 |
| T15 | Consultation screen — queue, note, Rx editor, printed e-Rx | opus | `7b034a8` | 1 | pass — confirmed the E5 plan defect the brief predicted |
| T16 | Token display board, bilingual speech, nav, web docs | sonnet | `fcbf9a3` + `7705590` | 2 | **gate rejection** — see §7.2 |

**16/16 gate-passed. Three formal gate rejections across the plan** (T10, T14, T16), each landing as a **new follow-up commit** — never an amend, never a force-push, on any of the twenty-four commits.

---

## 3. Verification evidence (main session, independent of every agent self-report)

Performed after pipeline C, on the server, with every exit code written to a file and read back as a **value** (tripwires 16–18); nothing below is an agent's claim.

| Check | Result |
|---|---|
| `pnpm verify` (whole repo, detached) | exit **0** |
| `apps/web` | `Test Files 21 passed (21)` / `Tests 80 passed (80)` |
| `apps/core` | `Test Suites: 93 passed, 93 total` / `Tests: 536 passed, 536 total` |
| `packages/contracts` | `Test Suites: 3 passed, 3 total` / `Tests: 7 passed, 7 total` |
| Flaky-prone isolation: `opd-display.test.tsx` ×3 | `Test Files 1 passed (1)` / `Tests 4 passed (4)` — 3/3 clean (fake timers + stubbed speech) |
| Known flake: `qr.test.ts` | 7/7 passed, exit 0 (the 1-in-4096 tamper flake did not fire) |
| Interference (tripwire 20) | `pgrep -af vitest` and `pgrep -af jest` clean before and after — **none observed** |
| Ancestry | `6b9a47f` and `f7dce8b` both ancestors of HEAD; history linear |
| Server tree | `git status --porcelain` **empty**; residue sweep for `*.mutant*` / `*gateX*` / `.*.log` / `.*.exit` returned nothing |
| CI by SHA (local `gh`, all 8 pipeline-C commits) | `6d14df0` `26d7429` `4e2d37d` `bd88f38` `ce2d104` `7b034a8` `fcbf9a3` `7705590` — **all `completed / success`** |

**Whole-range frozen-path audit** — `git diff --name-only 6b9a47f..origin/main` filtered per path, every one empty:

`apps/core/**` · `packages/contracts/**` · both `package.json` · `pnpm-lock.yaml` · `.github/**` · `apps/web/src/components/ui/**` · and all five Plan 05 screens (`registration-desk`, `patient-detail`, `merge-review`, `approvals-inbox`, `login`).

**`apps/core/**` is byte-untouched across all eight pipeline-C commits** — the pipeline's single hardest constraint, and it held without a gate ever having to enforce it. Pipeline C's whole diff is **28 files, +6,389 / −7**, and every commit's file list matches its task's Files list exactly: `vite.config.ts` **+2 lines** (T11), `styles.css` **+7** (T12), README at the **repo root** (T16, erratum E1 honoured — `apps/core/README.md` was not created).

---

## 4. Interface delta

- **47 HTTP routes** across three controllers (`opd-masters`, `opd-queue`, `opd-visits`), all `@Controller("opd")`. `modules/opd/index.ts` is the cross-module interface; the six screens consume HTTP only.
- **19 `defineEvent` calls** — the 18 D8 catalog names + `qr.signature_failed`, all `module: "opd"`. Three ratified catalog additions recorded here: **`queue.called`, `queue.skipped`, `visit.abandoned`**.
- **New kernel folder `kernel/realtime/`** — the per-process event tail and the WebSocket gateway. Protocol: connect `/ws`, first frame `{"type":"auth","token"}` within 5 s, then `{"type":"subscribe","topics":[…]}`. Topics `queue:<doctorId>:<serviceDate>` (`opd.queue.read`), `display:<roomId>` (`opd.display.read`), `encounter:<encounterId>` (`opd.visits.read`). **Permission is checked at SUBSCRIBE only.**
- **14 `opd.*` permissions and 6 menu entries** in `modules/opd/manifest.ts`; recommended per-role grants in the root `README.md`.
- **Web:** `lib/realtime.ts` (`RealtimeClient` + `useRealtime`), `lib/opd-api.ts` (29 exported wire types + `opdErrorMessage` + `todayIst`), six screens, three reusable components (`PatientPicker`, `TokenSlip`, `RxPrint`), `.print-doc` print isolation, four global shortcuts (Alt+P/D/V/C) plus four consult-local ones, and the `/opd` + `/ws` dev proxy entries.
- **OPD error body is `{ statusCode, message, code, detail? }`** — a deliberate new convention, without the `code: message` string prefix the older modules use.

---

## 5. Deviations

Carried forward deliberately; none is a defect in this plan's work.

1. **CI is red on `f84f1b1` (T9) and stays red.** It failed on the realtime-tail shutdown race that `f7dce8b` fixed two commits later. All 524 tests passed; the *suite* failed at teardown. History is immutable (tripwire 15), everything from `b378df1` onward is green including HEAD.
2. **`workflow.controller.ts:142`** orders transitions by a bare `at` with no tie-break. Plan 07 touched no workflow read surface; carried to the next plan that owns one.
3. **`qr.test.ts`'s 1-in-4096 tamper flake** — frozen file, future owner. Did not fire in this session's verification.
4. Everything in gate reports 01–06.2 §4/§5: the `code: message` prefix on patients/tariff bodies, the open `ConfigError`/`TariffErrorCode`/`PatientError` code sets, the simulate route's permission, the tariff m2/m4/m9 deferrals.

### Errata landed against this plan during execution

| # | Erratum |
|---|---|
| D8 | The catalog is **18 P1 names + `qr.signature_failed` = 19** `defineEvent` calls, not seventeen. One stale "seventeen" remains deliberately in T2's code block, matching the shipped source comment |
| E1 | The docs file is the **repo-root `README.md`**; `apps/core/README.md` does not exist and never did |
| E2 | The `boardSnapshot` budget is **500 ms**, not 300 — the 300 ms ceiling was authored from an isolated measurement and fails ~1 run in 3 under parallel load |
| E3 | `not_a_doctor` is **404** on `GET /opd/me/doctor`, 400 when service-raised elsewhere |
| E4 | Flag ⑫ had no home in T9's six prescribed tests; discharged by extending test 6 |
| E5 | Every POST not annotated returns Nest's default **201** — and **E5's own count of "twelve" is wrong.** Measured this session from all three controllers: **21 POST routes, of which 20 return 201**; exactly one, `POST /opd/prescriptions/verify`, carries `@HttpCode(200)`. E5's binding half (screens must not assume 200) is correct; its number is not |
| E6 | Flag ⑪'s "serializes" half is **FALSIFIED** (Mutant P1 SURVIVED 10/10); the unique index carries correctness |
| ③ | **FALSIFIED** — drizzle's `Tx` **is** assignable to `Db` |
| ⑱ | **DISCHARGED, and its worry was unfounded**: `<input type="time">` under `user-event` in jsdom behaves normally — probed before the test was designed, `user.type(input, "09:00")` yields `"09:00"` in both the DOM and the submitted form value |

---

## 6. The Assertion Book, EXECUTED — pipeline C's rows

Fourteen required-DIED rows, **every one rebuilt independently by its own gate** rather than accepted from the coder's report.

| Row | Task | Mutant | Coder | Gate rebuild | Verdict |
|---|---|---|---|---|---|
| K39 | T11 | W1 — subscribe on `open`, ahead of auth | DIED 3/3 | DIED 3/3 | ✅ |
| K40 | T11 | W2 — unsubscribe when any handler leaves | DIED 3/3 | DIED 3/3 | ✅ |
| K41 | T11 | W3 — schedules PUT without coercion | DIED 3/3 | DIED 3/3 | ✅ |
| K42 | T12 | A1 — check-in enabled on non-today rows | DIED 3/3 | DIED 3/3 | ✅ |
| K43 | T12 | A2 — slip root without `.print-doc` | DIED 3/3 | DIED 3/3 | ✅ |
| K44 | T13 | D1 — transfer posts without consent | DIED 3/3 | DIED 3/3 | ✅ |
| K45 | T13 | D2 — abandon posts an empty reason | DIED 3/3 | DIED 3/3 | ✅ |
| K46 | T14 | V1 — numbers posted as strings | DIED 3/3 | DIED 3/3 | ✅ |
| K47 | T14 | V2 — adult band always | DIED 3/3 | DIED 3/3 | ✅ |
| K48 | T15 | X1 — re-post without `overrides` | DIED 3/3 | DIED 3/3 | ✅ |
| K49 | T15 | X2 — `followUpDays: 7` sent explicitly | DIED 3/3 | DIED 3/3 | ✅ |
| K50 | T15 | X3 — a signature line added to the e-Rx | DIED 3/3 | DIED 3/3 | ✅ |
| K51 | T16 | B1 — English-only speech | DIED 3/3 | DIED 3/3 | ✅ |
| K52 | T16 | B2 — subscribes before Start | DIED 3/3 | DIED 3/3 | ✅ |

**14/14 DIED, under two independent builds each.**

Two of these deserve note because they are **absence** assertions, which pass trivially against a fixture that never carried the thing:

- **K50** (no signature line on the e-Rx) — X3 adds one and the test fails. Real.
- **T16 test 4** (no patient identifiers on the public board) — the gate built an unprompted mutant rendering `item.patientName`, and it **DIED**. The fixture carries `patientName: "Asha Devi"` and a UHID, fields the real `boardSnapshot` never emits, so the assertion could genuinely have failed. **The §3.14c trap is closed properly here, not by a rich-fixture illusion.**

---

## 7. The three gate rejections, in full

### 7.1 T14 — the harness was manufacturing the observable (pipeline C)

The coder stubbed the vitals success response as **`status: 200`** with the comment *"Nest's real 201 — the harness never branches on the exact 2xx code."*

The gate refused it: **that comment is a prediction, not evidence** — and it is precisely the trap the brief's HTTP-status section named, the test harness itself producing the observable the criterion wanted to see. `stubFetch` can only ever answer 200, so no shipped test exercised the real 201 that every unannotated OPD POST returns.

Second violation in the same verdict: `ENC_ADULT` inherited `dangerFlagged: false` from its factory while a comment claimed both fixtures carried the flag — so half of `expect(queryByText(/danger/i)).toBeNull()` was **vacuous**, passing against a fixture that never had the thing. A clean §3.14 specimen.

Both corrections landed in `ce2d104` (2 insertions, 2 deletions, test file only). The gate then verified non-vacuity by execution rather than by reading the diff: it rebuilt **V4** (worklist renders a Danger badge) and it **DIED** — proving the fixture change genuinely un-vacuumed the assertion — and confirmed test 4's 201 is now a **genuine** 201, served by the file's own direct `vi.stubGlobal`, not by `stubFetch`.

### 7.2 T16 — a plan requirement silently dropped (pipeline C)

The plan's Task 16 Step 2 requires *"Hindi/English labels both shown (the display is bilingual by design — §15 Hindi/English day one)"*. Every label went through a single `t()` call, so the waiting-room TV rendered labels in **one** language. The gate failed it against the plan text, prescribed `i18next.getFixedT('hi')` / `getFixedT('en')`, and flagged that `getByRole('button', { name: 'Start' })` matches the accessible name exactly and would break once the button carried both languages.

Fixed in `7705590`. The gate's correction 8 explicitly asked the coder to **rule on** the no-rooms edge case rather than change behaviour silently — and it did, deferring it with reasons. That is §2.16 working: the finding is on the record with an owner, not evaporating into a transcript. It is carried forward in §10.

### 7.3 T10 — an unachievable perf budget (pipeline B)

The plan's `boardSnapshot` budget of 300 ms held in isolation (median 250 ms) and broke under full-suite parallel load (median 310 ms); the gate measured 1 failure in 3 full runs. Raised to 500 ms in `2b7c436` and recorded as erratum E2. **A plan number falsified by measurement, not argued away.**

---

## 8. What the gates found that nobody asked them to look for

Pipeline C's gates built **eight unprompted mutants**. Five died, confirming assertions; **three survived**, and each survivor is a place where something claimed more proof than it delivers. All three passed their tasks anyway — the code is correct in every case; the *evidence* was overstated.

| Gate mutant | Result | What it exposed |
|---|---|---|
| T11 `GX` — `refetchInterval` neutered | **SURVIVED** | The binding web convention *"every screen polls its read model every 15 s"* is correct in the shipped screen and **wholly unasserted**. Deleting the polling fails no test in T11 |
| T14 `V5` — previous patient's age leaked into the band | **SURVIVED** | Criterion 6 claims the 404 path "falls back to the adult band". The test selects the hidden row right after the **adult** row, so a stale-age implementation renders the same band. The restricted-banner half discriminates; the adult-band half does not. Fix for a future owner: select the hidden row after the **3-year-old** |
| T15 `gateX4` — Alt+K / Alt+S / Alt+Enter deleted | **SURVIVED** | Only **one** of the four consult-screen shortcuts (Alt+N) has any test. Deleting the other three fails nothing. The criterion was met by inspection but its wording invites the reader to believe all four are proven |
| T12 `P1` — `PatientPicker.onPick` contract widened | DIED 3/3 | The picker had **no Assertion Book row** despite T13 being required to import it. The gate closed the gap itself |
| T13 `G1` — realtime callback body emptied | DIED 2/2 | Proves the realtime-refetch assertion genuinely discriminates: with timers frozen, only the frame handler can produce the second `GET /opd/queues` |
| T14 `V3` — `invalidateQueries` dropped | DIED | The row-leaves-the-worklist assertion has teeth |
| T14 `V4` — danger badge rendered | DIED | Confirmed the T14 correction landed non-vacuously |
| T16 — `patientName` rendered on the board | DIED | The §14 confidentiality absence assertion is real, not a fixture artefact |

Three further gate findings worth keeping, none a violation:

- **K41's stakes were overstated by my own brief.** The shipped server route already coerces (`weekday: z.coerce.number().int()`), so a client posting `"1"` would **not** have failed in production on that route. K41 still legitimately proves the client-side coercion is load-bearing against the test — the row is sound, the framing was not.
- **`RealtimeClient.reconnectTimer` is assigned and never read or cleared.** If every handler unsubscribes while a reconnect is pending, the timer still fires and opens one socket carrying zero topics; it stabilises on the next close. One wasted connection, not a leak. The code is the plan's verbatim block, and `realtime.ts` is outside every later task's Files list — so only a future plan can own it.
- **The QR scan lane fires only on a native paste event.** Typical hospital USB/Bluetooth scanners are keyboard wedges: they *type* the payload and press Enter, they never paste. The plan's own wording ("pasting a QR payload") authorises what shipped, so this is not a task defect — but **as built the scan lane will not work with a wedge scanner at a real desk.** Flagged for UAT.

---

## 9. Infrastructure and process

- **Pipeline C ran 16 agents, 0 errors, 0 skipped, `halted: []`.** One harness stall (`opus:t13`, no progress at 1032 s) was retried on the **same rung** with the tier unchanged — §2.1 behaving correctly.
- **Pre-flight caught nothing; the launch caught a duplicate declaration.** The compiled script carried `function brief()` **twice** — my `finish()` extraction ran three lines long. Both prescribed checks passed it: `node --check` parses a `.js` file in **sloppy script mode**, where a duplicate function declaration is legal, and the `new Function` dry-run silently let the last declaration win, so all six rendered briefs were correct and nothing looked wrong. The workflow harness parses top-level bindings **lexically** and rejected it in milliseconds. A module-parse probe now exists and was proved to discriminate by appending a duplicate and watching it fail. See §12.
- **Pipeline B's `HALTS` block was compiled and never referenced** — a dead constant, so B's briefs carried halt conditions only through scattered inline mentions. Found while reusing B's script; C's `brief()` includes it and the dry-run asserts its presence per task.
- **`${PIPESTATUS[0]}` is a bash-ism and `/bin/sh` on this host is dash.** A detached `setsid nohup sh -c` wrapper dies with `Bad substitution` and destroys the run. Spawn with explicit `/bin/bash -c`, or write each run's exit code to its own file. Secondary: `pkill -f` on a vitest path pattern matches the SSH command's own command line and kills the session.
- **Two `@testing-library` / vitest harness facts, both proved rather than assumed.** `waitFor` cannot drive vitest's fake timers — RTL gates its clock-advance on a global `jest`, which vitest does not define, so `waitFor` never advances the sinon clock and times out at 5000 ms; counts after `advanceTimersByTimeAsync` must be read directly. And `vi.setSystemTime()` **without** `vi.useFakeTimers()` does pin `Date` (proved with a throwaway probe — the idiom was already in use but had never been verified, a §2.17 inert-mechanism candidate that turned out sound); `vi.useFakeTimers()` throws if called after it, so the working order is `useRealTimers()` → `useFakeTimers()` → `setSystemTime()`.
- **A stray-scratch hazard in the finish step.** T13 found two untracked scratch files (`.web-base.log`, `.web-base.exit`) already sitting in `/opt/hmis` when it started. The mandated finish step is `git add -A`, which would have swept them into the commit and broken the clean-tree criterion. The coder deleted them and disclosed it. The durable fix belongs to the brief: name explicit paths, or require a status check before `git add -A`.

---

## 10. Open items and carried forward

**Go-live items this plan creates** (owner work, not code):

`seed:opd` per environment · the `opd_visit` Class-A activation runbook (owner + MS approvals) · role grants for the 14 `opd.*` permissions (recommended table in the root README) · letterhead, danger ranges and slot/follow-up config reviewed at UAT via `PUT /opd/config` · departments/rooms/doctors/schedules entered via `/opd/admin` (200+ doctors — a CSV import is a candidate fast-follow, **not** this plan) · display TVs opened on `/opd/display?rooms=…` with one Start click · `sweepAppointmentNoShows` joins Plan 11's pg-boss list as the fifth unscheduled sweep.

**Open defects, none blocking:**

1. `registerPatient` derives `dob` from the wall clock instead of taking `now: Date = new Date()`, contradicting this plan's own Global Constraint — the durable fix for the §3.31 date bomb. `test/helpers/opd.ts`'s `mkPatient` still defaults to `ageYears: 30`, so **the next hard-age assertion added anywhere re-arms it.** Needs a plan owning `modules/patients/`.
2. The lifecycle e2e's `FrameStream.waiter` is a single slot; a future *parallel* await on two frames would silently clear one. Dormant — every shipped await is sequential.
3. `opd-lifecycle.e2e.test.ts` needs a bookable slot 20+ minutes ahead on today's template, so CI goes red for calendar reasons roughly **23:30–midnight IST**. Fails loudly by design.
4. The gateway checks `hasPermission` only at SUBSCRIBE, never on fan-out, so a revoked role keeps receiving its topic for the socket's lifetime. Plan-specified; deserves an explicit decision in a later plan.
5. `modules/opd/realtime.ts` is a pure core but is not pinned by `purity.test.ts`.
6. `GET /opd/visits` does its queue-entry read directly in the controller — module-isolated and one query; worth lifting into `queue.ts` when a task owns it.

**New from pipeline C:**

7. **The display board never speaks on its default URL.** With no `?rooms=` param — the default TV deployment — `roomsFromSearch(undefined)` returns `[]`, so `useRealtime([])` subscribes to no topic. The board still fetches and shows every session of the day via the 15 s poll, so correctness is preserved by design D6 — but **the headline speech-calling feature is inert unless `?rooms=` is supplied.** Deserves a plan decision (subscribe-to-all vs. require `?rooms=`), not a silent carry-forward.
8. **The QR scan lane will not work with a keyboard-wedge scanner** (see §8). UAT decision.
9. **Three unasserted properties**, each shipped correct and each proven unasserted by a surviving gate mutant: the 15 s polling convention (T11 `GX`), the adult-band fallback on a 404 (T14 `V5`), and three of the four consult-screen shortcuts (T15 `gateX4`). Each has a named one-line fix in §8.
10. **The board's session-status word renders in one language** while the four labels beside it render in both — scoped out by the T16 correction, recorded as a decision rather than an oversight.
11. **`fmtIst` is duplicated** in `opd-appointments.tsx` and `opd-desk.tsx`, and `useDebounced` is duplicated from the frozen `registration-desk.tsx`. Both forced by Files-list boundaries; a later task owning `lib/opd-api.ts` should lift them.
12. **`keyboard.tsx` carries a stale comment** saying `/opd/consult` "is registered by later tasks" — no longer true after `7b034a8`. Left alone correctly (outside the Files list). Also `goUnregistered()` there holds one documented cast, needed because TanStack Router types `navigate({to})` against the generated route union and T13 registered shortcuts ahead of T14/T15's routes.

**Not this plan's work:** Plan 08 consumes `opd_encounters.visit_type` / `intended_payer`, `consultation.completed` and the `index.ts` exports for the pay-before-consult gate and the three-way fee · Plan 09 sets `opd_queue_entries.perk` and `opd_config.perk_every_nth` · Plan 10 subscribes to `patient.checked_in` / `queue.called` / `appointment.*` / `doctor_leave.scheduled` · Plan 12 owns call-tasks for unresolved `needs_rebooking` · per-access break-glass eventing → the EMR plan.

---

## 11. Cost accounting

| Pipeline | Agents | Subagent tokens | Wall clock |
|---|---|---|---|
| A (T1–T6) | 16 pipeline (12 completed, 4 killed by the session usage limit) + 1 scout | **2,086,381** | ~4h01m |
| B (T7–T10) + R1 | 13 pipeline (9 completed, 4 killed by one ENOTFOUND window) + 1 scout + 1 replacement gate + remediation | **2,149,202** | ~5h |
| **C (T11–T16)** | **16 pipeline (16 completed, 0 errors) + 1 scout** | **3,349,975** (pipeline 3,254,687 / scout 95,288) | **~6h06m** |
| **Plan 07 total** | **48 agents + 3 scouts** | **≈7.59M** | **≈15h** |

**Against a budgeted 5.2–6.8M (midpoint 5.9M): over by ~0.79M, ≈12% above the ceiling.** The overrun is entirely pipeline C. It was budgeted at ~1.8M and cost **3.35M — 86% over**, against a plan note that had already calibrated UI tasks *upward* after Plan 05 ran 42% over on the same class of work.

The honest read: **UI tasks with many small files, stubbed network calls and mutant obligations cost roughly twice what a backend task of similar scope costs, and two consecutive calibrations have now under-predicted them.** The next plan with web screens should budget **~550k per screen task**, not 300k. Note also that C's agents completed 16/16 with zero infrastructure deaths — unlike A (4 killed) and B (4 killed) — so this figure is a clean measurement of the work itself, not of retries.

---

## 12. Did the executed-mutant rule hold?

**Yes, and pipeline C is the strongest evidence for it in the ledger so far.**

Twenty-two mutants were built and run in pipeline C: fourteen required by the Assertion Book, all **DIED** under two independent builds each; eight built by gates on their own initiative, of which **five DIED and three SURVIVED**. Not one verdict in the pipeline was a hand-walk.

The three survivors are the whole argument. Every one of them sat behind a **green suite and a met criterion**, and every one revealed that something true about the code was **not actually proven by any test**: the polling convention, the adult-band fallback, three of four keyboard shortcuts. No amount of reading would have found them — the T11 gate had to neuter `refetchInterval` and watch five tests stay green.

The `findings` field is what made them survive into this document. In pipeline B, the run's most expensive process failure was a gate finding that named work for a later task and was routed to nobody (§2.16). In pipeline C **every gate discovery reached the report**, including the three that failed nothing and the one that corrected my own brief's framing of K41. A discovery recorded nowhere else dies with the transcript.

One caution to carry forward, raised independently by three of the six gates: **the fail-first evidence in this pipeline was structurally weak.** Every red run quoted was an import-resolution error (`Failed to resolve import "./opd-desk"`, `Tests: no tests`) — real output, honestly produced by a genuine test-first order, and it satisfies the criterion as written. But it proves only that the module was absent; **zero assertions ran**, so it says nothing about whether any assertion discriminates. For new-screen tasks, all of the discrimination evidence is carried by the Assertion Book, not the red run. A future brief wanting assertion-level red must say so explicitly.

---

## 13. Lessons for the ledger

Appended to `EXECUTION-LESSONS.md` this session:

- **§2.18** — `node --check` on a `.js` file parses sloppy script mode, where a duplicate top-level function declaration is **legal**; the workflow harness parses top-level bindings lexically and rejects it. A `new Function` dry-run does not catch it either, because the last declaration silently wins and every rendered brief looks correct. Pre-flight needs a **module-parse probe** alongside the dry-run, and the probe must be proved to discriminate.
- **§2.19** — A dead constant in a compiled brief template is invisible: pipeline B defined `HALTS` and never referenced it. Assert the *presence of each block in the rendered brief*, not merely that the constant exists.
- **§3.32** — A test harness can be the second mechanism producing the observable (§3.14c applied to the harness itself). `stubFetch` always answers **200**, so a screen branching on `res.status === 200` passes every test and fails in production against the real **201**. Caught by the T14 gate on a comment that predicted the property instead of proving it.
- **§3.33** — An **absence** assertion is only as good as the fixture's ability to violate it. T16's confidentiality test carries a `patientName` the real API never emits, so the assertion could genuinely fail — and a gate mutant proved it. Compare T14's `V5`, where the fixture ordering made the adult-band half of a criterion unprovable.
- **§3.34** — A *convention stated in a brief* is not a tested property. "Every screen polls every 15 s" was correct in all six screens and asserted in one. If a convention matters, one task must own an assertion for it.
- **Harness facts, all proved not assumed:** `waitFor` cannot drive vitest's fake timers (RTL gates on a global `jest`); `vi.setSystemTime()` alone does pin `Date`, and `useFakeTimers()` throws if called after it; `${PIPESTATUS[0]}` is a bash-ism and `/bin/sh` here is dash; `pkill -f <vitest path>` matches the SSH command's own command line.
- **Cost:** web screen tasks cost ~550k each, not 300k. Two consecutive plans have under-predicted this class.

---

<!-- PLAN 07 COMPLETE — 16/16 tasks, 3 pipelines, 24 commits, one migration -->
