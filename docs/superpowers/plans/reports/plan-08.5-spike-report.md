# Plan 08.5 spike report — the runtime loop's four unknowns, plus one harness probe

**Transcribed verbatim** by the main session from the spike agent's final message, 2026-08-21.
Brief: [`../2026-08-21-phase1-08.5-spike-brief.md`](../2026-08-21-phase1-08.5-spike-brief.md).
Dispatched at `613d2c6`; ~158k agent tokens, 66 tool calls, ~26 min wall clock.

**Tripwire-21 check by the main session before acceptance:** every verdict below rests on a claim
the agent EXECUTED, and the two things it could not execute are labelled as such by the agent
itself — pg-boss@11's CJS loadability (registry metadata only, never installed or run) and
question E's fallback (not needed, so not measured). No verdict rests on a prediction. Accepted.

**What it resolves:** FORK-A (the worker's boot shape) · FORK-B (the scheduler) · the look-back
constant for D4 · flag ③'s fake-`Date` mechanism · flag ⑦'s reproduction · flag ①'s boot-and-close
· flag ②'s advisory lock · question D's seam. The resulting verdicts are recorded in the plan's
**Spike verdicts (2026-08-21)** block, which is what the pipeline compiles against.

---

# SPIKE REPORT — Plan 08.5 (the runtime loop), questions A–E

**Branch:** `spike/08.5-runtime-loop`, final SHA **`cfc763690e0e65b0f1e1d5c0ad035cfd83285a08`** (`cfc7636`), one commit ahead of `origin/main`, **not pushed**, left in place on the host.
**`main` untouched:** `git rev-parse main origin/main` → both `613d2c644d37877c9e60fc47ff32f77d5701fd76`; `git diff --stat main origin/main` empty; host checkout returned to `main`, `git status --porcelain` empty.
**`.env` restored:** `TEST_DATABASE_URL=postgres://hmis:hmis@localhost:5433/hmis_test`, `diff apps/core/.env apps/core/.env.spike-orig` produced no output (`ENV_RESTORED_IDENTICAL`) before the backup was deleted.
**No `pnpm db:generate`, no drizzle migration generated or applied.** No writes to `/tmp`. Server scratch (`.spike*.log/.exit`, `.pgboss-add.*`, `.pkg.orig`, `.lock.orig`, `.restore.*`) deleted with `rm -f`; `find /opt/hmis -maxdepth 1 -name ".spike*" -o -name ".pgboss*" -o -name "*.orig"` returns nothing.
**Concurrency (rule 20):** `pgrep -af jest` run before every timed/concurrent measurement. Every match was the probe's own `bash -c` line (its command text contains the literal string); in the one invocation where I obfuscated the pattern as `"j""est"` there were **zero** matches. **No interference observed.**

**Files on the branch** (all scratch, nothing merged):
`apps/core/src/worker.module.spike.ts`, `worker.spike.ts`, `worker-appmodule.spike.ts`, `pgboss.spike.ts`, `pgboss-cron.spike.ts`; `apps/core/test/spike/{a-context,b1-pgboss,b2-advisory,c-window,c4-rate,e-faketimers}.test.ts`; `apps/core/package.json` + `pnpm-lock.yaml` (pg-boss `^12.27.0`).

---

## Question A — a Nest application context without HTTP

### VERDICT (FORK-A): **A1 wins. `createApplicationContext(WorkerModule)` boots, resolves `DB`, runs `runDueTimers`, and closes cleanly. `AppModule` as an application context DIES at boot exactly as predicted. WorkerModule ships.**

### What I ran
- `apps/core/test/spike/a-context.test.ts` under ts-jest (authoritative — decorator metadata present):
  `pnpm --filter @hmis/core exec jest --passWithNoTests --runInBand test/spike/a-context.test.ts …` → **`PASS test/spike/a-context.test.ts`**, 2 tests passed.
- `apps/core/src/worker.spike.ts` and `worker-appmodule.spike.ts` as real detached processes under `tsx` (`pnpm exec tsx src/worker.spike.ts`, exit file value **`0`**; `… src/worker-appmodule.spike.ts`, exit file value **`1`**).

### A1 measured (ts-jest run, verbatim)
```
A1(jest) boot ok in 15ms
A1(jest) CONFIG.databaseUrl=postgres://hmis:hmis@localhost:5433/hmis_spike85_1
A1(jest) MODULE_REGISTRY keys=["auth","workflow","approvals","patients","tariff","opd","billing"]
A1(jest) select 1 => [{"one":1}]
A1(jest) runDueTimers => 0
[A1] WorkerModule.onModuleDestroy -> pool.end()
A1(jest) after close x2, pool: Cannot use a pool after calling end on the pool
A1(jest) unhandledRejections so far = 0
```

### A1 measured (real process under `tsx`, verbatim)
```
[A1] createApplicationContext(WorkerModule) OK in 20ms
[A1] CONFIG resolved: databaseUrl=postgres://hmis:hmis@localhost:5433/hmis_spike85_1 port=3000
[A1] DB resolved=true DB_POOL resolved=true
[A1] MODULE_REGISTRY keys = ["auth","workflow","approvals","patients","tariff","opd","billing"]
[A1] registry.subscriptionsFor('workflow.timer.fired') = []
[A1] DB query through resolved DB: [{"one":1}]
[A1] runDueTimers(db, now) = 0
[A1] enableShutdownHooks() returned
[A1] WorkerModule.onModuleDestroy -> pool.end()
[A1] app.close() resolved in 3ms
[A1] second app.close() resolved (double-close safe)
[A1] pool.query after close() rejected: Cannot use a pool after calling end on the pool
[A1] active handles after close = 1
[A1] main() reached the end WITHOUT calling process.exit()
[A1] DONE ok
[A1] process 'exit' event, code=0
```

### The exact provider list WorkerModule needed
Five providers, **no `imports` array at all**, no controllers, no `RealtimeModule`:

1. `{ provide: CONFIG, useFactory: () => loadConfig() }`
2. `{ provide: DB_BUNDLE, useFactory: (cfg: AppConfig) => createDb(cfg.databaseUrl), inject: [CONFIG] }` — `DB_BUNDLE` is a module-local `Symbol("DB_BUNDLE")`; `app.module.ts`'s copy is **not exported**, so the worker module must declare its own.
3. `{ provide: DB, useFactory: (b: DbBundle) => b.db, inject: [DB_BUNDLE] }`
4. `{ provide: DB_POOL, useFactory: (b: DbBundle) => b.pool, inject: [DB_BUNDLE] }`
5. `{ provide: MODULE_REGISTRY, useFactory: () => … }` installing the same seven manifests in the same order: `authManifest, workflowManifest, approvalsManifest, patientsManifest, tariffManifest, opdManifest, billingManifest`.

Plus `exports: [DB, DB_POOL, CONFIG, MODULE_REGISTRY]` and the class body copied from `AppModule`: `implements OnModuleDestroy`, `constructor(@Inject(DB_POOL) private readonly pool: Pool)`, a `poolClosed` boolean guard, `await this.pool.end()`. `@Global()` was kept for parity but is a no-op with no child modules.
`runDueTimers` was imported directly from `./kernel/workflow/timers` and called with the resolved `DB` — no provider needed for it.

### A2 — the error text, VERBATIM
Under ts-jest (correct decorator metadata — this is the authoritative A2 result):
```
A2(jest) THREW name=TypeError
A2(jest) THREW message=Cannot read properties of null (reading 'getHttpServer')
A2(jest) THREW stack=
TypeError: Cannot read properties of null (reading 'getHttpServer')
    at RealtimeGateway.onApplicationBootstrap (/opt/hmis/apps/core/src/kernel/realtime/gateway.ts:71:49)
    at MapIterator.iteratee (…/@nestjs/core/hooks/on-app-bootstrap.hook.js:22:43)
    …
A2(jest) unhandledRejections total = 0
```
Exactly the predicted failure, at exactly `gateway.ts:71`. Note the precise shape: `adapterHost.httpAdapter` is **`null`**, not undefined — `HttpAdapterHost` is provided in a context, it just holds no adapter. It never booted, so the "did the tail start" branch was never reachable; the tail and WS server are structurally impossible in this shape.

### Surprises worth carrying into T2
1. **`enableShutdownHooks()` / `close()` ordering held no surprise for the worker — because the hazard does not exist there.** `app.close()` ran `WorkerModule.onModuleDestroy` → `pool.end()` and resolved in **3 ms**; a second `close()` is safe via the `poolClosed` flag; `pool.query()` afterwards rejects with `Cannot use a pool after calling end on the pool`. The tail-vs-pool race that `gateway.ts:78-88` documents (leaf `onModuleDestroy` must stop the 300 ms tail before the root ends the pool) has **no analogue in WorkerModule**: there is no child module and no interval. Zero unhandled rejections in both the jest run and the real process; the process exited **code 0** on its own with 1 active handle (stdout) and no `process.exit()` call.
2. **A `tsx`-hosted worker only works because WorkerModule injects by TOKEN.** The same `AppModule` boot under `tsx` failed *earlier and differently* — at `onModuleInit`, not `onApplicationBootstrap`:
```
[A2] error.name    = TypeError
[A2] error.message = Cannot read properties of undefined (reading 'registerTopicSpace')
    at OpdRealtimeRegistrar.onModuleInit (/opt/hmis/apps/core/src/modules/opd/opd.module.ts:19:52)
```
`OpdRealtimeRegistrar` uses class-typed constructor injection (`constructor(private readonly gateway: RealtimeGateway)`), and esbuild (tsx's transformer) does not emit `design:paramtypes`, so Nest injected `undefined`. Under ts-jest the same class resolved fine. **Implication for T2's `start:worker`:** `tsx src/worker.ts` is safe *only* while every worker provider is token-injected (`@Inject(...)`); the first class-typed constructor injection added to the worker graph will silently inject `undefined`. **Incidental, not measured:** the repo's existing `start:dev` (`tsx watch src/main.ts`) boots this same `OpdRealtimeRegistrar` — I did not run it, so I make no claim about it, but it is worth someone checking.

---

## Question B — the scheduler fork

### VERDICT (FORK-B): **Take the advisory-lock interval loop, unconditionally. The decision rule fires on (iv): `pg-boss@12.27.0` is ESM-only and the shipped jest harness cannot load it at all — the suite fails before a single test runs. Independently, pg-boss cron was measured to be minute-granular in practice even when given a seconds cron.**

### B1(iv) — the decision rule, EXECUTED

`pnpm --filter @hmis/core add pg-boss` → **`pg-boss@12.27.0`** (`"type": "module"`, `engines.node >= 22.12.0`; host is `node v22.23.2`). Note the v12 API also changed: there is **no default export** — `import PgBoss from "pg-boss"` fails with `import_pg_boss.default is not a constructor`; it must be `import { PgBoss } from "pg-boss"`.

With **zero changes** to `jest.config.cjs` or `test/helpers/db.ts`:
`pnpm --filter @hmis/core exec jest --passWithNoTests --runInBand --detectOpenHandles test/spike/b1-pgboss.test.ts`, exit file value **`1`**:
```
FAIL test/spike/b1-pgboss.test.ts
  ● Test suite failed to run

    Jest encountered an unexpected token
    …
    /opt/hmis/node_modules/.pnpm/pg-boss@12.27.0/node_modules/pg-boss/dist/index.js:1
    ({"Object.<anonymous>":function(module,exports,require,__dirname,__filename,jest){import EventEmitter from 'node:events';
                                                                                      ^^^^^^

    SyntaxError: Cannot use import statement outside a module

      1 | // SPIKE 08.5 — question B1 (iv): …
    > 2 | import { PgBoss } from "pg-boss";
        | ^

Test Suites: 1 failed, 1 total
Tests:       0 total
```
Jest's own error text names the remedies as `transformIgnorePatterns` / ESM config / a custom `transform` — all `jest.config` changes. **Necessity of a jest.config change is proven by execution** (the unmodified harness cannot even parse the file). Whether any particular change would be *sufficient* is **not measured** — I did not attempt a fix, because the decision rule does not require one.

An earlier run of the same file also showed that ts-jest type-checks against pg-boss's `.d.ts` and rejected `boss.stop({ wait: true })` with `TS2353: 'wait' does not exist in type 'StopOptions'` even though the identical call succeeds at runtime under tsx — a second, independent harness-friction data point.

**Packaging metadata only, NOT measured against the harness:** `npm view pg-boss@11 type` → `commonjs`; `pg-boss@10` declares no `type` (i.e. CJS). A pinned `pg-boss@11.1.2` would therefore be CJS-loadable in principle. I did not install or run it, so this is a fact about the registry, not about this suite.

### B1(i)(ii)(iii) — measured outside jest, under `tsx` (`src/pgboss.spike.ts`, exit value `0`)

**(i) What `start()` creates, and where** — schema `pgboss` inside the **same database as the app** (`hmis_spike85_1`), created in **91 ms**:
```
[B1] BEFORE start(): current_database=hmis_spike85_1
[B1] BEFORE start(): pgboss tables=[]
[B1] start() #1 resolved in 91ms
[B1] AFTER start() #1: pgboss tables=["bam","job","job_common","job_dependency","queue","queue_stats","queue_stats_20260821","queue_stats_20260822","schedule","subscription","version","warning"]
[B1] AFTER start() #1: pgboss functions=["create_queue","delete_queue","job_table_format","job_table_run","job_table_run_async"]
[B1] AFTER start() #1: pgboss enum types=["job_state"]
```
Twelve tables, five functions, one enum — including **date-partitioned `queue_stats_YYYYMMDD` tables created ahead of time**, i.e. a second, self-managing migration system with its own daily partition maintenance living beside drizzle's.
(My `pg_namespace` filter `not like 'pg_%'` wrongly excluded `pgboss` because `_` is a LIKE wildcard; the `information_schema.tables` listing above is the authoritative evidence that the schema exists.)

**(ii) A second `start()` against the same database is clean** — both concurrent and sequential:
```
[B1] start() #2 (concurrent, same db) ok=true in 14ms
[B1] boss2 stopped
[B1] start() #3 (sequential, warm schema) ok=true in 13ms
```

**(iii) Fastest achievable recurrence**
```
[B1] cron sub-minute attempt: ACCEPTED a 6-field (seconds) cron
[B1] immediate send->work latencies(ms) = [504,298,96,391,187]
[B1] sendAfter chain fires=10 firstDelayMs=502 gapsMs=[1500,1501,1500,1503,1501,1500,1502,1501,1502]
[B1] cron fires=3 gapsMs=[55039,30021]
[B1] stop() resolved in 512ms
[B1] active handles after stop() = 0
```
And the decisive cron measurement (`src/pgboss-cron.spike.ts`, exit value `0`) — a **6-field seconds cron is accepted and stored, then fires once a minute anyway**:
```
[B1cron] getSchedules() = [{"name":"spike.cron6","key":"","cron":"*/1 * * * * *","timezone":"UTC","data":null,"options":{},…}]
[B1cron] 6-field '*/1 * * * * *' over 90s: fires=1 firstAt=+60049ms gapsMs=[]
```
So: cron cannot drive a 1–2 s job (1 fire per 90 s when asked for 90). The **only** way to a 1–2 s cadence is a `sendAfter` self-rescheduling chain, which delivered a steady **~1500 ms** period for a requested 1 s delay (the 0.5 s worker poll is added on top), and immediate `send()`→`work()` latency of **96–504 ms**. This confirms D2's premise by measurement: pg-boss would need a self-rescheduling singleton job for exactly the job that matters most, and it would still run ~1.5 s not 1.0 s.

### B2 — the loop's lock. **`PASS test/spike/b2-advisory.test.ts`, 3 tests passed.** Transcript, verbatim:
```
B2 server: PostgreSQL 16.14 (Debian 16.14-1.pgdg13+1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit
B2 hashtext = {"h1":1624230197,"h2":1624230197,"other":-1174515834,"typ":"integer"}
B2 pg_proc hashtext = [{"proname":"hashtext","result":"integer","nspname":"pg_catalog"}]
B2 A=true B=false loserWaitedMs=1
B2 pg_locks advisory = [{"locktype":"advisory","mode":"ExclusiveLock","granted":true,"objid":1624230197,"classid":0}]
B2 A.unlock=true then B=true A(again)=false
B2 gracefulEnd: A=true Bblocked=false BafterAclosed=true
B2 hardKill(pid=215230): A=true Bblocked=false BafterAkilled=true
```
- `hashtext` exists in `pg_catalog` in PostgreSQL 16.14, returns `integer` (int4), stable within the database for the same string (`h1 == h2 == 1624230197` for `job:runDispatchCycle`), and distinct for a different job name (`job:runDueTimers` → `-1174515834`).
- Exactly one session wins. The loser returns `false` and **does not wait** (measured **1 ms**, asserted `< 100`).
- The lock is `advisory` / `ExclusiveLock` / `granted`, `objid = 1624230197`, `classid = 0` — i.e. the single-argument bigint form, exactly one row.
- `pg_advisory_unlock` → `true`, and the lock hands over: B then wins, A then loses.
- Session-scoped both ways: after a graceful `client.end()` **and** after `pg_terminate_backend()`, the other session acquires. (The `pg_terminate_backend` leg needed a `client.on("error")` handler on the victim, otherwise pg's `57P01 terminating connection due to administrator command` surfaces as a jest "Unhandled error" — a harness detail for whoever writes any future kill test, not a fact about the lock.)

### FORK-B recommendation, one line
**Take the advisory-lock interval loop:** pg-boss@12 cannot be loaded by the unmodified jest harness (`SyntaxError: Cannot use import statement outside a module`), which fires the plan's binding decision rule, and even if it could, its cron is minute-granular (1 fire per 90 s for a `*/1 * * * * *` schedule) so the dispatch cycle would need a `sendAfter` chain running at ~1.5 s — while `pg_try_advisory_lock(hashtext(...))` is proven present, stable, non-blocking and session-scoped on this exact server.

---

## Question C — the out-of-order-commit skip (the centrepiece)

### VERDICT (flag ⑦): **REPRODUCED. `PASS test/spike/c-window.test.ts`, 3 tests passed. The assertion "N is never delivered" passes against the shipped dispatcher.**

### C1 — the reproduction. What I ran
`apps/core/test/spike/c-window.test.ts` (two raw `pg` `Client`s, not the pool; the shipped `runDispatchCycle` imported unmodified). Detached run, exit file value **`0`**.

Verbatim console:
```
C1 seqN=1 seqN1=2
C1 cycle1 delivered=1 deliveredSeqs=[2]
C1 cycle1 event_cursors row = [{"consumer":"spike.consumer","last_seq":"2","updated_at":"2026-08-21 07:14:05.431687+00"}]
C1 cycle2 delivered=0 cycle3 delivered=0
C1 final deliveredSeqs=[2]
C1 final event_cursors row = [{"consumer":"spike.consumer","last_seq":"2","updated_at":"2026-08-21 07:14:05.431687+00"}]
C1 rows actually in events = [{"seq":"1","name":"spike.evt"},{"seq":"2","name":"spike.evt"}]
```
Runner line:
```
  SPIKE C — out-of-order commit skip
    ✓ C1: an event whose seq was allocated early but committed late is NEVER delivered (350 ms)
```
- **Delivered-seq list: `[2]`.** Seq 1 was allocated first, committed last, and was **never** delivered — not on the cycle after its commit, not on the one after that.
- **`event_cursors` row, verbatim:** `{"consumer":"spike.consumer","last_seq":"2","updated_at":"2026-08-21 07:14:05.431687+00"}` — and note the `updated_at` is **identical** before and after A's commit, i.e. cycles 2 and 3 did not even touch the row.
- Both rows are physically present in `events` (`seq 1` and `seq 2`). The loss is purely the `seq > last_seq` frontier.

Assertions that passed: `expect(delivered).toEqual([N1])` and `expect(delivered).not.toContain(N)`.

### C — the measured seq gap (the look-back calibration)

Raw single-client inserts while a transaction stalls (`c-window.test.ts` C2):
```
C2(i)   stall=2000ms  singleRowCommits=2341   seqN=1 maxSeq=2342  GAP=2341
C2(ii)  bulkRows=10000 bulkMs=175             seqN=1 maxSeq=10001 GAP=10000
C2(iii) stall=10000ms singleRowCommits=12778  seqN=1 maxSeq=12779 GAP=12778
```
Through **the application's own write path** (`withTx` + `appendEvent`, `c4-rate.test.ts`, `PASS`), 2 s stall at three pool concurrencies:
```
C4 concurrency=1 stall=2000ms appendEventTxCommitted=939  seqN=1 maxSeq=940  GAP=939  rate=470/s
C4 concurrency=4 stall=2001ms appendEventTxCommitted=2288 seqN=1 maxSeq=2289 GAP=2288 rate=1143/s
C4 concurrency=8 stall=2002ms appendEventTxCommitted=2665 seqN=1 maxSeq=2665… GAP=2665 rate=1331/s
```

**What this means for the plan's default of 500.** Measured, not predicted:
- 500 seqs is **~1.06 s** of stall at the app-path rate with one writer (470/s), **~0.44 s** at four writers, **~0.38 s** at eight.
- A **single** `INSERT … generate_series(1,10000)` statement burns **10 000 seqs in 175 ms** — 20× the default window in a fifth of a second.
- A 10 s stalled transaction saw **12 778** seqs allocated past it.

**Recommendation (derived from the numbers above, offered as a recommendation, not a measurement):** 500 is not defensible — it protects against roughly half a second of transaction stall on this hardware. If the look-back stays a seq count, set the default to **≥ 5 000** (covers the measured 2 s worst case at concurrency 8 with ~2× margin and the 10 000-row bulk statement), and treat **~13 000** as what a 10 s stall costs. The structurally safe shape is the one D4 already anticipates for Plan 11: a **time-based floor** (`recorded_at >= now() - interval '…'`) rather than a seq count, since a seq count cannot bound an arbitrarily long transaction while a time floor can — and the `LEFT JOIN event_deliveries` keeps the *returned* row count small regardless of how wide the window is (the scanned count is the cost to watch).

### C — poison behaviour, one cycle transcript
```
C3 seqs=[1,2,3] cycles delivered=[0,0,0] handlerAttempts=3 successfullySeen=[]
C3 event_cursors row = [{"consumer":"poison.consumer","last_seq":"0"}]
    ✓ C3: poison — a handler that always throws holds its cursor forever and blocks later events (344 ms)
```
Three cycles, three handler invocations — **all three on seq 1**. `last_seq` never leaves `0`; seqs 2 and 3 are never delivered to that consumer. This is the shipped `break` at `dispatcher.ts:34` doing exactly what D4 says: one permanently failing event blocks its consumer forever.

---

## Question D — how the manifest `subscriptions` seam binds today

### VERDICT: **Nobody and nothing. The seam is declarative-only, and it is not merely unbound — it is EMPTY. T2's wiring test starts from zero in the strongest sense: the union of manifest declarations is the empty set.**

Grep evidence over the shipped tree (`apps/**`, `packages/**`, all `.ts`/`.tsx`), excluding my own spike files:

- `subscriptionsFor` — **3 hits, none in production code**: its definition at `apps/core/src/kernel/modules/loader.ts:26`, and two assertions in `apps/core/src/kernel/modules/loader.test.ts:31,32`. No caller anywhere else.
- `SubscriptionBus` — **defined** at `apps/core/src/kernel/events/subscriptions.ts:12`, **type-imported** by `apps/core/src/kernel/events/dispatcher.ts:3,7`, and **instantiated only** in `apps/core/src/kernel/events/dispatcher.test.ts:21,35,50`. Zero production instantiations.
- `runDispatchCycle` — **defined** at `dispatcher.ts:5`, **called only** from `dispatcher.test.ts:28,30,42,44,55`. The other four hits are prose in comments (`timers.ts:77`, `opd/appointments.ts:214`, `patients/guardians.ts:164`, `patients/merge.ts:87`) that all say the dispatcher is unscheduled until a later plan.
- `bus.on(...)` — the only calls are the four in `dispatcher.test.ts:22,36,51,52`.
- **Every one of the seven shipped manifests declares `subscriptions: []`**: `kernel/auth/manifest.ts:15`, `kernel/workflow/manifest.ts:17`, `kernel/approvals/manifest.ts:13`, `modules/patients/manifest.ts:14`, `modules/tariff/manifest.ts:10`, `modules/opd/manifest.ts:26` (`// no dispatcher consumers in this plan; realtime rides the gateway's tail`), `modules/billing/manifest.ts:29` (`// the dispatcher stays unscheduled until Plan 11; billing screens poll`).

Executed probe (the real registry, built by the real factory, in a booted context — `worker.spike.ts`):
```
[A1] MODULE_REGISTRY keys = ["auth","workflow","approvals","patients","tariff","opd","billing"]
[A1] registry.subscriptionsFor('workflow.timer.fired') = []
```

Flatly: `ModuleRegistry.install` records `{event, consumer, moduleKey}` into a map that **no production code ever reads**, and **nothing** joins a manifest declaration to a `SubscriptionBus` handler — there is no registration call, no factory, no decorator, no boot-time wiring. T2 must build that join from nothing, and its "worker's bus equals the union of manifest declarations" assertion is, at `613d2c6`, an assertion that `[] === []`; it only acquires teeth once the alerts manifest declares its first subscription.

---

## Question E — the T6 harness probe

### VERDICT (flag ③): **The mechanism works. `PASS test/spike/e-faketimers.test.ts`, 5 tests passed. `Date` is pinned, pg and supertest stay live, `setSystemTime` moves the pin. T6 takes the fake-timer branch, not the fallback.**

### The `doNotFake` list that works, VERBATIM
```ts
jest.useFakeTimers({
  doNotFake: [
    "hrtime", "nextTick", "performance", "queueMicrotask",
    "requestAnimationFrame", "cancelAnimationFrame",
    "requestIdleCallback", "cancelIdleCallback",
    "setImmediate", "clearImmediate",
    "setInterval", "clearInterval",
    "setTimeout", "clearTimeout",
  ],
  now: new Date("2026-03-11T07:30:00.000Z"),   // 13:00 IST
});
```
That is jest's complete fakeable-API set **minus `Date`**. Called in `beforeAll` **after** `app.init()`; `jest.useRealTimers()` in `afterAll` before `app.close()`.

### Measured, verbatim
```
E(i) new Date() = 2026-03-11T07:30:00.000Z Date.now() = 1773214200000
E(ii) pg round-trip ok in 203ms real wall time; row = [{"one":1,"server_now":"2026-08-21 07:17:02.272454+00","slept":false}]
E(iii) GET /health -> {"status":"ok","db":"ok"}; new Date() still 2026-03-11T07:30:00.000Z
E(iv) after setSystemTime, new Date() = 2026-03-11T18:16:00.000Z
E(v) real setTimeout(150) resolved after 149ms wall time
```
- **(i)** `new Date()` and `Date.now()` both return the pinned instant.
- **(ii)** A live `pg` query through `setupTestDb`'s pool completed — including a server-side `pg_sleep(0.2)`, which took **203 ms of real wall time**, proving the socket and its timers are unfaked. (`server_now` is Postgres's own clock, correctly *not* pinned — worth knowing for T6: the pin reaches JS `new Date()`, never `now()` inside SQL.)
- **(iii)** A supertest round-trip against the booted Nest app returned `{"status":"ok","db":"ok"}`, and the pin was still in force afterwards.
- **(iv)** `jest.setSystemTime(new Date("2026-03-11T18:16:00.000Z"))` — **23:46 IST, the bomb window** — moved the pin mid-test and moved back cleanly.
- **(v)** A real `setTimeout(150)` resolved after **149 ms** of wall time: timers are genuinely not faked, so nothing needs `jest.advanceTimersByTime`.

The fallback (arrange-via-service-calls with explicit `now`) is **not needed**; I did not measure it.

---

## Residue left behind, named

- **Database `hmis_spike85_1`** (12 MB) on `postgres://hmis:hmis@localhost:5433` — created by the suite's own `ensureWorkerDatabaseExists`, carrying the full drizzle schema **plus a `pgboss` schema** (12 tables incl. `queue_stats_20260821` / `queue_stats_20260822`, 5 functions, the `job_state` enum) installed by `PgBoss.start()`. Disclosed and acceptable per the brief; I created and dropped no database by hand.
- The base name `hmis_spike85` was never created (only the `_1` worker DB).
- **`hmis_test_1..7` were never touched** — `.env` pointed at `hmis_spike85` for the entire duration of every test run. Full database list at finish: `hmis_dev, hmis_spike85_1, hmis_test, hmis_test_1 … hmis_test_7, postgres`.
- Branch `spike/08.5-runtime-loop` @ `cfc7636`, local to the host, unpushed, left in place. The pg-boss dependency lives only on that branch; the host is checked out on `main` and `pnpm install --frozen-lockfile` confirmed `pg-boss NOT in apps/core/node_modules`.
- My local mirror `…/scratchpad/mirror-spike85-probe` is left alone per rule 22(f).
