## 2026-08-21 — T2 mechanical check (worker process + scheduler) — for T3/T4/T6

Task T2 (commits e6f1e0f + 8efbb50, HEAD=origin/main=8efbb50f728121ba525234b48a24a1d619aecf9a) verified PASS. No blocking issue found. One non-blocking note for whoever next touches the worker's real-time behaviour (T6's worker-runtime.e2e.test.ts, most likely):

- `runDailyClose`'s IST due-window is exactly ONE minute wide (23:59 IST). The shipped production default `WORKER_DAILY_TICK_MS=30000` gives only ~2 ticks of margin inside that window. Under `pnpm verify`'s full parallel load, one run out of several missed `runDailyClose` once (a transient DB-hiccup-under-contention flake, not reproduced across 3 follow-up full runs). T2's own scheduler.test.ts (L14) works around this by overriding `WORKER_DAILY_TICK_MS` to 5000ms for its own fake-clock census only — the PRODUCTION default (30000ms) was deliberately left untouched (this is a design-decision/data-tuning matter, not a code defect T2 is scoped to fix). If T6's e2e suite ever drives the real scheduler across a real or simulated IST day boundary and observes an occasional missed `runDailyClose` tick under load, this is why — it is not a new regression.

Evidence: `apps/core/src/kernel/worker/scheduler.test.ts`'s `OVERRIDE` block and its comment (search for "STEPPED OVER daily-close's due window"); `git show 8efbb50` (the follow-up commit that added the `sweep.failed` test also carries the tick-margin comment).

## 2026-08-21 — T3 opus gate (dispatcher correctness) — for T4 and T6

Task T3 (commit `39e520d7f2eddd14e31ab0cec9f9535ce5554657`, HEAD=origin/main) verified PASS. Full
`pnpm verify` exit VALUE 0 (read from a file); apps/core 123 suites / 790 tests. Three of the five
required mutants (M-D1, M-D2, M-D4) were REBUILT INDEPENDENTLY by this gate and re-killed with
passing controls. Five things the next tasks need:

1. **`runDispatchCycle`'s SIGNATURE CHANGED — it is now `(db, bus, opts?: {batchSize?, lookback?,
   maxAttempts?, now?})`.** The old third positional argument (`batchSize = 100`) is GONE. T4's
   `consumer.test.ts` and T6's `worker-runtime.e2e.test.ts` must call it as
   `runDispatchCycle(db, bus, { now })` — which is what the plan's T6 step 1 already writes. A call
   passing a bare number now fails typecheck. `jobs.ts:75` calls `runDispatchCycle(db, bus)` with no
   third argument, so T2's production wiring is unaffected and needs no edit.

2. **A CONSUMER THAT THROWS BLOCKS ITS OWN QUEUE FOR ~30 s BEFORE IT PARKS — drive a SECOND cycle
   with `now` ADVANCED, or your e2e will see zero alerts and it will look like a wiring bug.** The
   dispatcher keeps the shipped in-order `break` per consumer: on a handler throw the row is written
   `retrying` with `next_attempt_at = now + min(2^attempts,60) s` (2 s at attempts=1, then 4, 8, 16)
   and NOTHING behind it is delivered until it succeeds or parks at attempts=5. A cycle driven with
   the SAME `now` as the failing one delivers 0 — the row is still inside its backoff. This is D4 as
   designed, not a defect; it is flagged because a T4/T6 arrange that fires one cycle and asserts an
   alert row will silently get 0 if the consumer throws once for any reason.
   Evidence: `dispatcher.test.ts` "does not advance the cursor past a failing handler" (cycle 2 must
   carry `at(2_000)`) and "parks a poison event after maxAttempts" (five cycles at 0/2/6/14/30 s).

3. **THE DISPATCHER CAN INVOKE A HANDLER TWICE FOR ONE EVENT, and that is now PROVEN, not assumed.**
   `dispatcher.test.ts`'s L5 shows two barrier-started concurrent cycles both invoking the handler
   before either claims (observed invocations = 2, with exactly one `event_deliveries` row at
   `done`). At-least-once plus idempotent consumers is the contract. T4's `ON CONFLICT
   (source_event_id, user_id) DO NOTHING RETURNING` is what absorbs it, and `alert.raised` must stay
   on the WON-insert branch only — a double invocation must not append the event twice.

4. **L2 catches the Book's M-D2 but NOT a weaker claim-before-work variant. Do not reuse L2's shape
   as the template for T4's own placement mutants.** This gate built an unprompted variant — the
   `done` claim moved above `await handler(event)` with the shipped `retrying` downgrade in the catch
   left UNCHANGED — and it SURVIVED T3's L2 spec unmodified (PASS, 320 ms), because after the caught
   throw the row is downgraded to `retrying` and cycle 2 redelivers, so every observable in the test
   is identical. The Book's M-D2 (claim before AND failure does not downgrade) died correctly with
   `Expected: 1 / Received: 0` and a passing control. The gap is real but narrow: the surviving
   variant still loses an event on PROCESS DEATH between the claim and handler completion, which no
   in-process test can stage. The cheap strengthening, if a later task wants it: assert from INSIDE
   the handler that no `done` row exists yet for that seq. Recorded as a finding, not a failure —
   T3's criterion names M-D2 and its numbers, and M-D2 died exactly as predicted.

5. **`jobs.ts` lines 59-61 are now FALSE and nobody in this pipeline owns the file.** The docstring
   reads "`dispatcher.ts` still reads `(db, bus, batchSize?)` with no `now` option; T3 owns that file
   and its rewrite (D4), not T2." After `39e520d` that is untrue. `jobs.ts` is T2's row and is frozen
   to T3, T4, T5 and T6 alike (T5's comment pass names nine files and this is not one of them), so
   this is a note for the owner / Plan 11, NOT an edit anyone here may make. Related, same file, also
   for Plan 11: the dispatch job is the only one of the six registered as `run: async () => ...`
   instead of `run: async (now) => ...`, so the scheduler's `now` is never threaded into the
   dispatcher's backoff in production. Behaviour is correct (the option defaults to `new Date()`) —
   it is an unexercised seam, and it is exactly the shape the ledger's 3.41 daily-close defect had.

6. **L4's Assertion Book input is a PLAN DEFECT and T3's in-task fix is CONFIRMED CORRECT.** The Book
   says M-D4 dies on "three cycles after L3's park". This gate rebuilt M-D4 (the `where
   event_deliveries.status <> 'parked'` guard deleted) and ran that exact input against it: the
   mutant PASSED (a parked row is filtered out of the window by `(d.status is null or d.status =
   'retrying')` and is never re-read, so it is never re-parked sequentially). The concurrent leg T3
   substituted — two barrier-synchronised cycles crossing `maxAttempts` together — killed it with
   `Expected: 1 / Received: 2` and a passing control. If any later plan copies L4's stated input,
   copy the concurrent one instead.

## 2026-08-21 — T4 coder (the alerts consumer, routes, per-user topic) — for T5, T6 and the owner

Task T4 shipped at commit `d13de0f32b344f6fe1f7a4d1dff231238053acfd`. Full `pnpm verify` exit VALUE
0 (read from a file); apps/core 125 suites / 802 tests. All six required mutants (M-A1..M-A6) DIED
with passing controls. **One BLOCKING plan defect and three facts the next tasks need.**

### 1. PLAN DEFECT (blocking for the plan's own goal, NOT for T4's criteria): the alerts consumer is NOT wired into the worker process, and no task in this pipeline can wire it.

**What the plan says.** File Structure lists `src/kernel/worker/worker.module.ts` as `T2 · T4
(alerts manifest + consumer — amendment 6)`; amendment 6 says *"T4's Files list gains
`apps/core/src/kernel/worker/worker.module.ts` — one edit: add `alertsManifest` to the registry
and `"kernel.alerts": alertsConsumer(db)` to the consumers map"*; T4 step 3 repeats it.

**What T4's compiled brief says.** The generated frozen-path block assigns
`apps/core/src/kernel/worker/worker.module.ts` to **T2 only** and does NOT list it for T4. The
brief states the block "was GENERATED from the tasks' own Files lists … so it CANNOT contradict
them. If it seems to, that is a finding." It does contradict them. **This is that finding.**

**T4 did NOT touch the file** — and that turned out to be the safe call for a second, independent
reason the amendment did not anticipate:

> **The consumers map is NOT in `worker.module.ts`. T2 put it in `worker.ts:26`
> (`registerAllJobs(scheduler, db, registry, {})`), which is frozen to T4 in the plan's OWN Files
> list as well as in the brief.** So the amendment-6 edit is not merely mis-routed, it is
> **incomplete**: adding `registry.install(alertsManifest)` to `worker.module.ts` WITHOUT adding
> the handler in `worker.ts` makes `buildSubscriptionBus` throw at worker boot by design
> (`jobs.ts:40-45` — "a declared subscription with no handler is a BOOT ERROR, not a silent
> skip"). Half the edit ships a worker that **crashes on startup**.

**Current state on `main` after `d13de0f`:**
- `app.module.ts` (the API process) DOES install `alertsManifest`. Harmless and correct: nothing in
  the API process calls `buildSubscriptionBus`, and the manifest mints no permission.
- `worker.module.ts` still installs seven manifests and carries T2's `// T4 (amendment 6) adds:`
  comment; `worker.ts:25-26` still passes `{}` and carries its matching comment. **The worker
  therefore runs the six sweeps but dispatches `escalation.triggered` to nobody.** No boot error,
  no crash — the seam is simply still empty in the worker's registry.

**What is needed (one commit, two files, both T2's):** `registry.install(alertsManifest)` in
`worker.module.ts` AND `{ "kernel.alerts": alertsConsumer(db) }` in `worker.ts`. Both files are
frozen to every remaining task in this pipeline. **This is an owner call: it needs either a
one-line plan amendment granting the two paths to T6, or a follow-up commit after the pipeline.**

**T6 must read this before writing `worker-runtime.e2e.test.ts`.** If T6's e2e boots the real
`WorkerModule` and expects an alert row to appear from a real escalation, **it will observe zero
alerts** and it will look exactly like a T4 wiring bug. It is not. T6 can still prove the full
chain by building the bus explicitly in the test —
`buildSubscriptionBus(registry, { "kernel.alerts": alertsConsumer(db) })` then
`runDispatchCycle(db, bus, { now })` — which is what `consumer.test.ts` does, and the seam itself
(declaration ⇒ handler, and a missing handler ⇒ throw) is already asserted there.

### 2. M-A1b: an EQUIVALENT MUTANT exists on the idempotency claim — do not "strengthen" it and do not report it as a hole.

Built and run unprompted beside the Book's M-A1. The Book names M-A1 as *"the `ON CONFLICT … DO
NOTHING` **target** dropped"*. Dropping the **whole clause** dies correctly (`Expected: "second:
resolved"` / `Received: "second: threw duplicate key value violates unique constraint
\"alerts_source_event_user_ux\""`). Dropping **only the target** — `.onConflictDoNothing()` with no
`target` — **SURVIVED** (PASS, 1 passed / 1 total, with a passing control).

It survives because it is genuinely equivalent: a targetless `ON CONFLICT DO NOTHING` absorbs every
unique violation, the RETURNING is still empty on conflict, and `alert.raised` still rides the
won-insert branch only. `alerts` has exactly one unique constraint this insert can violate
(`alerts_source_event_user_ux`; the `id` PK gets a fresh ULID every call), so **no test can
distinguish the two forms.** The shipped code keeps the explicit target because it documents the
idempotency unit; the survival is a property of the schema, not a gap in the assertion.

### 3. `TopicSpace` changed shape — `permission` is now OPTIONAL.

`export type TopicSpace = { prefix: string; permission?: string; authorize?: (userId, topic) => boolean }`,
with `registerTopicSpace` THROWING unless exactly one is declared. Every shipped space still
declares `permission` and every shipped gateway test is byte-unchanged (`git show d13de0f --
gateway.test.ts | grep "^-"` is empty — additions only). Anyone adding a topic space from here on
must declare exactly one of the two, or the app fails at module init rather than at subscribe.

### 4. The route contract T5's bell must code against (measured over HTTP, not predicted).

- `GET /alerts` → **200** `{ items: AlertRow[], unreadCount: number }`. `items` is capped at
  **50** (`ALERTS_PAGE_LIMIT`, exported from `kernel/alerts/alerts.ts`); `unreadCount` is a separate
  COUNT and is **not** capped — with 55 unread, `items.length === 50` and `unreadCount === 55`.
  Order: unread first, then `created_at` desc. `AlertRow` = `{ id, kind, title, body, refType,
  refId, createdAt, readAt }` — **no `userId` field on the wire**.
- `POST /alerts/:id/read` → **201** (Nest's default POST status, not 200)
  `{ alertId, readAt, alreadyRead }`. A repeat returns 201 with `alreadyRead: true` and appends
  nothing. Another user's alert id → **404** `{ message: "unknown_alert <id>" }` — deliberately not
  403, so there is no existence leak. The route takes **no idempotency key**; it is naturally
  idempotent (`SubmitButton` may still mint one — the server ignores it here).
- Both routes: an `x-agent-key` request → **403** `{ message: "user_actor_required" }`, refused in
  the handler. No `alerts.read` permission exists and none was minted — access is identity-scoped,
  so no seeded role needs anything granted for the bell to work.
- Realtime: subscribe to **`alerts:<actor.id>`** exactly. Any other user's topic is refused with
  `{ type: "error", code: "forbidden_topic", topics: [...] }`. The frame is
  `{ type: "event", topic, name: "alert.raised", seq, occurredAt, payload }` where `payload` is
  `{ alertId, userId, kind, refType, refId, sourceEventId }` — **no title and no patient identity**,
  so the bell must treat a frame as an INVALIDATE HINT and re-fetch `GET /alerts`, never render
  from the frame.

## 2026-08-21 — T4 opus gate (alerts consumer, routes, per-user topic) — for T5, T6 and the owner

Task T4 (commit `d13de0f32b344f6fe1f7a4d1dff231238053acfd`, HEAD=origin/main) verified **PASS**.
Full `pnpm verify` re-run BY THIS GATE, detached, exit VALUE **0** read from `/opt/hmis/.gate-verify.exit`
— apps/core 125 suites / 802 tests, apps/web 30 files / 144 tests, packages/contracts 3 suites / 7 tests.
`git show --stat d13de0f` = 12 paths, every one inside T4's Files list; no test deleted anywhere in the
diff. Three mutants were REBUILT INDEPENDENTLY by this gate (M-A4, M-A6, and one unprompted variant)
and all three died by an ASSERTION with a passing control. Six things the next tasks and the owner need.

### 1. The T4 coder's plan-defect report (worker wiring) is CONFIRMED CORRECT by this gate, and it is still an OWNER CALL.

Independently verified against the server tree at `d13de0f`:
- The plan's File Structure DOES grant T4 `apps/core/src/kernel/worker/worker.module.ts`
  (`T2 · T4 (alerts manifest + consumer — amendment 6)`); T4's COMPILED brief's generated frozen block
  lists 12 paths for T4 and that is not one of them. The contradiction is real.
- `worker.module.ts:51-58` installs seven manifests and carries the placeholder comment
  `// T4 (amendment 6) adds: registry.install(alertsManifest);` — alertsManifest is NOT installed.
- **The consumers map is at `worker.ts:26`** — `registerAllJobs(scheduler, db, registry, {})` with the
  matching comment at `:25`. `worker.ts` is T2's row in the plan's OWN File Structure, so it is frozen
  to T4 under the plan as well as the brief.
- `jobs.ts:36-45` throws on a declared subscription with no handler. So installing `alertsManifest` in
  `worker.module.ts` WITHOUT the handler in `worker.ts` would ship a worker that **throws at boot**.
  Amendment 6 is therefore not merely mis-routed to a frozen path — it is INCOMPLETE.

Net effect on `main` today: the API process installs the manifest (harmless, nothing there builds a
subscription bus), the worker does not, so the worker dispatches `escalation.triggered` **to nobody**.
Every T4 mechanism is built, tested and green; the last wire is missing and no remaining task in this
pipeline may add it. **Needs one commit touching two of T2's files, or a one-line plan amendment
granting them to T6.**

**T6: your `worker-runtime.e2e.test.ts` will observe ZERO alerts if it boots the real `WorkerModule`.**
Build the bus explicitly instead — `buildSubscriptionBus(registry, { "kernel.alerts": alertsConsumer(db) })`
then `runDispatchCycle(db, bus, { now })` — which is exactly what `consumer.test.ts` does and passes.

### 2. `POST /alerts/:id/read` returns **201**, and the coder's stated REASON for that is factually wrong. T5 must code against 201; the owner may want 200.

The route returns Nest's POST default **201** (both on the won update and on the repeat no-op). D6's
prose says *"a repeat is a 200 no-op"*. The T4 report justifies 201 with *"Nest returns 201 for POST by
default and the repo adds no override anywhere … changing the framework default would have been a new
pattern."* **The second half is false.** `@HttpCode` is an established pattern in this repo with several
specimens, and two of them are exactly this case:
- `apps/core/src/modules/patients/patients.controller.ts:164` — `@HttpCode(200) // a failed scan is a
  domain answer (ok:false), not a transport error — never 4xx, and **never Nest's POST-default 201**`
- `apps/core/src/modules/opd/opd-queue.controller.ts:211` — same override, same reasoning
- `apps/core/src/kernel/auth/auth.controller.ts:69,87,97,129` — `@HttpCode(204)`

This is NOT a T4 criterion failure: neither the brief's acceptance criteria nor Assertion Book row L12
names a success status for mark-read, and L12's own assertions (404-not-403, read_at, exactly one
`alert.read`) are all satisfied. It is a wire-contract detail that only the owner can settle.
**Until it is settled: `POST /alerts/:id/read` is 201. T5's bell must not assert 200.**

### 3. Mutants this gate rebuilt itself — all three DIED by an assertion, never by typecheck or timeout.

- **M-A4** (`authorize` check dropped from `subscribe` — chosen as the LEAST VISIBLE survival in the set:
  any authenticated user could subscribe to any other human's alerts topic and nothing would error).
  Rebuilt as a copy of `gateway.ts` with one line changed, injected via
  `.overrideProvider(RealtimeGateway).useClass(mutant)` over the real `AppModule`.
  DIED in **1170 ms**: `- "code": "forbidden_topic" / - "type": "error"` vs `+ "type": "subscribed"`.
  Byte-identical control repointed at `./gateway` **PASSED** (1525 ms). `Tests: 1 failed, 1 total`.
- **M-A6** (ownership predicate dropped from the conditional UPDATE). DIED in **432 ms**:
  `- "threw unknown_alert 01M0J1HN311H6Q5YRSMMQNH41B"` vs `+ "resolved alreadyRead=false"`.
  Control **PASSED** (400 ms).
- **M-A5b (UNPROMPTED, and it closes a hole nobody named).** The Book's M-A5 drops the `user_id` filter
  from the ITEMS query only; `listAlerts` runs a SECOND query for `unreadCount` and no Book row names it.
  Dropping the `user_id` filter from the COUNT alone **DIED** on L11's own fixture:
  `Expected: 1 / Received: 2`. Control **PASSED**. So L11's fixture discriminates both queries — no gap.

### 4. The T4 coder's M-A1b equivalent-mutant disclosure is CORROBORATED — do not "strengthen" it.

Checked against `schema/alerts.ts`: the only unique constraints this insert can violate are the `id`
PRIMARY KEY (a fresh ULID every call, so uncollidable) and `alerts_source_event_user_ux`. A targetless
`.onConflictDoNothing()` is therefore observationally identical to the targeted form. The survival is a
property of the schema, not a gap in the assertion. The shipped code keeps the explicit target because
it documents the idempotency unit.

### 5. `space.permission!` — a non-null assertion now sits on the gateway's permission path.

`gateway.ts:187` reads `await hasPermission(this.db, st.userId, space.permission!, "hospital")`. What
makes the `!` safe is the exactly-one invariant enforced one function away in `registerTopicSpace`
(`:76-85`), not anything local. It is correct today and asserted (the new gateway test proves both
legitimate shapes register and both illegitimate ones throw). Flagged so that anyone who later relaxes
`registerTopicSpace` knows that `!` is what they are relaxing.

### 6. Two small latent facts, neither in scope for this pipeline.

- **`alert.read` is not in `ALERTS_REALTIME_NAMES`**, so read-state does not fan out over WS. A user with
  two tabs open will not see the badge clear in the other tab until the poll. D6 only requires the tail
  to fan `alert.raised`, so this is by design today — but T5's bell should not assume otherwise.
- **`alert.raised` carries a NULL envelope `patientId` deliberately** (asserted in `consumer.test.ts`
  L8). Note the WS frame never carried the envelope `patientId` anyway (`gateway.ts:204` sends only
  `{type, topic, name, seq, occurredAt, payload}`), so this is belt-and-braces. The cost: a patient-scoped
  events query will not surface `alert.raised` rows; the audit link is `causationId` → the escalation.
