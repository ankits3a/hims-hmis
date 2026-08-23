# Plan 11d spike report — one advisory lock, and two config smokes that both moved the plan

**Run 2026-08-24 by the spike agent, from the execute session, before Phase 0 and before any brief is compiled.** Brief: [`PLAN-11D-SPIKE-BRIEF-2026-08-24.md`](./PLAN-11D-SPIKE-BRIEF-2026-08-24.md). Plan served: [`../2026-08-24-phase1-11d-operability-hardening.md`](../2026-08-24-phase1-11d-operability-hardening.md).

**Scope: Questions A, C and D. Question B was DISCHARGED before this spike began and was NOT re-run.**

**THE ONE SENTENCE A READER LOOKS FOR FIRST: there was NO production interaction of any kind. Not one query, not one SELECT, not one `docker exec`, not one read of a `hmis-prod` container's `/metrics`, not one byte written under `/opt/hmis-prod`.** Question B's authorization was spent in the planning session and this spike did not touch it. Question C was answered on a throwaway Alertmanager under the `hmis-spike` compose project, exactly as the task instruction refined it — production's Alertmanager has already delivered `HmisDeployDrill`, so its counters are necessarily non-zero and it could not have answered part 1 anyway. The nine `hmis-prod-*` containers and `hmis-db-1` were verified running and untouched at the end.

**Verdict, in one line each:**

- **Question A — PASS on all five sub-questions, with a discriminating control on each of the two that could have been trivially true. D5's named fix is sound and T3 is unblocked. No halt condition fired.**
- **Question C — the counters are PRESENT AT ZERO before first use. D7's `increase(...) > 0` rules ship as written; no `or on() vector(0)` and no `absent()` leg are needed.**
- **Question D — `promtool test rules` handles both expression shapes cleanly, in both directions, and the predicted `[15m]`-window trap does NOT exist. A DIFFERENT and worse trap does, and it is measured below.**

---

## 0. Host state, and the rule-20 interference statement

All evidence on `root@62.238.106.231:/opt/hmis`, branch `main`, at **`9ec19f2e66fe640b86d443472385b260771bd57b`** throughout — `git rev-parse HEAD` read at the start and again after cleanup, unchanged. `git status --porcelain` was empty before the first measurement and is empty again after the last (§6 below). Authoring in a per-agent mirror (`<SCRATCH>/mirror-11d-spike`, rule 22(a)); every file reached the server by `scp` with `md5sum` confirmed on both sides before any run (`bd86b726ff8384aec64a9b1476ecbacd` for the Question A script, identical locally and on the server).

Every long command ran detached under `setsid nohup` with its exit **VALUE** written to a file and read back (rules 16–18). No pipeline's and no wrapper's status was ever read as a command's verdict. Where a wrapper script's own exit is quoted below it is labelled as the wrapper's, not the measurement's.

**Rule 20 — nothing else was running, and the probe was read as LINES, never as a count.** `pgrep -af jest` was run four times: before the typecheck, before the Question A runs, after them, and after cleanup.

- Probe 1 returned **exactly one line**, and that line was *my own compound ssh shell*, whose command string contains the literal `pgrep -af jest` and therefore matches itself:

  ```
  237333 bash -c cd /opt/hmis && pgrep -af jest; echo "--- pgrep exit: $? ---"; setsid nohup sh -c "cd /opt/hmis && pnpm --filter @hmis/core exec tsc --noEmit > /opt/hmis/.spike-tsc.log 2>&1; echo \$? > /opt/hmis/.spike-tsc.exit" >/dev/null 2>&1 & echo launched
  ```

- Probes 2 and 3 returned **no lines at all** (`pgrep` exit 1, "no match").
- Probe 4, after cleanup, returned **exactly one line**, again my own shell:

  ```
  244405 bash -c echo "=== final rule-20 probe ==="; pgrep -af jest; echo "probe exit: $?"; ...
  ```

The only node processes on the box across the whole run were production's own (`node dist/src/main.js` pid 190595, `node dist/src/worker.js` pid 190602) and `node_exporter`. **No jest process existed at any point and no other agent's suite ran against this repo. No interference was observed.**

One structural note that makes rule 20 weaker than usual here, and it is worth stating rather than relying on: **Question A's runs are not jest runs.** They are `tsx` scripts against `hmis_dev` (`DATABASE_URL`), while the suite's per-worker databases are `hmis_test_<JEST_WORKER_ID>` (`TEST_DATABASE_URL` = `…/hmis_test`). The `JEST_WORKER_ID` collision path rule 20 exists to catch cannot reach these measurements at all.

---

## Question A — does `pg_advisory_xact_lock` actually serialise `changeOperatingMode`?

**Verdict: MEASURED. All five sub-questions PASS. D5's fix is sound as written and T3 is unblocked.**

### A.0 What ran

One throwaway TypeScript file, `apps/core/src/spike-11d-a.scratch.ts`, built against the **shipped** surface — `createDb`, `withTx` and the `Tx` type from `kernel/db/client.ts`, never a hand-rolled pool client, because the whole question is whether the shipped surface behaves. It created one obviously-named scratch table (`spike_11d_sentinel`) in the **dev** database, used it, and dropped it in a `finally` block, printing `CLEANUP spike_11d_sentinel dropped: true`. No database was created or dropped. Then:

```
pnpm --filter @hmis/core exec tsc --noEmit          # exit VALUE 0, log EMPTY
pnpm --filter @hmis/core exec tsx src/spike-11d-a.scratch.ts   # exit VALUE 0
```

Both detached, both exit VALUES read from files. The script was then run **four more times** so the timings are a range and not a single sample. All five runs behaved identically.

Environment, read from inside a `withTx` (this is A5's material, quoted here because everything below depends on it):

```
A5 pg_typeof(hashtext('hmis.operating_mode')): integer
A5 hashtext('hmis.operating_mode'): 774876239
A5 statement_timeout: {"statement_timeout":"0"}
A5 lock_timeout: {"lock_timeout":"0"}
A5 idle_in_transaction_session_timeout: {"idle_in_transaction_session_timeout":"0"}
A5 transaction_isolation inside withTx: {"transaction_isolation":"read committed"}
A5 server version: PostgreSQL 16.14 (Debian 16.14-1.pgdg13+1) on x86_64-pc-linux-gnu, ...
```

`READ COMMITTED` is confirmed from inside the transaction, which is the isolation level D5's whole argument assumes.

### A.1 Does `withTx` hold ONE client for the transaction's life? — **MEASURED: YES**

Inside one `withTx`, `select pg_backend_pid()` was issued as statement 1 and again as statement 7, with four other statements between them (`select 1`, a `count(*)` over `pg_class`, the advisory lock itself, and a `pg_sleep(0.01)`):

```
A1 pid at statement 1: 291220
A1 pid at statement 7: 291220
A1 txid at statement 2: 6315222
A1 txid at statement 8: 6315222
A1 same pid: true
A1 same txid: true
A1 advisory locks held by that backend inside the tx: [{"locktype":"advisory","mode":"ExclusiveLock","granted":true}]
```

**The control that makes this non-trivial, and it is the reason this row is evidence rather than an artefact:** a same-pid result would also be produced by a pool that only ever hands out one connection. Two *concurrent* `withTx` blocks were therefore run and their pids compared:

```
A1 CONTROL pids of two concurrent withTx blocks: [291220,291221]
A1 CONTROL distinct: true
```

The pool does hand out distinct backends; the transaction pins one. Identical in all five runs.

### A.2 Does the loser BLOCK, and for how long? — **MEASURED: YES, ≈ the winner's hold**

Two concurrent `withTx` blocks over the shipped `withTx`. The winner takes `select pg_advisory_xact_lock(hashtext('hmis.operating_mode'))`, waits until the loser has *issued* its own lock statement, then holds for **200 ms**, inserts a sentinel row and commits. The loser times from immediately before its lock statement to immediately after.

| run | winner hold (ms) | LOSER WAIT (ms) | control, no lock (ms) |
|---|---|---|---|
| 1 | 200 | **203.0** | 0 |
| 2 | 200 | **203.7** | 0 |
| 3 | 200 | **203.6** | 0 |
| 4 | 200 | **204.0** | 0 |
| 5 | 200 | **204.0** | 0 |

**The no-lock control is what discriminates.** The identical two-transaction choreography with the lock statement removed produced a loser wait of **0 ms in all five runs**. The ~203 ms is the lock, not the scheduling.

**§2.6 — the specific lock, its mode, and the confirmation that no other lock produces the same wait.** A third connection, taken straight off the pool, snapshotted `pg_locks` joined to `pg_stat_activity` *while the loser was waiting*:

```
{"locktype":"advisory","mode":"ExclusiveLock","granted":true, "classid":0,"objid":774876239,
 "pid":291220,"wait_event_type":"Client","wait_event":"ClientRead",
 "query":"select pg_backend_pid() as pid"}
{"locktype":"advisory","mode":"ExclusiveLock","granted":false,"classid":0,"objid":774876239,
 "pid":291221,"wait_event_type":"Lock","wait_event":"advisory",
 "query":"select pg_advisory_xact_lock(hashtext($1))"}
```

`locktype = advisory`, `mode = ExclusiveLock`, `objid = 774876239` (= `hashtext('hmis.operating_mode')`), the waiter's `wait_event_type = Lock` and `wait_event = advisory`. In the **no-lock control the same snapshot returned no rows at all** — there is no other lock in this path that could produce the same wait.

### A.3 Does the loser's post-lock re-read see the winner's COMMITTED row? — **MEASURED: YES**

The loser's `SELECT` for the sentinel is issued *after* the lock is granted, so under READ COMMITTED it takes a fresh snapshot:

| run | with the lock | control, no lock |
|---|---|---|
| 1–5 | sentinel rows seen: **1** (5/5) | sentinel rows seen: **0** (5/5) |

**This is the whole point of D5 and the control is exactly case B.** Without the lock the loser reads the pre-change state and would decide on it — the duty manager who declares downtime and is told `degraded`. With the lock in front of the read, the loser sees what the winner committed.

### A.4 Does the lock survive a THROWN error correctly? — **MEASURED: YES, released by ROLLBACK**

The lock was taken inside a `withTx`, the count of advisory locks held by that backend confirmed as `1`, and then a `SpikeModeError` was thrown from between the lock and the (never-reached) insert — the exact position of `changeOperatingMode`'s four refusal paths.

```
A4 advisory locks held immediately before the throw: [{"n":1}]
A4 caught: SpikeModeError: spike: simulated ModeError between the lock and the append
A4 advisory locks still granted anywhere after the rollback: 0
```

A second transaction then took the same lock:

| run | re-acquire after the throw (ms) | residual granted advisory locks |
|---|---|---|
| 1 | 1.7 | 0 |
| 2 | 1.5 | 0 |
| 3 | 1.8 | 0 |
| 4 | 1.6 | 0 |
| 5 | 1.8 | 0 |

**No hang, no leak.** Against A.2's ~203 ms blocked acquisition, a ~1.6 ms acquisition is unambiguously "the lock was already free". D5's argument for the `_xact_` variant over the session variant is confirmed by execution: `ROLLBACK` releases it and no explicit unlock is needed on any refusal path.

### A.5 Does it work over the same `Tx` type the function receives? — **MEASURED: YES, at type level and at runtime**

Every lock in every measurement above went through one helper, declared exactly as `changeOperatingMode` receives its first argument:

```ts
async function takeModeLock(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${MODE_KEY}))`);
}
```

- **Type level:** the scratch file sat in `apps/core/src/`, which `apps/core/tsconfig.json` includes, and `pnpm --filter @hmis/core exec tsc --noEmit` returned **exit VALUE 0 with an empty log** under the repo's own `strict` + `noUncheckedIndexedAccess`. The drizzle `sql` template executes on a `Tx`, not only on a `Db`. T3 will not meet a type problem on its first rung.
- **Runtime:** it ran, 20+ times across five runs.
- **Reentrancy, free with the above:** `takeModeLock(tx)` was called **twice in the same transaction** and did not self-deadlock. This matters because it means an accidental double-lock is harmless rather than fatal.

### A.6 The exact statement text that worked

```sql
select pg_advisory_xact_lock(hashtext('hmis.operating_mode'))
```

and through drizzle, parameterised, which is the form that was actually measured:

```ts
await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"hmis.operating_mode"}))`);
```

`hashtext` returns **`integer`** (`774876239`), which resolves to the single-argument `pg_advisory_xact_lock(bigint)` overload by implicit widening — the same resolution `kernel/worker/scheduler.ts` already relies on for `pg_try_advisory_lock`.

### A.7 One thing worth knowing before T3 writes the code

`statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` are all **`0`** on the dev server (MEASURED), so a blocked acquisition waits indefinitely rather than erroring. Production is a **PREDICTION** — I did not and could not query it — but it is a well-founded one from source: `docker/prod/docker-compose.prod.yml`'s `db` service passes only `archive_mode`, `archive_command` and `archive_timeout` on the command line, no `postgresql.conf` is mounted, the image is a thin `FROM postgres:16` derivation, and no connection string in the tree carries an `options=` parameter. `grep -rn "statement_timeout\|lock_timeout\|idle_in_transaction" docker/ apps/core/src apps/core/scripts` matched **nothing but my own scratch file**. So the fix cannot be cut off by a timeout — and equally, nothing bounds the wait except the other transaction's own duration, which for `changeOperatingMode` is one read, one insert and one event append.

---

## ~~Question B~~ — NOT RUN. DISCHARGED 2026-08-24 in the planning session.

Nothing was executed for this question. No connection was opened to `hmis-prod-db-1` or to any production container. The premise's answer (`admin` holds nine of a catalog of 59) stands as recorded in **§B-MEASURED** in the plan document.

---

## Question C — does Alertmanager export its notification counters BEFORE the first failure?

**Verdict: MEASURED. THE COUNTERS ARE PRESENT AT ZERO. D7's rules ship as written.**

### C.0 What ran

A throwaway `prom/alertmanager:v0.27.0` — **the exact tag `docker/prod/docker-compose.prod.yml:352` runs**, so the answer is about the deployed version — under compose project **`hmis-spike`**, publishing `127.0.0.1:19093` only, with a receiver guaranteed to fail: `smtp_smarthost: '127.0.0.1:1'`, which inside the container is the container's own loopback with port 1 closed. A `prom/prometheus:v2.53.0` (again production's tag) came up beside it for Question C part 3 and Question D. Both removed before this report (§6).

### C.1 Before any alert was fired — **MEASURED: PRESENT, AT ZERO, FULLY PRE-INITIALISED**

`curl http://127.0.0.1:19093/metrics` at boot, before any alert was posted: `http=200`, 40 193 bytes, **382 non-comment metric lines**. Both families exist, with HELP and TYPE:

```
# HELP alertmanager_notifications_failed_total The total number of failed notifications.
# TYPE alertmanager_notifications_failed_total counter
# HELP alertmanager_notifications_total The total number of attempted notifications.
# TYPE alertmanager_notifications_total counter
```

**`alertmanager_notifications_total` is present at zero for all 13 integrations:**

```
alertmanager_notifications_total{integration="discord"} 0
alertmanager_notifications_total{integration="email"} 0
alertmanager_notifications_total{integration="msteams"} 0
alertmanager_notifications_total{integration="opsgenie"} 0
alertmanager_notifications_total{integration="pagerduty"} 0
alertmanager_notifications_total{integration="pushover"} 0
alertmanager_notifications_total{integration="slack"} 0
alertmanager_notifications_total{integration="sns"} 0
alertmanager_notifications_total{integration="telegram"} 0
alertmanager_notifications_total{integration="victorops"} 0
alertmanager_notifications_total{integration="webex"} 0
alertmanager_notifications_total{integration="webhook"} 0
alertmanager_notifications_total{integration="wechat"} 0
```

**`alertmanager_notifications_failed_total` is present at zero for all 13 integrations × all 5 reasons = 65 series**, of which the five that matter here:

```
alertmanager_notifications_failed_total{integration="email",reason="clientError"} 0
alertmanager_notifications_failed_total{integration="email",reason="contextCanceled"} 0
alertmanager_notifications_failed_total{integration="email",reason="contextDeadlineExceeded"} 0
alertmanager_notifications_failed_total{integration="email",reason="other"} 0
alertmanager_notifications_failed_total{integration="email",reason="serverError"} 0
```

The label sets are **not** created lazily and they are **not** restricted to configured integrations — Alertmanager registers the full cross-product at start-up. The `reason` values are exactly `clientError`, `contextCanceled`, `contextDeadlineExceeded`, `other`, `serverError`.

**Therefore the missing-series blind spot the brief was written to catch DOES NOT EXIST for this metric.** `increase(alertmanager_notifications_failed_total[15m]) > 0` is armed from the moment Alertmanager starts, on a box that has never sent a notification. No `or on() vector(0)` term and no `absent()` leg are needed.

### C.2 After a guaranteed-failing notification — **MEASURED: `reason="other"`**

One synthetic alert posted to `/api/v2/alerts` (`http=200`, `alertname="HmisSpikeSynthetic"`, `severity="critical"`). Polled every 2 s; the counter moved on **poll 5, ≈10 s after the POST**. Settled reading ~60 s later:

```
alertmanager_notifications_failed_total{integration="email",reason="other"} 6
alertmanager_notifications_total{integration="email"} 7
```

Every other series in both families stayed at 0. Alertmanager's own log names the failure:

```
level=error component=dispatcher msg="Notify for alerts failed" num_alerts=1
  err="dead-smtp/email[0]: notify retry canceled after 7 attempts: establish connection to
       server: dial tcp 127.0.0.1:1: connect: connection refused"
```

**A refused SMTP dial is bucketed as `reason="other"`, not `serverError` and not `clientError`.** Any rule that filters on `reason` would miss the single likeliest real failure (a smarthost that stops answering). D7's rule does not filter on `reason`, so it is correct — but it is correct by omission, and the plan should now say so on purpose.

**And this is what D7's "the counter keeps climbing so the alert is re-sent" claim looks like measured rather than asserted:** 6 increments in ~60 s of continuous failure, so `increase(...[15m])` stays well above 0 for as long as the situation persists.

### C.3 `up` for a target that has never been scraped — **MEASURED: ABSENT, then 0**

The throwaway Prometheus was configured with one job (`neverup`) pointing at a black-hole address, `scrape_interval: 30s`, default `scrape_timeout: 10s`.

```
# ~1 second after the container started, at 10:25:09.104 UTC
$ curl -s 'http://127.0.0.1:19090/api/v1/query?query=up'
{"status":"success","data":{"resultType":"vector","result":[]}}
```

**The `up` series does not exist.** After the first scrape completed:

```
{"metric":{"__name__":"up","instance":"10.255.255.1:9999","job":"neverup"},"value":[...,"0"]}
```

and the target reads `"health":"down"`, `"lastError":"Get \"http://10.255.255.1:9999/metrics\": context deadline exceeded"`, `"lastScrapeDuration":10.00036867`.

So `up` is genuinely absent until the **first scrape completes**, and for an unreachable target that completion costs a full `scrape_timeout` (10 s here) *after* a scrape-offset that is anywhere in `[0, scrape_interval)`. On the production box that is a window of up to ~25 s after a Prometheus restart during which `up{job="alertmanager"} == 0` matches nothing. D7's `for: 5m` on `HmisAlertmanagerDown` already covers that window with two orders of magnitude to spare, so nothing changes — but the state D7's rejected fourth rule was aimed at is real, and it is now measured rather than reasoned about.

---

## Question D — can `promtool test rules` unit-test these rules at all?

**Verdict: MEASURED. YES to all three parts. The predicted `[15m]`-window trap does not exist. A worse one does.**

Run as `docker run --rm --name hmis-spike-promtool-<n> --label com.docker.compose.project=hmis-spike … --entrypoint promtool prom/prometheus:v2.53.0` against a throwaway `rules.yml` carrying **D7's three expression shapes verbatim**. `promtool, version 2.53.0 (revision 4c35b9250afe…)`. Every exit code written to its own file and read back.

| run | what it asserts | exit VALUE | promtool's own line |
|---|---|---|---|
| `check` | `promtool check rules rules.yml` | **0** | `SUCCESS: 3 rules found` |
| `fire` | all three rules FIRE on synthetic input, `for:` driven, both OR legs | **0** | `SUCCESS` |
| `healthy` | none fire on healthy input, every series pinned present at 0 | **0** | `SUCCESS` |
| `broken` | deliberate break — asserts firing on HEALTHY input | **1** | `FAILED … got:[]` |
| `vacuous` | "nothing fires", with the series ABSENT from `input_series` | **0** | `SUCCESS` ← **the trap** |
| `window` | probes what `increase(…[15m])` actually evaluates to | **1** | values quoted below |

### D.1 A rule over `up{job="…"}` from `input_series` — **MEASURED: YES, and the `for:` clause is genuinely driven**

`up{job="alertmanager", instance="alertmanager:9093"}` with values `0+0x20` drives `HmisAlertmanagerDown` (`expr: up{job="alertmanager"} == 0`, `for: 5m`) correctly:

- `eval_time: 4m`, `exp_alerts: []` → passes
- `eval_time: 10m` → fires, with `exp_labels` `{severity, job, instance}` and both `exp_annotations` matched by exact text

The `for: 5m` is not decoration in a promtool test; it is evaluated. The pair of eval_times is what proves it.

### D.2 A rule over `increase(<counter>[15m])` — **MEASURED: YES, and the predicted trap is NOT the trap**

The brief predicted that "a 15 m range over a 1 m test series evaluates to nothing and the rule reads as not-firing when it is really not-evaluable". **Measured, over a series only 3 minutes long (`values: '0 0 1 2'` at `interval: 1m`), read through a `[15m]` window:**

```
expr: "increase(alertmanager_notifications_failed_total[15m])", time: 0m,   got: nil
expr: "increase(alertmanager_notifications_failed_total[15m])", time: 1m,   got: {integration="email", reason="other"} 0E+00
expr: "increase(alertmanager_notifications_failed_total[15m])", time: 3m,   got: {integration="email", reason="other"} 2E+00
expr: "alertmanager_notifications_failed_total",                time: 3m,   got: {…} 2E+00
```

So the real rule is **two samples, not fifteen minutes**: `increase` is nil with one sample in the window and evaluable from the second sample onward, whatever the window width. With `interval: 1m` that means a 2-minute test series is already enough for a `[15m]` rule, and there is **no reason for T5 to shrink D7's window to something promtool can drive.** `[15m]` is drivable.

**And there is no extrapolation inflation to design around.** The long-series firing test (21 samples of 0, then 1…10) rendered `{{ $value }}` as a bare **`10`**, not the extrapolated `10.714285714285714` this agent predicted before running it. That prediction was written into the first test file as an exact `exp_annotations` string and promtool rejected it:

```
exp: Annotations:{description="10.714285714285714 notification failures in the last 15 minutes.", …}
got: Annotations:{description="10 notification failures in the last 15 minutes.", …}
```

That is 11c's `9d 6h 13m 20s` lesson recurring, in the opposite direction: **a `$value` render must be measured, never predicted**, and it is the *assertion* that has to be corrected, not the rule.

### D.3 The exit VALUE in both directions — **MEASURED: 0 firing, 0 healthy, 1 on a deliberate break**

The `broken` file asserts each rule fires on healthy input (`up = 1`, counter flat at 0). Exit VALUE **1**, and promtool names both:

```
FAILED:
  alertname: HmisAlertmanagerDown, time: 20m,
      exp:[ 0: Labels:{alertname="HmisAlertmanagerDown", instance="alertmanager:9093",
                        job="alertmanager", severity="critical"} … ],
      got:[]
  alertname: HmisAlertNotificationsFailing, time: 20m,
      exp:[ 0: Labels:{alertname="HmisAlertNotificationsFailing", integration="email",
                        reason="other", severity="critical"} … ],
      got:[]
```

`promtool test rules` discriminates. Flag ④ is worth having.

### D.4 THE TRAP THAT IS ACTUALLY THERE — **MEASURED: a negative control over an ABSENT series passes**

The `vacuous` file declares one unrelated series and nothing else — **no `alertmanager_notifications_failed_total`, no `up`, no `prometheus_notifications_*`** — and asserts `exp_alerts: []` for all three rules.

```
Unit Testing:  rules_test_vacuous.yml
  SUCCESS
---- vacuous exit VALUE: 0 ----
```

**Exit VALUE 0.** It is indistinguishable, from the exit code and from the output, from the real `healthy` run. Corroborated directly by the window probe's last leg, where `increase(alertmanager_notifications_failed_total[15m])` over a test that never declares the series returned `got: nil`.

**This is D11's watcher-was-inert failure and `alerts.yml`'s `absent()` reasoning arriving inside the test harness rather than inside the rule.** A `exp_alerts: []` leg proves the rule does not fire; it does **not** prove the rule was evaluated. V18a's "and NOT on healthy input" half is therefore vacuous unless the healthy input pins every series each rule reads — and it must pin them **with their real label sets**, because `prometheus_notifications_errors_total` carries an `alertmanager` label and `prometheus_notifications_dropped_total` carries none.

---

## What the plan must change — the exact edits

Applied **in place** (§2.48), not as a verdict block appended anywhere.

### Edit 1 — D5, replace the closing paragraph

**Replace this paragraph** (the last one in D5):

> **This is the ONE new database primitive in the plan and nobody here has executed it** —
> `pg_advisory_xact_lock` appears nowhere in the tree. Spike Question A measures it: that `withTx`
> (`kernel/db/client.ts:14`, a bare `db.transaction(fn)`) holds one client for the transaction's
> life, that the loser BLOCKS rather than returning false, and that after acquiring the lock the
> loser's re-read sees the winner's committed row.

**with:**

> **This was the ONE new database primitive in the plan and it is now MEASURED, not predicted** — spike Question A, `plan-11d-spike-report.md`, five runs against the dev database on PostgreSQL 16.14 through the shipped `withTx`/`Tx` surface. All four load-bearing claims hold, each against a control that would have caught a trivially-true result:
>
> - **`withTx` holds ONE backend for the transaction's life.** `pg_backend_pid()` = `291220` at statement 1 and at statement 7 with four statements between; `txid_current()` identical too. **Control:** two *concurrent* `withTx` blocks got pids `291220` and `291221`, so the pool does hand out distinct backends and the pin is the transaction's.
> - **The loser BLOCKS for ≈ the winner's hold.** Against a 200 ms hold the loser waited **203.0 / 203.7 / 203.6 / 204.0 / 204.0 ms**. **Control:** the identical choreography with the lock statement removed waited **0 ms in all five runs**. `pg_locks` during the wait names it exactly — `locktype=advisory`, `mode=ExclusiveLock`, `objid=774876239`, waiter's `wait_event_type=Lock` / `wait_event=advisory` — and the no-lock control's same snapshot returned **no rows at all**, so no other lock in this path produces that wait (§2.6).
> - **After acquiring, the loser's re-read SEES the winner's committed row** — sentinel present, 5/5. **Control:** without the lock it is absent, 5/5. That control *is* case B.
> - **A thrown error releases the lock.** A `ModeError`-shaped throw between the lock and the append left **zero** granted advisory locks anywhere, and the next transaction acquired in **1.5–1.8 ms** against the 203 ms of a genuinely contended acquisition. No unlock call is needed on any of the four refusal paths.
>
> **The statement, exactly as measured and exactly as T3 should write it:**
>
> ```ts
> await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"hmis.operating_mode"}))`);
> ```
>
> It is `Tx`-typed and compiles: the scratch helper `takeModeLock(tx: Tx)` passed `pnpm --filter @hmis/core exec tsc --noEmit` at **exit VALUE 0** under `strict` + `noUncheckedIndexedAccess`, so T3 meets no type problem on its first rung. `hashtext` returns `integer` (`hashtext('hmis.operating_mode') = 774876239`), widening to the single-argument `pg_advisory_xact_lock(bigint)` overload — the same resolution `kernel/worker/scheduler.ts` already relies on. Calling it twice in one transaction does **not** self-deadlock. `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` are all `0` on the dev server and nothing in `docker/` or the connection strings sets any of them, so a blocked acquisition cannot be cut off by a timeout.

### Edit 2 — Assertion Book, a note under the table

**Add**, immediately after the "Required-DIED mutant count: 26" paragraph:

> **V10 and V11's PRIMITIVE is no longer a prediction.** The spike measured `pg_advisory_xact_lock` end to end (report §Question A): the lock blocks, the post-lock re-read sees the winner's commit, and a thrown error releases it. **T3 does not re-measure the primitive; T3 measures the FUNCTION.** V11's mutant — the lock moved to after `getOperatingMode(tx)` — is known-constructible, and its expected symptom is the one the spike produced as its *no-lock control*: the loser reads the pre-change state (sentinel absent, 5/5) and decides on it.

### Edit 3 — D7, replace the two paragraphs that hedge the counters

**Replace** the second bullet of "What the three rules genuinely buy" —

> - `HmisAlertNotificationsFailing` covers the far more likely failure by a wide margin: **the sink is up and the credential or the mailbox is broken.** That alert *can* be delivered — a failing email receiver does not stop Alertmanager evaluating or routing, and the counter keeps climbing so the alert is re-sent as the situation persists.

**with:**

> - `HmisAlertNotificationsFailing` covers the far more likely failure by a wide margin: **the sink is up and the credential or the mailbox is broken.** That alert *can* be delivered — a failing email receiver does not stop Alertmanager evaluating or routing — and **the counter climbing is MEASURED, not assumed**: spike Question C drove a real SMTP refusal against `prom/alertmanager:v0.27.0` and `alertmanager_notifications_failed_total{integration="email",reason="other"}` reached **6 in ~60 s** of continuous failure, so `increase(…[15m])` stays far above 0 for as long as the situation persists and the alert is re-sent.
>
> **THE MISSING-SERIES BLIND SPOT DOES NOT EXIST HERE, AND THIS WAS MEASURED BEFORE THE RULE WAS WRITTEN.** A `prom/alertmanager:v0.27.0` that has never sent a notification already exports **`alertmanager_notifications_total` at 0 for all 13 integrations and `alertmanager_notifications_failed_total` at 0 for all 13 integrations × all 5 reasons (65 series)**, with HELP and TYPE. The label cross-product is registered at start-up, not lazily on first use, and it is not restricted to the integrations the config names. **So `increase(…) > 0` is armed on a fresh deployment and needs no `or on() vector(0)` term and no `absent()` leg.** (Contrast D11's watcher and `alerts.yml`'s scheduler leg, where the series genuinely can be absent — the difference is which process owns the metric.)
>
> **The rule deliberately does not filter on `reason`, and that is now a decision rather than an omission.** A refused SMTP dial — the single likeliest real failure, a smarthost that stops answering — is bucketed as **`reason="other"`**, not `serverError` and not `clientError`. A rule filtered to the "error-looking" reasons would miss it entirely.

### Edit 4 — D7, add one paragraph after the rules table

**Add**, immediately after the three-row table:

> **The third rule's series were also measured, and they behave differently from the first two.** `prometheus_notifications_dropped_total` is **unlabelled and present at 0 from boot, unconditionally**. `prometheus_notifications_errors_total` is **per-alertmanager-endpoint and exists only because `prometheus.yml` carries an `alerting:` block** — on a Prometheus with no such block it is absent from `/metrics` entirely; the moment one is configured, the series appears **at 0 for every configured endpoint within seconds, before any error**, and then climbs 0 → 1 on the endpoint that fails. Since 11c's `alerting:` block is already at `prometheus.yml:41-43`, both series exist on the production box today and the rule is armed. The OR is what makes it robust either way: the `dropped_total` leg is always evaluable, so the rule can never be silently non-evaluable as a whole.

### Edit 5 — Assertion Book row V18a, replace the row

**Replace V18a's `discriminating input` cell:**

> `promtool test rules` over `alerts-meta.yml`, both directions, exit VALUE quoted; **annotations asserted by EXACT text** (11c's `9d 6h 13m 20s` lesson — assert on rendering, not merely on firing)

**with:**

> `promtool test rules` over `alerts-meta.yml`, both directions, exit VALUE quoted (spike: firing **0**, healthy **0**, deliberate break **1** with `got:[]` naming both rules). **Annotations asserted by EXACT text, and the `{{ $value }}` render MEASURED before it is asserted** — the spike predicted the extrapolated `10.714285714285714` and promtool answered a bare `10`; assert the render or write the annotation as `{{ $value | printf "%.0f" }}` so the text is stable. **The `for:` clause is genuinely driven and must be asserted in BOTH positions** — `exp_alerts: []` at `eval_time: 4m` and firing at `10m` for a `for: 5m` rule. **`[15m]` needs no shrinking**: `increase(…[15m])` is evaluable from the SECOND sample in the window whatever the window's width (measured: nil at 1 sample, `0E+00` at 2, `2E+00` at 4 over a 3-minute series). **AND THE NEGATIVE LEG MUST PIN EVERY SERIES PRESENT-AT-ZERO IN `input_series`, WITH ITS REAL LABELS** — `alertmanager_notifications_failed_total{integration,reason}`, `up{job,instance}`, `prometheus_notifications_errors_total{alertmanager}` and the unlabelled `prometheus_notifications_dropped_total`. **MEASURED: a healthy file that simply OMITS the series passes `exp_alerts: []` at exit VALUE 0, indistinguishable from a real green.**

### Edit 6 — Assertion Book row V18a, add a third required-DIED mutant

**Add to V18a's `killing mutant` cell**, after "widen a threshold; and separately break a rule so only the negative control fails":

> ; and a THIRD: **delete one series from the healthy test's `input_series`.** That mutant cannot be killed by an `exp_alerts: []` leg — it makes it pass — so the healthy file must additionally carry a `promql_expr_test` leg asserting each series present (e.g. `expr: alertmanager_notifications_failed_total`, `exp_samples:` the zero sample). **The kill is that leg failing**, not the alert leg. A negative control that cannot fail this way is §2.22's "not a pre-flight".

**Consequence for the count line:** "Required-DIED mutant count: 26 … T5 (5: V18a×2, V18b×2, V19)" becomes **27**, with **T5 (6: V18a×3, V18b×2, V19)**.

### Edit 7 — D7, the rejected fourth rule, one clause

**Append to** "A fourth rule was considered and rejected":

> Measured for completeness (spike Question C.3): `up` for a target that has never been scraped is **genuinely absent** — an `/api/v1/query?query=up` one second after start-up returned `result: []` — and becomes `0` only when the first scrape *completes*, which for an unreachable target costs a full `scrape_timeout` (10 s) after a scrape offset anywhere in `[0, scrape_interval)`. On this box that is a window of up to ~25 s after any Prometheus restart. `HmisAlertmanagerDown`'s `for: 5m` covers it with two orders of magnitude to spare, so the rejection stands — but the state is real, not hypothetical.

### Nothing changes in D1

Question B was not re-run and D1 is untouched by this spike.

---

## What I created and what I removed

**Containers.** Two, both under compose project **`hmis-spike`**, both removed:

| container | image | created | removed |
|---|---|---|---|
| `hmis-spike-alertmanager-1` | `prom/alertmanager:v0.27.0` | `docker compose -p hmis-spike … up -d` | `docker compose -p hmis-spike … down --volumes --remove-orphans`, exit VALUE **0** |
| `hmis-spike-prometheus-1` | `prom/prometheus:v2.53.0` | same | same |

Plus six ephemeral `docker run --rm --name hmis-spike-promtool-<n>` containers (`check`, `fire`, `healthy`, `broken`, `vacuous`, `window`), each auto-removed on exit and each labelled `com.docker.compose.project=hmis-spike`. Network `hmis-spike_default` created and removed. **No image was pulled** — both tags were already on the box because production runs them.

**Verified after teardown:**

```
=== any hmis-spike container left? ===  (none)
=== any hmis-spike network left? ===    (none)
=== any hmis-spike volume left? ===     (none)
=== surviving containers ===
hmis-prod-caddy-1 · hmis-prod-worker-1 · hmis-prod-api-1 · hmis-prod-alertmanager-1
hmis-prod-node-exporter-1 · hmis-prod-grafana-1 · hmis-prod-prometheus-1
hmis-prod-postgres-exporter-1 · hmis-prod-db-1 · hmis-db-1
```

All ten pre-existing containers still running. **`hmis-db-1` and the `hmis_hmis_pgdata` volume were never stopped, removed or rebuilt; no `hmis-prod` container was stopped, restarted or removed; no `prune` of any kind was run; every removal was by explicit name or by `-p hmis-spike`.**

**Databases.** None created, none dropped. One scratch TABLE, `spike_11d_sentinel`, created in the **dev** database `hmis_dev` and dropped in the same script's `finally` block — `CLEANUP spike_11d_sentinel dropped: true` on every run. `hmis_test` and the per-worker `hmis_test_<N>` databases were never opened.

**Server scratch, all under `/opt/hmis` (rule 3 — nothing was written to `/tmp`), all removed with plain `rm -f`:**

`apps/core/src/spike-11d-a.scratch.ts` · `.spike-11d/` (compose.yml, alertmanager/alertmanager.yml, prometheus/{prometheus,always}.yml, rules.yml, rules_test_{fire,healthy,broken,vacuous,window}.yml, fire.sh, promtool.sh, notif.sh, am-before.txt, am-after.txt, am-after2.txt, prom-metrics-noam.txt, up-t0.json, exit-*) · `.spike-tsc.{log,exit}` · `.spike-a.{log,exit}` · `.spike-a2.{log,exit}` · `.spike-fire.{log,exit}` · `.spike-promtool.{log,exit}` · `.spike-promtool2.{log,exit}` · `.spike-notif.{log,exit}`

`find /opt/hmis -name "*spike*"` outside `docs/` and `node_modules`/`.git` returns nothing.

**`git status --porcelain` on the build host, after cleanup and before the report commit: EMPTY.** HEAD unchanged at `9ec19f2e66fe640b86d443472385b260771bd57b`.

The local mirror `<SCRATCH>/mirror-11d-spike` was left alone, per rule 22(f).

## Every production interaction

**NONE. Zero. Not one.** No SELECT, no `docker exec`, no `docker compose` command naming `hmis-prod`, no read of any `hmis-prod` container's `/metrics` or logs, no write anywhere under `/opt/hmis-prod`, no read of `/opt/hmis-prod/.env`. The only production containers this report mentions at all are the ten names in the `docker ps` output above, read to prove the spike's teardown did not touch them.

---

## Things nobody asked about

**1. `prometheus_notifications_errors_total` does not exist until an `alertmanager:` target is configured — and D7's third rule depends on it.** On a `prom/prometheus:v2.53.0` with no `alerting:` block, `/metrics` carries `prometheus_notifications_dropped_total 0`, `prometheus_notifications_queue_capacity`, `queue_length` and `alertmanagers_discovered` — and **no `errors_total` and no `sent_total` at all**. Add an `alerting:` block, reload, and within 5 s:

```
prometheus_notifications_errors_total{alertmanager="http://10.255.255.1:9093/api/v2/alerts"} 0
prometheus_notifications_errors_total{alertmanager="http://alertmanager:9093/api/v2/alerts"} 0
```

— present **at zero, per endpoint, before any error** — and 25 s later the black-hole endpoint reads `1`. This is the same question the brief asked about Alertmanager, asked of the metric the brief did not name, and it is the one that could have made D7's third rule inert. It is not inert (11c already shipped the `alerting:` block), but the plan asserted nothing about it and now can. → **Edit 4.**

**2. D7 picked the coarser of two counters, and the coarse one is the right choice — but the plan should know the other exists.** In the same ~60 s of continuous SMTP refusal:

```
alertmanager_notifications_failed_total{integration="email",reason="other"}  6      ← notify CYCLES
alertmanager_notification_requests_failed_total{integration="email"}        44      ← individual ATTEMPTS
alertmanager_notification_requests_total{integration="email"}               44
alertmanager_notification_latency_seconds_count{integration="email"}        44
```

`notifications_failed_total` counts one per *group notify cycle*; the retry loop inside a cycle ("notify retry canceled after 7 attempts") is invisible to it and shows up only in the `notification_requests_*` family. For a `> 0` rule both work and the coarser one is the better signal-to-noise choice. Worth one sentence in D7 so a future reader does not "improve" the rule onto the noisier metric.

**3. `alertmanager_notifications_total` briefly runs one AHEAD of `_failed_total`** (`7` vs `6` at the same scrape) because the attempt counter increments when a notify starts and the failure counter when it ends. Any future rule comparing the two — a success-ratio rule, say — must tolerate that off-by-one. Not a change to this plan; a booking against the next one that reaches for a ratio.

**4. `promtool test rules` cannot tell "the rule was evaluated and stayed quiet" from "the rule could not be evaluated at all", and reports SUCCESS at exit VALUE 0 for both.** Measured, §D.4. This is the sharpest thing this spike found, because it is a hazard in the *verification*, not in the system — a green flag ④ over a healthy file that forgot a series would certify a rule nobody had ever evaluated. → **Edits 5 and 6.**

**5. A `{{ $value }}` from `increase()` does NOT arrive extrapolated.** Predicted `10.714285714285714`, measured `10`. The prediction was written into a test file and promtool rejected it, which is the only reason this is a measurement and not another prediction. 11c's annotation lesson, second occurrence, and worth noting that it bit in the *opposite* direction this time: the naive expectation was right and the sophisticated one was wrong.

**6. Nothing in this repository sets `statement_timeout`, `lock_timeout` or `idle_in_transaction_session_timeout`.** `grep -rn` over `docker/`, `apps/core/src` and `apps/core/scripts` matched only my own scratch file; the dev server reports `0` for all three; the production `db` service passes only `archive_mode`, `archive_command` and `archive_timeout` and mounts no `postgresql.conf`. Load-bearing for D5 in both directions: a blocking acquisition cannot be cut off by a timeout (good), and nothing bounds the wait except the other transaction's own duration (fine here — one read, one insert, one event append — but it is now a stated property rather than an accident).

**7. `apps/core/dist/` and `packages/contracts/dist/` exist on the build host.** Both gitignored, both expected (Plan 11a's production build; `db:migrate:prod` runs `node dist/scripts/migrate.js`), and neither reachable by jest's `testMatch` (`**/*.test.ts`). Not a rule-5 violation and not a problem — recorded only because a future agent pulling a rule-22 mirror will see ~9 MB of compiled JavaScript in it and should not spend a rung deciding whether it is stale emit. It is not; it is the deployment artefact.

---

## Cost and wall clock

**Wall clock: inside the brief's 20–35 minute estimate**, evidenced by the server's own timestamps — the throwaway Prometheus logged its first config load at `10:24:56.261Z` and the last measurement (`prometheus_notifications_errors_total` reaching 1) at `10:30:21.775Z`, with the Question A runs before that and teardown after.

**Token cost is not stated because this agent cannot measure its own**, and every other number in this report was measured. The report that consumes this one should read the cost from the execute session's accounting rather than from here. Question B being pre-discharged is most of why the run was short: the whole spike was one concurrency measurement, one container smoke and one `promtool` matrix.
