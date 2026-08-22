# Plan 11c spike report — the L14 census shape, SMTP egress, and the Alertmanager smoke

**Run 2026-08-23 by the spike agent, from the execute session, before Phase 0 and before any brief is compiled.** Brief: [`PLAN-11C-SPIKE-BRIEF-2026-08-23.md`](./PLAN-11C-SPIKE-BRIEF-2026-08-23.md). Plan served: [`../2026-08-23-phase1-11c-operating-modes-downtime-kit.md`](../2026-08-23-phase1-11c-operating-modes-downtime-kit.md).

**Nothing was committed by this spike.** The build host's tree was left clean; the report text is the whole deliverable. (This file is committed by the execute session, per the brief's report-format clause.)

**Cost: 172,007 subagent tokens, 59 tool uses, 33 m 13 s wall clock** — against an ~80k target with an honest range to 200k. Inside the range; the ≥30 isolated runs plus the unrequested starvation control are where it went.

## 0. Host state, and the rule-20 interference statement

All evidence on `root@62.238.106.231:/opt/hmis`, at `349c73556aa4fc273df8e01fa0a61b2e4b49868e` throughout, with `git status --porcelain` empty before the first measurement and empty again after the last. Authoring in a per-agent mirror (`<SCRATCH>/mirror-spike11c`, rule 22(a)); every file reached the server by `scp` with `md5sum` confirmed on both sides before any run.

**Rule 20 — no interference was observed, and the probe was read as LINES, never as a count.** `pgrep -af jest` was run immediately before each of the three measurement batches. Every batch returned exactly one match, and in each case the matched line was *my own compound ssh shell*, whose command string contains the literal `pgrep -af jest` and therefore matches itself:

```
4125402 bash -c echo "--- rule 20 pre-measurement probe ---"; pgrep -af jest; echo "--- launching ---"; cd /opt/hmis && setsid nohup sh /opt/hmis/.spike11c-loop.sh stepwise 30 "invokes all nine jobs across a stepwise advance from a pinned instant" >/dev/null 2>&1 & sleep 2; echo LAUNCHED
```

The only other node processes on the box across the whole run were production's own (`node dist/src/main.js`, `node dist/src/worker.js`) and `node_exporter`. **No other agent's suite ran against this repo at any point during these measurements.** The final probe, after cleanup, returned no match at all.

Every long command ran detached under `setsid nohup` with its exit **VALUE** written to a file and read back (rules 16–18). Every isolation claim below is quoted from jest's own output, not inferred from an exit code (rule 19). The runs in each loop were **sequential, never concurrent** — two jest processes would collide on the `JEST_WORKER_ID`-derived database name, which is the very failure rule 20 exists to prevent.

---

## Question A — the L14 census restructure

### A.1 What ran

The restructured census was written into `apps/core/src/kernel/worker/scheduler.test.ts` in the mirror and synced (`md5 9993748cc6241b8a6f3c2739c9134ec6`, confirmed identical on the server). Then, via rule 19's script-bypassing invocation:

```sh
pnpm --filter @hmis/core exec jest --passWithNoTests \
  src/kernel/worker/scheduler.test.ts \
  -t "invokes all nine jobs across a stepwise advance from a pinned instant"
```

driven by a detached scratch loop that appended each run's exit **value** to a results file:

```sh
setsid nohup sh /opt/hmis/.spike11c-loop.sh stepwise 30 "<test name>" >/dev/null 2>&1 &
```

### A.2 Isolation, proven from OUTPUT

All 30 logs, aggregated:

```
=== isolation line count (expect 30) ===
     30 Tests:       5 skipped, 1 passed, 6 total
=== suite result lines ===
     30 Test Suites: 1 passed, 1 total
=== any FAIL? ===
0
```

One log verbatim (`run 7`):

```
  Scheduler
    ○ skipped starts and stops cleanly with no jobs registered
    ○ skipped appends sweep.failed when a job throws, and nothing per successful tick
    ○ skipped stop() awaits an in-flight run before resolving, and leaks no rejection
    ○ skipped no job STARTS after stop() resolves — a daily tick suspended on its heartbeat read finds the latch
    the registration census (L14)
      ✓ invokes all nine jobs across a stepwise advance from a pinned instant (2713 ms)
      ○ skipped a daily job that last succeeded earlier the same UTC day but a PREVIOUS IST day is due (M-S2)

Test Suites: 1 passed, 1 total
Tests:       5 skipped, 1 passed, 6 total
```

### A.3 The measured rate

**30/30 green.** All thirty exit values were `0`:

```
run=1 exit=0 … run=30 exit=0
LOOP_DONE label=stepwise n=30
```

### A.4 Runtime — the restructured shape against the shipped one

Jest's own per-test line, unpinned, on an otherwise idle 8-core host:

| shape | runs | per-test ms | median | mean |
|---|---|---|---|---|
| **shipped** (single 25 h `advanceTimersByTimeAsync`) | 3 | 2717 · 2744 · 2572 | **2717** | 2678 |
| **stepwise** (this report's shape) | 31 | 2651 … 2981 | **2735** | 2748 |

Whole-invocation wall clock (`pnpm exec jest`, dominated by ts-jest compile + `setupTestDb` migrations, not by the census): shipped **15.724 s**, stepwise **15.043 s**.

**Runtime is PARITY, not a reduction — reported plainly because the brief predicted a reduction.** The *daily ticks* did fall as predicted, by arithmetic from the span and the shipped 30 s grid: `25 h / 30 s = 3 000` ticks → `9 h 05 m / 30 s = 1 090` ticks, **−63.7 %**, and `isDailyDue` issues one real read per past-instant daily job per tick, so the real DB reads fall with them. What ate the saving is the settle: the walk spends ~1 140 real event-loop turns (≥1 ms apiece) yielding to those reads. §7.9's constraint was *"must not multiply the ~3 000 real DB reads"* — that is satisfied with room to spare, at equal wall clock. It is not the improvement the brief hoped for, and it is not a regression.

### A.5 The full file, beside the edit

```sh
pnpm --filter @hmis/core exec jest --passWithNoTests src/kernel/worker/scheduler.test.ts
```
exit value `0`:

```
PASS src/kernel/worker/scheduler.test.ts (11.151 s)
  Scheduler
    ✓ starts and stops cleanly with no jobs registered (354 ms)
    ✓ appends sweep.failed when a job throws, and nothing per successful tick (378 ms)
    ✓ stop() awaits an in-flight run before resolving, and leaks no rejection (388 ms)
    ✓ no job STARTS after stop() resolves — a daily tick suspended on its heartbeat read finds the latch (1483 ms)
    the registration census (L14)
      ✓ invokes all nine jobs across a stepwise advance from a pinned instant (2683 ms)
      ✓ a daily job that last succeeded earlier the same UTC day but a PREVIOUS IST day is due (M-S2) (379 ms)

Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
```

**M-S2's grave passes beside it, untouched** — the brief's expectation that only the first L14 test would need restructuring is confirmed: the second's structure is not affected and its body is byte-identical to `HEAD`.

### A.6 Typecheck and lint — not asked for, run anyway, because R0-2 ships this diff

With the edit in place, the repo's own scripts (rule 5: never bare `tsc`), detached, exit values read from files:

```
=== typecheck exit ===   0      > hmis@ typecheck /opt/hmis   > pnpm -r exec tsc --noEmit
=== lint exit ===        0      > hmis@ lint /opt/hmis        > eslint .
```

### A.7 THE HONESTY NOTE — and it is stronger than the brief anticipated

The brief required: *the build host is not the starved CI container, so 30/30 here does not PROVE 0 % on CI.* That stands. **But I ran the control the brief did not require, and it says something sharper: this host could not reproduce the failure mode AT ALL, in either shape.**

Ten runs of each shape pinned to a single CPU (`taskset -c 0` — a starvation proxy that adds no load, so production on the other seven cores was untouched):

| shape, `taskset -c 0` | greens | per-test ms (min–max) | mean |
|---|---|---|---|
| **stepwise** | **10/10** | 3029–3189 | 3103 |
| **shipped** | **10/10** | 2854–3354 | 3118 |

So the shipped shape is *also* 10/10 green here under one-CPU pinning — consistent with gate report §3a, which already found the build host green at both of the commits CI failed on. **The 30/30 is therefore a demonstration of determinism, not a discrimination between the two shapes.** No measurement available on this host distinguishes them; §3a's CI observation (~16 % red per run, red twice consecutively) remains the only evidence the failure exists, and the post-ship CI observation window is the real confirmation. The Pipeline Notes already treat any post-R0-2 census red as a regression signal, and that clause is now load-bearing rather than belt-and-braces.

What the spike *can* claim, and does: the stepwise shape is green 30/30 unpinned and 10/10 starved, it holds every assertion, it costs no extra runtime, it cuts the daily ticks by 64 %, and its failure mechanism is closed by construction — every `isDailyDue` a window opens is given real event-loop turns to resolve before the clock leaves the window, and `stop()` is not called until after the last settle.

### A.8 Verdict

**D12's shape is RESOLVED AS WRITTEN in direction and R0-2 may ship the diff below — with two amendments the execute session must write into D12 in place, because the measured shape is not literally what D12 described.**

1. **D12 says "each step followed by a bounded number of tick-sized advances with settle room" and does not say what settle room IS under fully-faked timers.** It cannot be `setTimeout`/`setImmediate`/`queueMicrotask` — the census fakes all of them. The measured shape captures the real `setTimeout` at module load (`const realSetTimeout = setTimeout;`) and adds a `settleRealTurns(n)` helper that yields *n* genuine event-loop turns. This is the load-bearing part of the fix and D12 should name it.
2. **The span shrank 25 h → 9 h 05 m, which D12 did not state.** It is what makes the tick count fall. Justification, and it is arithmetic: the five daily instants all fall within 7 h 45 m of the pin, and the longest cadence in `CENSUS_INTERVALS` is `workerTempRolesIntervalMs` at 9 h. **This creates one new obligation on T3**, which adds a tenth `every` job and a `workerInterfaceSweepIntervalMs` key to `CENSUS_INTERVALS`: its census value must be **under 9 h 05 m** or the job never fires. The failure is loud (the set-equality assertion goes red naming the missing job), not silent — that is the only reason a bare constant is acceptable here rather than a computed maximum — but T3's brief should carry the sentence.

Also amended by the diff, and worth one line in the plan: **the test's NAME changes** (`…within a faked 25 hours advanced from a pinned instant` → `…across a stepwise advance from a pinned instant`). Grepped: no parity test, no other suite, and no CI config pins the old name; the only other occurrences are historical pipeline briefs under `docs/`.

Assertions held exactly as required: `scheduler.jobs()` equals `THE_NINE`, the invoked SET equals `THE_NINE`, `leakedErrors()` empty, `CENSUS_INTERVALS` unchanged, `CENSUS_DAILY_TICK_MS` still `30_000` (§7.9 not relitigated), and the `DATABASE_URL`-unset guard at the shipped `:269-277` untouched — the diff has no hunk there and `expect(process.env.DATABASE_URL).toBeUndefined()` is carried through as context.

No mutants were built: Book R2 is a measurement row, not a mutant row (§3 ROUTINE, and the brief says so).

### A.9 The verbatim final test shape

`git diff` taken on the build host with the edit in place, before revert:

```diff
diff --git a/apps/core/src/kernel/worker/scheduler.test.ts b/apps/core/src/kernel/worker/scheduler.test.ts
index 0d6bac9..60d17d8 100644
--- a/apps/core/src/kernel/worker/scheduler.test.ts
+++ b/apps/core/src/kernel/worker/scheduler.test.ts
@@ -53,6 +53,34 @@ function pinDateOnly(now: Date): void {
   });
 }
 
+/**
+ * A HANDLE TO THE REAL EVENT LOOP, captured at module load while the timers are still real.
+ * The L14 census below fakes EVERY timer — it has to, compressing hours of fake clock is the
+ * whole technique — which leaves it no way to yield actual wall-clock time to the REAL database
+ * round-trips its own ticks are waiting on: `setTimeout`, `setImmediate` and `queueMicrotask`
+ * all belong to the fake clock by then. This reference does not.
+ */
+const realSetTimeout = setTimeout;
+
+/**
+ * Yields `turns` REAL event-loop turns — timers phase, then poll phase, `turns` times over, at
+ * ≥1 ms apiece because node clamps a 0 ms timeout to 1 ms. The poll phase is the point: it is
+ * where `pg`'s socket data actually arrives, so an outstanding `isDailyDue` read — and the
+ * heartbeat writes of whatever run it starts — can finish while fake time stands still.
+ *
+ * A FIXED COUNT rather than a real-time budget, deliberately: on a starved container each turn
+ * takes LONGER, so the same count buys proportionally more real time exactly where more of it is
+ * needed. It is a sequencing wait, not a timing assertion (Global Constraint 10) — it asserts
+ * nothing and cannot fail; a census that settles and still comes back short fails on its SET.
+ */
+async function settleRealTurns(turns: number): Promise<void> {
+  for (let i = 0; i < turns; i += 1) {
+    await new Promise<void>((resolve) => {
+      realSetTimeout(() => { resolve(); }, 0);
+    });
+  }
+}
+
 /**
  * A dedicated connection to the SAME per-worker test database `setupTestDb()` already
  * migrated, but with `idleTimeoutMillis: 0`. The L14 census test below fakes ALL timers
@@ -276,20 +304,112 @@ describe("Scheduler", () => {
       else process.env.DATABASE_URL = savedDatabaseUrl;
     });
 
-    it("invokes all nine jobs within a faked 25 hours advanced from a pinned instant", async () => {
+    // ── Plan 11c R0-2 / D12: THE ADVANCE IS WALKED, NOT JUMPED ────────────────────────────
+    //
+    // Gate report §3a measured this test red on ~16% of CI runs — and red TWICE CONSECUTIVELY,
+    // so one re-run was never a clearing procedure — always with an empty or partial `invoked`
+    // set. §7.9 refused the obvious fix, a finer `CENSUS_DAILY_TICK_MS`, and it stays refused:
+    // `runDailyClose`'s window is ONE IST minute, the 30 s grid above samples it exactly twice
+    // (the finding beside that constant), and a 5 s grid would multiply the REAL database reads
+    // sixfold on the container that is already too slow to keep up.
+    //
+    // THE FAILURE IS A QUEUE, NOT A SAMPLE. A single `advanceTimersByTimeAsync(25 h)` fires
+    // ~3 000 daily ticks back to back with one event-loop turn between them, and every tick
+    // awaits a real heartbeat read for each daily job whose IST instant has already passed —
+    // three of the five nearly always, since guardians' 00:05 window alone is open ~23.9 h of
+    // every day. That is ~9 000 queries queued against a ten-client pool while fake time races
+    // to the end of the sweep. `stop()` then latches `stopped` with the reads issued INSIDE the
+    // one-minute window still in that queue, and `dailyTick`'s post-await re-check
+    // (`scheduler.ts:193-199`) drops the runs they would have started. That re-check is
+    // CORRECT — it is what stops a job starting against a pool the caller is about to end, and
+    // the test at the bottom of this file exists to keep it. A fast box drains the queue before
+    // `stop()`; a starved one does not, and the set comes back short.
+    //
+    // So the advance is WALKED: hour-sized chunks, each followed by real event-loop turns, keep
+    // the queue shallow instead of letting 9 000 reads pile up behind fake time; and each of the
+    // five daily instants is ARRIVED AT — one second past it, so the tick that lands ON the
+    // instant has fired — then crossed in tick-sized advances, every one of them settled. Every
+    // `isDailyDue` an open window issues has resolved, and every run it starts has reached its
+    // spy, before the clock leaves that window and long before `stop()` is called.
+    //
+    // AND THE SPAN SHRANK, 25 h → 9 h 05 m, which is the runtime half of §7.9's trade: the five
+    // daily instants all fall within 7 h 45 m of the pin (below) and the longest cadence in
+    // `CENSUS_INTERVALS` is `workerTempRolesIntervalMs` at 9 h, so 9 h 05 m is the entire span
+    // this census has ever needed. The old 25 h was sized to "cross an IST day boundary" without
+    // computing where the boundary actually is (18:30 UTC, 6 h 30 m in). ~1 090 daily ticks
+    // instead of ~3 000. **A FUTURE `every` JOB CENSUSED AT A CADENCE LONGER THAN THIS SPAN WILL
+    // NEVER FIRE** — and the set-equality assertion below then goes red naming it, which is the
+    // only reason a bare constant is safe here rather than a computed maximum.
+
+    const MINUTE_MS = 60_000;
+    const HOUR_MS = 60 * MINUTE_MS;
+
+    /** 2026-08-21T12:00:00Z is 17:30 IST on 2026-08-21 — the pin every offset below counts from. */
+    const CENSUS_PIN = new Date("2026-08-21T12:00:00.000Z");
+
+    /**
+     * The five daily instants as offsets from the pin, ASCENDING — one per `dailyIst`
+     * registration in `jobs.ts:20-31`, and this list is a transcription of those constants, not
+     * a fixture. Three of them (00:05, 00:15, 01:15 IST) are already `pastInstant` at 17:30 IST
+     * with no heartbeat, so they fire on the very first tick and fire AGAIN once IST rolls over
+     * at 18:30 UTC; the walk visits them regardless, so the list stays a transcription of the
+     * registrations rather than a record of which ones today's pin happens to make interesting.
+     */
+    const DAILY_INSTANTS_MS = [
+      6 * HOUR_MS + 25 * MINUTE_MS, // 18:25Z = 23:55 IST 08-21 · sweepAppointmentNoShows (5-min window)
+      6 * HOUR_MS + 29 * MINUTE_MS, // 18:29Z = 23:59 IST 08-21 · runDailyClose (ONE-minute window — the flake)
+      6 * HOUR_MS + 35 * MINUTE_MS, // 18:35Z = 00:05 IST 08-22 · sweepGuardianMajority
+      6 * HOUR_MS + 45 * MINUTE_MS, // 18:45Z = 00:15 IST 08-22 · createEventPartitions
+      7 * HOUR_MS + 45 * MINUTE_MS, // 19:45Z = 01:15 IST 08-22 · retentionSweep
+    ];
+
+    /** Total fake time advanced: past the last daily instant AND past the 9 h longest cadence. */
+    const CENSUS_SPAN_MS = 9 * HOUR_MS + 5 * MINUTE_MS;
+    /** The largest single advance taken anywhere — the queue-depth bound. */
+    const WALK_CHUNK_MS = HOUR_MS;
+    /** Tick-sized advances taken at each instant after arriving just past it. */
+    const TICKS_PER_INSTANT = 3;
+    /** Real turns after an ordinary walk chunk: queue control, nothing is due. */
+    const WALK_SETTLE_TURNS = 10;
+    /** Real turns at an instant, where a window is open and a run must reach its spy. */
+    const INSTANT_SETTLE_TURNS = 50;
+
+    it("invokes all nine jobs across a stepwise advance from a pinned instant", async () => {
       expect(process.env.DATABASE_URL).toBeUndefined(); // CI's environment, reproduced here
       const invoked: string[] = [];
       const spies = spyOnTheNine(invoked);
       const registry = censusRegistry();
       const fresh = freshWorkerDb();
-      jest.useFakeTimers({ now: new Date("2026-08-21T12:00:00.000Z") });
+      jest.useFakeTimers({ now: CENSUS_PIN });
       try {
         const scheduler = new Scheduler(fresh.db, fresh.pool, stubLocks(), CENSUS_DAILY_TICK_MS);
         registerAllJobs(scheduler, fresh.db, registry, {}, CENSUS_INTERVALS);
         expect(scheduler.jobs()).toEqual(THE_NINE);
 
+        // Fake milliseconds advanced so far, measured from the pin. The walk only moves forward,
+        // so a target already behind the cursor is a no-op rather than a rewind.
+        let cursorMs = 0;
+        const walkTo = async (targetMs: number): Promise<void> => {
+          while (cursorMs < targetMs) {
+            const step = Math.min(WALK_CHUNK_MS, targetMs - cursorMs);
+            await jest.advanceTimersByTimeAsync(step);
+            cursorMs += step;
+            await settleRealTurns(WALK_SETTLE_TURNS);
+          }
+        };
+
         scheduler.start();
-        await jest.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
+        for (const instantMs of DAILY_INSTANTS_MS) {
+          await walkTo(instantMs + 1_000); // one second PAST it: the tick landing on the instant has fired
+          await settleRealTurns(INSTANT_SETTLE_TURNS);
+          for (let i = 0; i < TICKS_PER_INSTANT; i += 1) {
+            await jest.advanceTimersByTimeAsync(CENSUS_DAILY_TICK_MS);
+            cursorMs += CENSUS_DAILY_TICK_MS;
+            await settleRealTurns(INSTANT_SETTLE_TURNS);
+          }
+        }
+        await walkTo(CENSUS_SPAN_MS); // the tail — nothing daily is left, the interval cadences need it
+        await settleRealTurns(INSTANT_SETTLE_TURNS);
         await scheduler.stop();
 
         expect(new Set(invoked)).toEqual(new Set(THE_NINE));
```

---

## Question B — SMTP submission egress

### B.1 What ran

The brief's two credential-free probes, plus disambiguation after 465 produced no output at all. **One correction disclosed:** my first outlook:465 probe was piped into `head` and I read `RC=0` — that was `head`'s status, rule 16's exact trap. Every probe below is **unpiped**.

```sh
timeout 10 openssl s_client -starttls smtp -connect smtp.gmail.com:587 -brief </dev/null
timeout 12 openssl s_client -4 -connect smtp.gmail.com:465 -brief </dev/null
timeout 12 openssl s_client -4 -connect smtp-mail.outlook.com:465 -brief </dev/null
timeout 10 openssl s_client -4 -starttls smtp -connect smtp-mail.outlook.com:587 -brief </dev/null
timeout 8 bash -c "exec 3<>/dev/tcp/64.233.164.109/465 && echo TCP_OPEN"   # smtp.gmail.com A record
timeout 8 bash -c "exec 3<>/dev/tcp/64.233.164.109/587 && echo TCP_OPEN"
timeout 8 bash -c "exec 3<>/dev/tcp/173.194.76.108/25  && echo TCP25_OPEN"  # context only
```

### B.2 Observed

**587 — open, STARTTLS establishes.** `smtp.gmail.com:587`:

```
Connecting to 2a00:1450:4010:c01::6c
CONNECTION ESTABLISHED
Protocol version: TLSv1.3
Ciphersuite: TLS_AES_256_GCM_SHA384
Peer certificate: CN=smtp.gmail.com
Verification: OK
Negotiated TLS1.3 group: X25519MLKEM768
250 SMTPUTF8
DONE
RC587=0
```

Confirmed against a second, independent provider — `smtp-mail.outlook.com:587` → `CONNECTION ESTABLISHED`, `TLSv1.3`, `Peer certificate: C=US, ST=Washington, L=Redmond, O=Microsoft Corporation, CN=outlook.com`, `RC=0`. Raw TCP to gmail's IPv4 on 587: `TCP_OPEN`, `RC_D=0`.

**465 — TCP does not connect. Blocked, silently.** Every attempt returned `124` (killed by `timeout`) with **no output at all** — no `Connecting to`, no RST, the drop signature rather than a refusal:

```
=== A) gmail 465 IPv4 openssl (UNPIPED) ===        RC_A=124
=== B) outlook 465 IPv4 openssl (UNPIPED) ===      RC_B=124
=== C) raw TCP gmail 64.233.164.109:465 ===        RC_C=124
```

Also blocked on IPv6, and on gmail's port 25 (`RC=124`) — recorded as context, not as a requirement.

| port | TCP connect | STARTTLS / TLS established |
|---|---|---|
| **587 (submission)** | **YES** (gmail + outlook, v4 and v6) | **YES** — TLS 1.3, certificate verified, server reached `250` |
| **465 (implicit TLS)** | **NO** — silent timeout on two providers, both address families | not reached |
| 25 (context) | NO — silent timeout | not reached |

### B.3 Verdict

**587 is open and STARTTLS works, so T6 ships as written** — and the plan should record the second half, because it removes a fallback the plan may have assumed existed: **465 is blocked outbound on this host, so implicit-TLS 465 is NOT available as an alternative.** `SMTP_PORT=587` with STARTTLS is the only submission path this box has; a provider that offers only 465 cannot be used without a relay.

---

## Question C — Alertmanager boots our shape

### C.1 What ran

Throwaway, loopback-only, webhook stub receiver (no SMTP credential exists — that leg is T6's own drill). Config written to `/opt/hmis/.spike11c-alertmanager.yml` in D10's routing shape: `severity="critical"` → immediate (`group_wait: 0s`), `severity="warning"` → long group interval (`group_wait: 5m`, `group_interval: 4h`), each receiver a `webhook_configs` pointed at a deliberately dead port.

```sh
docker run -d --name hmis-spike-am -p 127.0.0.1:19093:9093 \
  -v /opt/hmis/.spike11c-alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro \
  prom/alertmanager:v0.27.0
curl -s -w "\nHTTP=%{http_code}\n" http://127.0.0.1:19093/-/ready
docker exec hmis-spike-am amtool --alertmanager.url=http://127.0.0.1:9093 alert add alertname=SpikeProbe severity=critical job=hmis-spike instance=spike
docker exec hmis-spike-am amtool --alertmanager.url=http://127.0.0.1:9093 alert query
docker exec hmis-spike-am amtool --alertmanager.url=http://127.0.0.1:9093 config routes test severity=critical
docker rm -f -v hmis-spike-am && docker rmi prom/alertmanager:v0.27.0
```

### C.2 Observed

**1. Boots, loads our config, answers on loopback.**

```
hmis-spike-am	prom/alertmanager:v0.27.0	Up 8 seconds	127.0.0.1:19093->9093/tcp
=== /-/ready ===   OK   HTTP=200
=== /-/healthy === OK   HTTP=200

level=info msg="Starting Alertmanager" version="(version=0.27.0, …)"
level=info component=configuration msg="Loading configuration file" file=/etc/alertmanager/alertmanager.yml
level=info component=configuration msg="Completed loading of configuration file" file=/etc/alertmanager/alertmanager.yml
level=info msg="Listening on" address=[::]:9093
```

**2. The synthetic `severity: critical` alert is accepted, visible, and routed.**

```
Alertname   Starts At                Summary  State
SpikeProbe  2026-08-22 21:05:14 UTC           active
```

and from the v2 API — note `receivers`, which is the route match stated by Alertmanager itself:

```json
[{"annotations":{},"endsAt":"2026-08-22T21:10:14.650Z","fingerprint":"382e6db43d0ec65a",
"receivers":[{"name":"spike-stub-critical"}],"startsAt":"2026-08-22T21:05:14.650Z",
"status":{"inhibitedBy":[],"silencedBy":[],"state":"active"},"updatedAt":"2026-08-22T21:05:14.650Z",
"labels":{"alertname":"SpikeProbe","instance":"spike","job":"hmis-spike","severity":"critical"}}]
HTTP=200
```

Route table checked directly, both legs of D10's shape:

```
amtool config routes test severity=critical  → spike-stub-critical
amtool config routes test severity=warning   → spike-stub-warning
```

The dispatcher fired **at the same instant the alert arrived** (`21:05:14.650` in, `21:05:14.650` dispatched) — `group_wait: 0s` on the critical branch behaves as D10 needs — and failed against the dead stub port exactly as designed:

```
level=warn component=dispatcher receiver=spike-stub-critical integration=webhook[0]
aggrGroup="{}/{severity=\"critical\"}:{alertname=\"SpikeProbe\"}"
msg="Notify attempt failed, will retry later" attempts=1
err="Post \"<redacted>\": dial tcp 127.0.0.1:9: connect: connection refused"
```

**3. `amtool` ships in this tag.** `/bin/amtool`, `amtool, version 0.27.0 (branch: HEAD, revision: 0aa3c2aad14cff039931923ab16b26b7481783b5)`. T6's drill assumption holds; no curl-only fallback shape is needed.

**4. Torn down by name, nothing left.** Two findings worth carrying into T6:

- **The image declares `VOLUME`, so `docker run` creates an ANONYMOUS volume.** It was visible while the container ran (`fd56d23f7a281a6570cc582356f14081a223e0efed8c08e8d11f86b1a94d28ae`) and a bare `docker rm` would have orphaned it. Removed with `docker rm -f -v` (by name — never a prune, rule 7). **T6's compose service must give `/alertmanager` a NAMED volume** (`hmis-prod_alertmanager_data` or similar), or every recreate will strand another anonymous one and lose the silence/notification-log state across restarts. *(This is exactly gate report §7.8's specimen — the stray anonymous Prometheus volume the T6 mechanical check rejected a task over.)*
- **Alertmanager REDACTS the receiver URL in its own notify log** (`Post "<redacted>"`). T6's drill evidence must come from the alert's `receivers` field / `amtool`, not from an expectation that the log names the SMTP endpoint.

Container roster and volume roster, before and after, are byte-identical to the brief's stated ground truth — 9 containers (8 `hmis-prod` + `hmis-db-1`), 7 volumes (`hmis-prod_caddy_config`, `hmis-prod_caddy_data`, `hmis-prod_grafana_data`, `hmis-prod_hmis_prod_pgdata`, `hmis-prod_pgbackrest_log`, `hmis_hmis_pgdata`, `hmis-prod_prometheus_data`). No `hmis-spike` container, image or volume survives; port 19093 is free. **No `hmis-prod` container was stopped, restarted or touched, and nothing was written to `/opt/hmis-prod`.**

### C.3 Verdict

**`prom/alertmanager:v0.27.0` boots our routing shape, answers `/-/ready` on loopback, accepts and correctly routes a synthetic `severity: critical` alert, and ships `amtool` — T6's first rung is de-risked at the pinned tag, with one added requirement: a NAMED volume for `/alertmanager`.**

---

## Finish — server state at report time

Verified against the SERVER in one batch, in the same breath as the claims (rule 22(g) — none of this is asserted from the mirror):

```
=== git status --porcelain (expect EMPTY between the markers) ===
=== END STATUS ===
HEAD=349c73556aa4fc273df8e01fa0a61b2e4b49868e
md5=b9b76d63cb03a499756ae720e47244dd  apps/core/src/kernel/worker/scheduler.test.ts
=== untracked spike residue anywhere in the repo? ===
(grep rc=1 — 1 means none)
```

- **Working-tree edit reverted**; the file's md5 is back to `HEAD`'s.
- **Every server-side scratch file deleted** with plain `rm -f` (`.spike11c-*`: the two runner scripts, the phase scripts, 30 + 10 + 10 + 2 run logs, the results/exit/wall files, the Alertmanager yml). `git status --porcelain --untracked-files=all` matches nothing containing `spike`.
- **Nothing was ever written to `/tmp`** (rule 3) — all server scratch lived under `/opt/hmis`; `find /tmp -name "*spike11c*"` returns nothing.
- **Nothing committed, nothing pushed, no branch created on origin.** `HEAD` is the same commit the spike started at.
- **The owner's Windows checkout `C:\Users\ankit\hmis` was READ ONLY** — plan and gate-report sections were read from it; no file was written there and no git command was run against it (rule 2).
- **The local mirror `<SCRATCH>/mirror-spike11c` still holds the edited `scheduler.test.ts` and is deliberately left alone** (rule 22(f)); it is never git-operated and nothing is committed from it.

## What the execute session must do before Phase 0 compiles

1. **D12** — mark the 25-hour framing dead where it stands and write in: the walked advance, the real-turn settle helper (A.8 item 1), the span reduction to 9 h 05 m (A.8 item 2), the measured 30/30 with the runtime-parity number, **and A.7's caveat that the build host reproduces the failure in neither shape**, so CI observation remains the confirmation.
2. **T3's brief** — one sentence: its new `workerInterfaceSweepIntervalMs` census value must be under `CENSUS_SPAN_MS` (9 h 05 m) or the tenth job never fires.
3. **T6 / D10** — SMTP stays 587/STARTTLS as written; add that 465 is *blocked outbound on this host*, so it is not a fallback; add the named-volume requirement for `/alertmanager`; add that the notify log redacts the receiver URL, so drill evidence comes from `receivers` / `amtool`.
4. **Execute-prerequisite 4** is discharged: no relay decision is needed from the owner.
