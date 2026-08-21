# Plan 10 findings inbox

Entries are appended, never rewritten. Each entry names the task(s) it is for, states what was
found, and separates EXECUTED evidence from REASONED inference (AGENT-RULES §2.60).

---

## 2026-08-21 — from the Task 1 mechanical checker, FOR T4 (`enqueue.ts`/`pump.ts`) and T5 (`consumer.ts`)

Migration 0015 shipped at `48f118eebae71eae5b49996c39679f35f9604e05`. The Task 1 implementer's
own report already worked out the following for you but — as far as this checker can find — it
never reached this file (the file did not exist before this entry, on either side of Task 1's
run). Routing it here now so it is not lost.

1. **`notifications.params` is `jsonb NOT NULL`**, typed `.$type<Record<string, unknown>>()`. A
   paramless template must enqueue `{}`, never `null`/undefined. **EXECUTED** — read directly from
   `apps/core/src/kernel/db/schema/notifications.ts:36` on the server, and confirmed live: the
   schema test's raw-SQL insert that omits `expires_at` (not `params`) throws as expected, and the
   normal-path inserts throughout `notifications.test.ts` all supply `params`, which I ran
   independently (`notifications.test.ts`, 14/14 passed, exact path
   `src/kernel/db/schema/notifications.test.ts`).

2. **`occurred_at` and `expires_at` are both `timestamptz NOT NULL`** — no default on either. Any
   inserting code (T4's `enqueueNotification`) must always compute `expires_at` from the template's
   `expiresAt(params, occurredAt)` and always pass the event's `occurredAt` through (which is why
   T5's `DispatchedEvent.occurredAt` widening in `dispatcher.ts` matters to T4's caller, not just to
   T5). **EXECUTED** — read from `notifications.ts` and the generated SQL
   (`apps/core/drizzle/0015_previous_shiver_man.sql:12-13`) directly; the schema test "refuses a row
   with no expires_at" is a raw-SQL insert built specifically to bypass the drizzle insert type and
   observe the NOT NULL from below the type system — I ran it and it passed.

3. **`patient_id` and `user_id` are BOTH nullable and there is no CHECK constraint tying them to
   `audience`.** An `audience='patient'` row with no `patient_id` inserts fine at the DB layer — the
   coherence invariant is entirely the job of `enqueueNotification` (the only writer) and the pump
   that reads it. **EXECUTED** — read the column definitions directly, and independently ran the
   schema test named exactly "does NOT enforce audience/recipient coherence — that is app-enforced,
   and this pins it", which passed against the live table.

4. **The `notifications.test.ts` `beforeEach` calls `truncateAll(db)` before every test in that
   file, and that call depends on BOTH truncate statements in `test/helpers/db.ts` naming
   `notifications`** (lines 80 and 84, confirmed by this checker with `grep -n` against the server
   file). If a later task's edit to `test/helpers/db.ts` ever drops `notifications` from either
   statement, Postgres refuses the truncate at FK-constraint-existence check time and every test in
   `notifications.test.ts` dies at setup, not at an assertion. **REASONED, not executed with a
   mutant** — I did not remove the name from either statement and watch this fail; the mechanism
   (Postgres checks constraint existence, never row counts or statement order) is read from the
   file's own §3.35/§3.12 comments and from Postgres's documented TRUNCATE behaviour, not observed
   as a failure in this session.

Nothing above changes any acceptance criterion of Task 1 itself, which this checker verified
independently and passed. This entry exists solely so T4 and T5 do not have to re-derive these four
facts from the shipped schema on their own.

---

## 2026-08-22 — from Task 2 (`templates.ts`/`events.ts`), FOR T4 (`enqueue.ts`) — N2 leg (a), what remains

D9/N2's discriminating leg (a) needs `enqueueNotification` to THROW when handed a
`class: "promotional"` template. This task built its half: `NotificationTemplate`'s type and a
registry/accessor built the same way as the shipped `notificationTemplates`/`templateByKey` admit
a synthetic `class: "promotional"` entry with no compile or runtime obstacle. **EXECUTED** — see
`apps/core/src/kernel/notify/templates.test.ts`, describe block "D9's leg (a)": a synthetic
promotional template is constructed, placed in a test-local registry (`{ ...notificationTemplates,
[key]: synthetic }`), retrieved through a local `templateByKey`-shaped accessor, and asserted
`.class === "promotional"`; the whole file ran green, 17/17
(`pnpm --filter @hmis/core exec jest --passWithNoTests apps/core/src/kernel/notify/templates.test.ts`).

**What leg (a) still needs from T4:** `enqueueNotification(tx, input)` must resolve the template
(`templateByKey`), read its `.class`, and throw BEFORE any insert when it is `"promotional"` — and
T4's own test should build the SAME KIND of synthetic-promotional fixture (this task's shape is
directly reusable) and assert the throw. That is the only half missing; this task did not, and
could not from `templates.ts`/`events.ts` alone, exercise `enqueueNotification` itself.

Leg (b) — the honest pin (shipped catalog has zero `class: "promotional"` entries) — already
ships in this task's `templates.test.ts`, labelled explicitly as a pin, not a proof (§2.49): that
assertion alone is `[] === []` and would pass even against a broken refusal.

---

## 2026-08-22 — from the Task 4 GATE (reviewing `enqueue.ts`/`pump.ts`/`jobs.ts`), FOR T5

T4 shipped at `342cea5cf0f25fe62c56e4e4f61fcde46f53b398`. Four things T5 consumes are NOT what a
reading of the plan alone predicts. The task report states them; this file is where T5 will look.

1. **`enqueueNotification` takes NO `audience` argument and REFUSES an incoherent recipient.**
   Signature as shipped (`enqueue.ts:57-91`):
   `enqueueNotification(tx, { templateKey, params, dedupeKey, occurredAt, patientId?, userId?,
   sourceEventId?, refType?, refId?, scheduledFor? }): Promise<{ id: string } | null>`.
   `audience` is read from `template.audience`. A **patient**-audience template THROWS unless
   `patientId` is given AND `userId` is absent; a **staff/owner**-audience template THROWS unless
   `userId` is given AND `patientId` is **absent**.
   **THIS IS THE ONE THAT CAN BITE T5.** D13 fans `escalation.triggered` out to staff and owner
   templates, and that envelope carries a `patientId`. Passing it through to
   `enqueueNotification` will now THROW, not insert. It is also GC5-correct that it does: the
   shipped test `an owner_escalation_sms row narrows its own ladder to SMS and renders English`
   asserts `row.patientId` is `null` on a staff/owner outbox row.
   **EXECUTED** — I ran `enqueue.test.ts` (13/13 passed, `pnpm --filter @hmis/core exec jest
   --passWithNoTests apps/core/src/kernel/notify/enqueue.test.ts …`); its three
   "validations that have no CHECK constraint behind them" tests pin exactly these throws.
   `params` must be an object; a paramless template passes `{}` (inbox item 1 above, re-confirmed).

2. **`expireByRef(tx, refType, refId, now)` returns `Promise<number>`** — the count of rows it
   WON. The plan specifies no return. It updates `status = 'queued'` rows only and appends one
   `notification.expired` per won row; a second call returns 0 and appends nothing.
   **EXECUTED** — and mutant-checked by this gate: deleting the `eq(notifications.status,
   "queued")` predicate kills two shipped assertions (`Expected: 0 / Received: 2`), so the
   "never touches a sending or a sent row" guarantee is real, not asserted-by-comment.

3. **`test/worker-runtime.e2e.test.ts` as T4 left it (the deliberate two-owner file).** FOUR edits,
   nothing else touched: the header docstring line 42 says "seven jobs"; `THE_SIX` is renamed
   `THE_SEVEN` and gains `"runNotifyPump"` last (registration order); the test title at :306 says
   "EXACTLY the seven jobs"; and `expect(scheduler.jobs()).toEqual(THE_SEVEN)`. The identifier
   `THE_SIX` no longer exists anywhere in the repo. **Both `registerAllJobs(...)` call sites are
   UNTOUCHED** and still pass `{ [ALERTS_CONSUMER]: alertsConsumer(workerDb) }` — they are T5's to
   convert to `workerConsumers(workerDb)`. Do not restore six.
   **EXECUTED** — read from `git show 342cea5 -- apps/core/test/worker-runtime.e2e.test.ts` on the
   server; `grep -rn "THE_SIX" apps` returns nothing.

4. **The pump does NOT read `NOTIFY_PROVIDER` — it hard-codes `console` behind a module constant
   `PUMP_PROVIDER` (`pump.ts:74`), with `opts.adapters` as the injection seam.** `registerAllJobs`
   reads no environment (the B1 scar) and the plan's registration line is `runNotifyPump(db, {
   now })`, so no `AppConfig` reaches the pump. Behaviourally identical today (the zod enum has
   exactly one member) — but the day the enum widens, a configured provider is SILENTLY IGNORED by
   the production pump and `adaptersFor`'s exhaustive switch will not catch it, because
   `PUMP_PROVIDER` is still a valid `NotifyProvider`. Not T5's to fix; the provider plan must
   thread config in through `opts.adapters` or widen what `registerAllJobs` receives.
   **EXECUTED for the shipped behaviour** (read the constant and its only use);
   **REASONED for the future-enum consequence** — I did not widen the enum and watch it happen.

5. **Not a defect, recorded so nobody re-derives it: the gauntlet's ORDER is not mutant-enforced,
   only its stages are.** I built an unprompted mutant that moves the expiry gate from D4 stage 1
   to after the deceased stage; the whole of `pump.test.ts` still passes (`Test Suites: 1 passed`,
   `Tests: 26 passed, 26 total`). No Assertion Book row asks for the order, and both orders are
   non-sends, so nothing reaches a person either way. **EXECUTED** — the mutant was a separate
   scratch file, run, and deleted.

---

## 2026-08-22 — from the Task 5 GATE (reviewing `notify/consumer.ts`, `alerts/consumer.ts`, `dispatcher.ts`, `worker.module.ts`), FOR T6 and the MAIN SESSION

T5 shipped at `bb0b4ad64712f6b680debf4c0cc644ab7cf494a8` and PASSED this gate. Three things a later
task or the main session should not have to re-derive.

1. **FOR T6 — `patient.registered`'s payload is now PARSED AND PINNED by a shipping consumer.**
   `kernel/notify/consumer.ts` calls `patientRegistered.payloadSchema.parse(e.payload)` and reads
   `payload.uhid` and `payload.patientId`; `notify/consumer.test.ts` asserts the enqueued row's
   `params` with WHOLE-OBJECT equality `toEqual({ uhid: ASHA_UHID })`. T6 adds
   `promotionalOptIn` to the registration POST/PATCH surface — if that work also widens the
   `patient.registered` PAYLOAD (T6 step 1 as written does not, it changes only the controller
   schemas and `registration.ts` persistence), the notify consumer's params assertion is the test
   that will notice. Nothing in T6's Files list is imported by the notify consumer, so no change
   is expected; this is a heads-up, not a blocker.
   **EXECUTED** — read `consumer.ts:104-116` and `consumer.test.ts` on the server; ran
   `src/kernel/notify/consumer.test.ts` green (12/12) as part of a 4-suite isolated run,
   `Tests: 37 passed, 37 total`, exit value 0 read from a file.

2. **FOR A LATER PLAN, NOT T6 — `notifyManifest` is installed in `worker.module.ts` ONLY, never in
   `app.module.ts`.** `app.module.ts` installs `alertsManifest` (line 54) but no notify manifest,
   so the API-side `ModuleRegistry` does not carry the five `kernel.notify` subscriptions. It is
   INERT TODAY: the only API-side reader of `registry.all()` is `syncPermissions`
   (`kernel/auth/permissions.ts:12`), and `notifyManifest.permissions` and `.menu` are both `[]`;
   nothing API-side builds a subscription bus. It stops being inert the day the notify manifest
   gains a permission or a menu entry (a notification-centre UI is explicitly D14-deferred), and
   the asymmetry would then be silent. `app.module.ts` is in NO task's Files list in Plan 10, so
   T5 correctly did not touch it.
   **EXECUTED** — grepped every `registry.all()` / `buildSubscriptionBus` / `MODULE_REGISTRY`
   reference in `apps/core/src` (non-test) and read `app.module.ts:44-55` and
   `worker.module.ts:70-79` on the server. **REASONED** — the future consequence of adding a
   permission; I did not add one and watch it diverge.

3. **FOR THE MAIN SESSION — TWO ORPHANED, SELF-MATCHING WAIT-LOOP SHELLS ARE STILL SPINNING ON THE
   BUILD HOST** and they will make the next agent's rule-20 probe look like a live jest suite.
   PIDs 3501080 and 3502071, command line
   `bash -c while pgrep -f "jest-worker|jest/bin/jest.js" >/dev/null; do sleep 5; done; echo CLEAR`.
   Their own command line contains the literal `jest-worker`, so they match THEMSELVES and can
   never exit. They are NOT test runs. T5's coder reported them and did not kill them (rule 8);
   this gate confirms they are still there and also did not kill them. Read the matched COMMAND
   LINES, not the count (rule 20 / §2.53).
   **EXECUTED** — `pgrep -af jest` on the server at three separate points during this gate; the
   only real jest process ever present was my own single, sequential mutant run.

Nothing in this entry changes an acceptance criterion of Task 5, which this gate verified
independently: all nine mutants for N6/N8/N10/N11/N12 were REBUILT FROM SCRATCH by this gate as
separate files, run isolated, and all nine DIED with counts and expected-vs-received identical to
the coder's report.


---

## 2026-08-22 — from the Task 6 GATE (mechanical check on `patients.controller.ts`/`registration.ts`/web screens), FOR THE MAIN SESSION — Plan 10 is now task-complete

T6 shipped at `b6d56471ed02b9da1f9ec64251b38596477dfadc` and PASSED this gate. This was the final
task of Plan 10 (wave 5 of 5; no later task in this pipeline to route findings to), so this entry
is for whoever reads this file next — the main session, or a future plan's compile.

1. **Confirmed, not new: the two orphaned self-matching wait-loop shells the T5 gate flagged are
   STILL on the build host.** PIDs 3501080 and 3502071, same command line
   (`bash -c while pgrep -f "jest-worker|jest/bin/jest.js" >/dev/null; do sleep 5; done; echo CLEAR`).
   **EXECUTED** — `pgrep -af jest` run twice during this gate (once before measuring, once via a
   fresh `ssh ... 'pgrep -af jest'` call after launching detached verify); both times only these
   two PIDs matched, never a real jest run of mine or anyone else's. They still cannot exit
   (self-matching). Not killed — out of scope for this task's Files list and no instruction
   authorized it.
2. **All nine acceptance criteria for T6 verified independently against the server, not against
   the implementer's report.** `git show --stat b6d5647` names exactly the 9 files T6's Files list
   names (no more, no fewer); a frozen-path grep over that diff's `--name-only` output returned
   zero hits; `pnpm-lock.yaml` has no diff in this commit; locale key parity was re-derived
   programmatically on the server (`en` 697 keys, `hi` 697 keys, zero one-sided keys — matches the
   implementer's claimed count exactly); the PATCH-payload `toEqual` assertions and the
   flag-⑤-discharging test in `registration.test.ts` were re-run isolated on the server
   (`pnpm --filter @hmis/core exec jest --passWithNoTests src/modules/patients/registration.test.ts`,
   `Tests: 14 passed, 14 total`, both new tests named and green); a full detached `pnpm verify`
   was re-run from scratch by this gate, exit value 0 read from a file, with
   `packages/contracts 3/3 suites, 7/7 tests` (unchanged), `apps/web 31/31 files, 152/152 tests`
   (+5 over baseline, matching T6's two new screen-test files), `apps/core 132/132 suites,
   908/908 tests` (up from the pipeline's running total; no test deleted, diff inspected directly).
   **EXECUTED**, all of it, on `root@62.238.106.231:/opt/hmis` — no claim in this paragraph is
   taken from the implementer's report without having independently reproduced it.
3. **Plan 10 has no remaining task.** Five waves, six tasks, all shipped and gated:
   T1 `48f118e`, T2 `0f512c3`, T3 `b7546cf`, T4 `342cea5`, T5 `bb0b4ad`, T6 `b6d5647` — all present
   in `git log --oneline` on `origin/main` at the time of this gate, in that order, with nothing
   between them from another source. **EXECUTED** — read directly from `git log origin/main
   --oneline` on the server. What remains is CI on `b6d5647`, which this gate could not check
   (`gh` unauthenticated per the brief) and which is DELEGATED TO THE MAIN SESSION per the standing
   instruction.
