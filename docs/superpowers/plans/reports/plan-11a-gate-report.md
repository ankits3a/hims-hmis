# Plan 11a — Gate report: deployment shipped, and the four things that are not finished

**Run 2026-08-22 → 2026-08-23 by the compile/execute session.** Phase 0 (three commits) + one
compile commit + a six-task pipeline (`wf_1d5ba77b-788`, 16 agents) + independent verification.
Plan: [`../2026-08-22-phase1-11a-deployment.md`](../2026-08-22-phase1-11a-deployment.md) ·
spike: [`plan-11a-spike-report.md`](plan-11a-spike-report.md) ·
inbox: [`plan-11a-findings-inbox.md`](plan-11a-findings-inbox.md).

> **The headline, stated first because a gate report that buries it is advertising.** All six tasks
> shipped, every Assertion Book row died on its own assertion, and `hmis-prod` is up on
> `https://hmis.crkmch.com` with WAL archiving live to R2. **Four MAJOR defects survive into
> production**, three of them found by the discovery reviewer and one by me running `deploy.sh`:
> Prometheus does not start, a legal hold does not protect the side tables, nothing pins
> `alerts.yml` to the job registry, and the runbook has no retention section. **Two of the four are
> mine** — one from a brief I wrote too tightly, one from a compile sweep I ran before Phase 0
> invalidated it.

---

## 1. What shipped

| | commit | subject (exact, from the plan's table) |
|---|---|---|
| R0-1 | `a4fd880` | `test(core): pin the gauntlet order — deceased-and-phoneless suppresses, never desk-tasks` |
| R0-2 | `855550a` | `fix(core): thread NOTIFY_STUCK_AFTER_MS to the pump — the key an operator sets now takes effect` |
| R0-3 | `51c2e36` | `fix(pipelines): ci-watch marks unresolvable commits seen and heartbeats every sweep` |
| compile | `1a7bbf9` | `docs(plans): 11a compile — four files the prose required and the File Structure never named` |
| T1 | `d27d3d4` | `feat(core): the production build — one image, api and worker entrypoints, web static` |
| T2 | `ff18faf` | `feat(core): migration 0016 — events partitioned monthly, legal holds, the dispatcher floor, the partition job` |
| T3 | `5738f6e` | `feat(infra): hmis-prod compose and Caddy — the deploy script, TLS by hostname, the parity pin` |
| T4 | `cd0c566` | `feat(infra): pgBackRest to R2 — archiving, nightly fulls, and a restore drill that restores` |
| T5 | `cd516f3` | `feat(core): retention — partitions dropped under structural holds, notifications pruned, inert by default` |
| T6 | `cc5d6ce` | `feat(infra): monitoring on the box, cursor seeding, and the deployment runbook` |

Every task passed on its **first rung** except T6, which was rejected once by its mechanical check
and passed on retry (§7.7). Three owner docs commits (`1bf3e10`, `5ce5d6a`, `f0e3d3b`) landed from
the owner's machine during the run and are not mine — rule 11 anticipates exactly this.

## 2. Independent main-session verification

- **Detached `pnpm verify` at HEAD, exit VALUE read from a file: `0`.** `apps/core` **953**
  suites-tests (`Tests: 953 passed, 953 total`) · `apps/web` **152** · `packages/contracts` **7**.
  **Zero FAIL lines.** Baseline into the pipeline was 911/152/7, so the workspace grew by 42 tests
  and nothing decreased.
- **Per-commit `git show --stat` against Files lists — two deviations, both DISCLOSED, both ruled
  authorized by their gates, both re-checked by me** (§7.5/§7.6). No other commit touched a path
  its Files list did not name.
- **Frozen-path audit over the whole range: clean** apart from those two.
- **Server tree clean**; the only untracked path is the findings inbox, which this report commits.
- **Container and volume roster, read and compared against rule 7:**
  `hmis-db-1` **Up 11 days on `postgres:16` — the dev database, never stopped, rebuilt or pruned**,
  and `hmis_hmis_pgdata` untouched. The `hmis-prod` project holds exactly the services its compose
  declares and six volumes, all declared. **No stray container, no anonymous volume.** No blanket
  prune was ever run, by anyone, at any point.

## 3. CI — every commit green by FULL SHA, and the flake that cost four re-runs

| commit | conclusion | duration | attempt |
|---|---|---|---|
| `a4fd880` R0-1 | GREEN | 423 s | 1 |
| `855550a` R0-2 | GREEN | 449 s | 1 (control re-run also green, 419 s) |
| `51c2e36` R0-3 | RED · RED · **GREEN** | 389 / 390 / **452** s | **3** |
| `1a7bbf9` compile | GREEN | 459 s | 1 |
| `d27d3d4` T1 | GREEN | 439 s | 1 |
| `ff18faf` T2 | RED · **GREEN** | 396 / **436** s | **2** |
| `5738f6e` T3 | GREEN | 457 s | 1 |
| `cd0c566` T4 | GREEN | 448 s | 1 |
| `cd516f3` T5 | GREEN | 423 s | 1 |
| `cc5d6ce` T6 | GREEN | 453 s | 1 |

Every duration is minutes, not seconds — **none of these is §2.59's third state**, and no commit
lacks a run object (§2.62 stayed closed: strictly sequential waves, one push each).

### 3a. `scheduler.test.ts`'s L14 census — the flake, measured rather than asserted

Every red above is the same test: `Scheduler › the registration census (L14) › invokes all
{seven,eight} jobs within a faked 25 hours advanced from a pinned instant`, failing with an empty
or partial `invoked` set (`Expected -4 / Received +0`).

**I did not call it a flake on the signature. I ran a control.** `855550a` and `51c2e36` have
**byte-identical source** across `apps/core`, `packages/contracts` and `apps/web` — the only
difference in the entire tree is one shell script under `docs/`. I re-ran `855550a`, which had been
green: **green again**. Then `51c2e36`'s third attempt: **green**. Identical source, green/green
against red/red/green. The build host was green at both, 911/911, zero FAIL lines. For T2 the same
question had a sharper answer: **T5 later grew that very census to nine jobs and CI was green at
`cd516f3` and `cc5d6ce`** — had T2 broken the census, every later commit would be red.

**Measured incidence: 5 reds across ~31 observed runs (~16%), and it fails twice consecutively —
`ffcd24c` and `51c2e36` both needed a third attempt.** One re-run is not a clearing procedure.
Note the watcher **undercounts** this: `?head_sha=` returns only the latest attempt, so any
historical red that was re-run green is invisible.

**Root cause, and it was already written inside the test by an earlier session:** the Scheduler
takes its tick from its CONSTRUCTOR, not the environment, so the shipped `CENSUS_DAILY_TICK_MS =
30_000` samples `runDailyClose`'s **one-IST-minute** window only twice — *"the margin the comment
claims (~12 ticks) has always actually been 2."* Under a slow CI container those two ticks' async
work does not settle before `stop()` latches. That session deferred the fix to *"the plan that owns
this test"*, and Plan 11a does own it (R0-2, T2 and T5 all edit it).

**I did not take the fix, deliberately.** Lowering the tick plausibly makes it WORSE: the guardians'
window is open ~23.9 h/day, so a 30 s grid already costs ~3 000 real DB reads across the advance and
a 5 s grid would cost ~18 000 on the same starved container. That is a genuine runtime/flake trade
on a file three pipeline tasks were editing in sequence, and it is not a call to make mid-run.
**Booked as §7.9 with the measurement, the root cause and that analysis, so the next session
decides with data instead of a suggestion.**

## 4. The Assertion Book — every row, with its verdict

| # | task | verdict | evidence |
|---|---|---|---|
| R1 | R0-1 | **DIED** | Deceased stop relocated past channel resolution. Kill 1 (status): `Expected "suppressed" / Received "undeliverable"`. The agent noticed the status assertion aborts before the count and **isolated the load-bearing row separately**: `toHaveLength` `Expected 0 / Received 1`, the received array carrying `reason: "no_phone"` — literally the event `alertsConsumer` turns into a desk task telling a duty manager to telephone a dead patient's family. |
| R2 | R0-2 | **DIED** | Registration drops the pass-through (byte-for-byte the pre-fix line). `Expected "undeliverable" / Received "sending"`. Fail-first genuinely discharged: the mutant IS the pre-fix behaviour and the red is semantic, not a typecheck. |
| V1 (**P**) | T2 | **DIED** | Floor computed from `now` instead of the cursor's seq. **Rebuilt independently by the gate**: scratch copy beside the source, `diff` shows two changed lines. Died at the assertion. |
| V2 | T2 | **DRILL PASSED** | `seq` monotone through the recreate; **executed by the gate too**, on `createdb -T hmis_dev` scratch, dropped after. Statement echo is the landmine order itself. |
| V3 | T2 | **DRILL PASSED** | `tableoid::regclass` per row quoted: in-range months route to their own partition, out-of-range **in both directions** falls to DEFAULT. |
| V4 | T2 | **DIED** | `create table if not exists` → `create table`. **Rebuilt by the gate.** Shipped half idempotent; mutant errored on `relation already exists`. |
| V5 | T5 | **DIED** | Hold check deleted → the held month is dropped. This is **flag ⑥**. |
| V6 | T5 | **DIED** | Flag ignored. Fixture carries ancient partitions AND ancient terminal notifications, so "zero of everything" cannot pass vacuously (§2.49). |
| V7 | T5 | **DIED** | Status predicate dropped → a years-old `sending` row deleted. GC6 holds. |
| V8 (**P**) | T5 | **DIED** | Boundary comparison flipped, two `sent` rows straddling `NOTIFY_RETAIN_DAYS`. |
| V9 | T5 | **DIED** | Registration drops the values — GC14, the `NOTIFY_STUCK_AFTER_MS` scar one surface over. |
| V12 | T5 | **DIED ×2** | Both mutants built: window predicate dropped, and status guard dropped (`retrying` deleted). |
| V10 | T6 | **DIED** | History seeded FIRST, then the consumer; mutant writes 0 and full replay begins. |
| V11 | T6 | **DIED** | Unconditional update regresses a cursor already beyond `max(seq)`. |

**Twelve required-DIED rows, fourteen mutant builds** (V12 is two; V1/V4 were each built twice —
once by the coder, once by the gate). **Zero survivors. Zero silent fixes.**

## 5. Verify-by-execution flags

| flag | owner | status |
|---|---|---|
| ① container boots, `/health`, worker names its jobs | T1 | **DISCHARGED** |
| ② `OpdRealtimeRegistrar` injects in the shipped image | T1 | **DISCHARGED** — §2.58 measured fixed in the artefact that ships |
| ③ `EXPLAIN` shows plan-time pruning | T2 | **DISCHARGED** — out-of-floor partition absent from the plan entirely |
| ④ WebSocket through Caddy over HTTPS | T3 | **DISCHARGED, AND RE-PROVED BY ME** (§6) |
| ⑤ a real restore, timings, repo size | T4 | **DISCHARGED** — 33.3 MB cluster, incr 26 s, restore 4 s, 1501 events read back out of the restored cluster plus a sentinel, encrypted `aes-256-cbc`. Failure path also executed. |
| ⑥ a held month survives an enabled sweep | T5 | **DISCHARGED** (V5) — **but see §7.2: the hold does not protect the side tables** |
| ⑦ cursor seeding against history | T6 | **DISCHARGED** |
| ⑧ coexistence — ruling 2's acceptance | T3 → **ME** | **DISCHARGED BY ME** (§6) |
| ⑨ missing-series alert fires | T6 | **DISCHARGED as a drill** — `HmisSchedulerJobMissing` fired for a job with no heartbeat row while both staleness rules stayed inactive. **But see §7.1: those rules are not loaded in production.** |

## 6. The coexistence drill and the deploy — run by me, because nobody else may certify it

**`deploy.sh` from the current tree: exit VALUE `0`** (detached, value read from a file).

```
==> 4/8 pgBackRest stanza and archiving check (D8)
  INFO: stanza-create command end: completed successfully (5256ms)
  INFO: check repo1 archive for WAL (primary)
  INFO: WAL segment 000000010000000000000002 successfully archived to
        '/hmis-prod/archive/hmis/16-1/0000000100000000/000000010000000000000002-b77b3018...zst' on repo1
  INFO: check command end: completed successfully (5126ms)
==> 7/8 cron installed at /etc/cron.d/hmis-prod-backup (nightly full 02:30 IST · restore drill 03:30 IST Sunday)
==> 8/8 /health through Caddy over HTTPS — site hostname hmis.crkmch.com
    HTTP 200 {"status":"ok","db":"ok","worker":"ok"}
==> hmis-prod is up: https://hmis.crkmch.com
```

**Flag ④, re-proved by me over real TLS on the real hostname** (raw `node:https`, status line
observed and not inferred):

```
UPGRADE: HTTP 101 Switching Protocols
  sec-websocket-accept: o9OcVVsAlv8Df9k8lapTL3PjSbQ=
  TEXT FRAME: {"type":"error","code":"auth_timeout"}
  CLOSE FRAME: code=4001 reason=auth_timeout
```

Byte-identical in shape to the spike's plain-HTTP measurement: the upgrade completes, and what
follows is the gateway's own auth protocol over a proxied, bidirectional, TLS-terminated connection.

**Flag ⑧ — ruling 2's acceptance, and this is the row nobody else may certify.** Dev `pnpm verify`
run **concurrently with the full `hmis-prod` stack up**: exit VALUE `0`, `apps/core` 953,
`apps/web` 152, `packages/contracts` 7, **zero FAIL lines**. During that run, measured in the same
batch: prod `/health` over HTTPS returned `200 {"status":"ok","db":"ok","worker":"ok"}`, and dev
`hmis-db-1` was `Up 11 days` — different container, different volume, different port, untouched.
**Contention was not observable in the result.**

### 6a. What the deploy revealed that no task could have

**Every task correctly refused to recreate production containers.** Rule 7 permits it only when a
brief says so "in as many words", and no task's brief did. T4 disclosed the consequence in exactly
those terms: *"THE BACKUP FABRIC IS THEREFORE NOT YET LIVE IN PRODUCTION: the production stanza does
not exist in the bucket and `hmis-prod-db-1` is not archiving."* It booked it for T6; T6 was equally
unauthorised and equally correct to decline.

So the shipped compose had **never been deployed**: production was still T3's four-service stack on
plain `postgres:16` with `archive_mode` off and `pg_stat_archiver` reading `archived_count=0,
failed_count=0`. My deploy closed it — the db now runs `hmis-prod/db:latest`, the **production**
stanza exists in R2, and archiving is verified end to end. It also closed the discovery reviewer's
finding 8 (the images predated T5/T6): the rebuilt server image resolves
`dist/src/kernel/retention/events.js` with all six definitions.

**The structural lesson is §11.3.** No task owned the final deploy, because the plan assumed T3's
bring-up plus later drills would suffice. A plan whose artefacts are *deployed configuration* needs
a task — or an explicit main-session step — that puts the FINAL state on the box.

## 7. Findings

### 7.1 MAJOR — Prometheus does not start, and `deploy.sh` reports success anyway *(mine)*

**Executed.** After a clean `deploy.sh`:

```
hmis-prod-prometheus-1   Restarting (2)
level=error msg="Error loading config (--config.file=/etc/prometheus/prometheus.yml)"
  err="open /etc/prometheus/prometheus.yml: no such file or directory"
```

`docker/prod/deploy.sh` step 2 installs `docker-compose.prod.yml`, `caddy/Caddyfile`,
`pgbackrest/pgbackrest.conf` and `drill/restore-drill.sh` — and **line 141 is nothing but a comment**:
`# T6 installs the prometheus/ and grafana/ trees here.` There is not one `install` line for
`prometheus/`, `grafana/` or `postgres-exporter/`. The compose bind-mounts `./prometheus:/etc/prometheus:ro`;
Docker auto-creates the missing source as an empty directory, so the mount succeeds and the config
is absent. Consequences, all three measured: Prometheus crash-loops; **Grafana starts with no
datasource and no dashboards**; **postgres-exporter runs without `queries.yml`, so
`hmis_scheduler_heartbeat_staleness_seconds` — the entire point of D9 — does not exist**, and with
it neither do flag ⑨'s alert rules. `deploy.sh` exits 0 because its only gate is `/health`.

**This one is mine.** My T6 brief said *"You add the seeding slot, in D13's position… **Change
nothing else.**"* I wrote that to protect T3's and T4's content in a three-owner file, and it
forbade T6 from installing its own configs. T6 obeyed exactly. **Fix: four `install` lines in step 2
plus a service-up assertion in the deploy gate** — a `/health` gate cannot see a crash-looping
sibling.

### 7.2 MAJOR — a legal hold saves the events partition and the same run deletes that month's side tables

**Executed by the discovery reviewer (1 idempotency / 2 deliveries / 1 dead letter deleted, dead
letters emptied) and re-verified by me from the source.** `blockingHold()` is called at
`sweep.ts:229` and **nowhere else**; the companion sweep deletes from `event_idempotency`,
`event_deliveries` and `event_dead_letters` on `cutoff` alone. So a patient under an active hold
keeps their events and loses the delivery, idempotency and dead-letter trail for the same month.

T2 shipped `retention_legal_holds` precisely so the protection would be structural. It is
structural for the partition and absent for the side tables. No shipped test covers the
composition — V5's fixture has no side-table rows and V12's has no hold, so **both pass and the gap
lives between them**. That is §2.57's shape: two assertions that are individually correct and
jointly blind.

**Mitigation that buys time, and it is real:** `RETENTION_ENABLED` defaults to **false** (GC5), so
the sweep is inert and nothing is deleted today. The defect arms only when the owner flips retention
on with counsel's signed values (ruling 6). **It must be fixed before that flip.**

### 7.3 MAJOR — `alerts.yml` hand-transcribes nine job names and nothing pins it

**Executed.** `docker/prod/prometheus/alerts.yml` says so itself: *"The nine job names and their
cadences are transcribed verbatim from `registerAllJobs`."* They appear three times (two `job=~`
legs and nine `absent()` terms) and **there are zero references to `alerts.yml` anywhere in `apps/`
or `packages/`**. A tenth job, or a rename, silently produces an alert file that watches a job that
no longer exists and is blind to the one that replaced it. **The same plan shipped
`caddyfile-parity.test.ts` for exactly this drift class** (D14) and did not apply the pattern one
directory over.

### 7.4 MAJOR — the runbook has no retention section, and `.env.prod.example` has none of the keys

**Executed.** `grep -n -i "retention|legal.hold|partition" README.md` over the shipped 835-line
README returns **one** hit, and it is a file path inside the restore-drill paragraph. T5 shipped a
mechanism that drops whole months of clinical events under a structural legal hold, and the
operator-facing document says nothing about how to place a hold, how to read a refusal, or what
`RETENTION_ENABLED` does. Three inbox items addressed to T6 were dropped. `.env.prod.example`
carries none of `RETENTION_ENABLED`, `RETENTION_EVENTS_MONTHS`, `NOTIFY_RETAIN_DAYS`.

### 7.5 The two out-of-Files-list edits — both disclosed, both ruled authorized, both re-checked by me

- **T2 → `apps/core/src/kernel/db/schema/notifications.test.ts`.** That file carries a whole-array
  `toEqual` census of every index on `notifications`; D7's prune index cannot exist without it going
  red. The criteria "the prune index rides 0016" and "`pnpm verify` green" are **jointly
  unsatisfiable** otherwise. Edit is one array entry, one comment, and "three"→"four" in the title.
- **T5 → `apps/core/src/kernel/worker/jobs.test.ts`.** Widening the `JobIntervals` Pick produced
  `TS2739` on an object literal **that R0-2 had created**.

Both coders disclosed loudly as plan defects and both gates independently re-measured and ruled
them authorized breadth rather than scope creep. I agree with both rulings. **The second is my
compile defect** (§11.1).

### 7.6 MINOR — the alert rules reach nobody

`prometheus.yml` has no `alerting:` block and the compose declares no Alertmanager, so
`severity: critical` on `HmisSchedulerJobMissing` currently routes to a dashboard nobody is
watching at 03:00. Consistent with D9's scope (contact points were explicitly cut), but worth
stating plainly next to §7.1: **today the monitoring stack neither runs nor notifies.**

### 7.7 MINOR — `X-Powered-By: Express` still leaks, neither closed nor booked

The T3 gate handed T6 an explicit either/or ("close it in one line or book it as accepted"). T6 did
neither; the only four occurrences in the tree are in `docs/`.

### 7.8 The T6 mechanical check earned its place

It **rejected T6's first attempt** on a stray anonymous Prometheus volume that T6's own report had
filed as "of unknown origin", traced it definitively (`prom/prometheus:v2.53.0` declares
`VOLUME /prometheus`; created 17:08:48Z, inside T6's window; contents are a TSDB directory), and
required a correcting inbox entry rather than a silent removal. That is a ~15 k agent catching a
rule-7 violation four opus gates would not have looked for. **Do not cut the mechanical check.**

### 7.9 MAJOR (booked, not fixed) — the L14 census flake

Full measurement and root-cause analysis in §3a. **Recommended next step, with its trade stated:**
do not simply lower `CENSUS_DAILY_TICK_MS`. The starvation is in the async settle, and a tighter
grid multiplies the real DB reads (~3 000 → ~18 000) on the container that is already too slow. The
promising direction is to stop the daily jobs depending on a narrow wall-clock window under fake
timers at all — e.g. advance to each daily instant explicitly rather than sampling a 25-hour sweep.
This file has now produced **five** ledger entries (§2.57, §2.60, §2.64, and twice here).

### 7.10 Host residue and my own rule breach

Tree clean but for the inbox, which this report commits. **A rule-3 breach of my own, disclosed:**
one of my verification commands contained `curl -o /tmp/x` against the build host — the exact
absolute rule 3 names ("not even a throwaway sanity check"). I caught it before the command reached
that line, killed the background task, confirmed by `ls` that nothing had been created, and
re-issued using `-w %{http_code}` with no file. **Nothing was written to `/tmp`.** Recorded because
I spent this run holding agents to that line, and the checker is not exempt.

## 8. What this run cost

**3,344,182 subagent tokens for the pipeline against a ≤2.4M target — 1.39× over.** 16 agents,
1,095 tool uses, 8 h 04 m wall clock. Phase 0 sits outside that target and cost **249,173** across
its one agent's two items (94,983 + 154,190), inside the 150–250 k the prompt predicted.

Where it went, honestly:

- **The §2.68 arithmetic was right and the estimate under it was not.** I re-derived the target
  before the run, confirmed the Book still had 12 required-DIED rows, and left ≤2.4M standing. What
  I under-weighted is in the prompt's own words: this plan is **drill-heavy**. T1 built and booted
  containers, T3 stood up a full stack and ran a coexistence drill, T4 ran a real
  backup-and-restore against object storage. Drills are tool-call expensive in a way mutants are
  not — 1,095 tool uses against Plan 10's 950 for a comparable agent count.
- **Five opus gates, not two.** The Pipeline Notes tier T1–T5 CRITICAL, and I did not cut a gate to
  protect a number. That was right: **the T2 gate independently rebuilt V1 and V4 and executed the
  V2/V3 drills on its own scratch database**, which is the practice EXECUTE-METHOD §4 says has
  earned its keep, and the T6 mechanical check caught a rule-7 violation (§7.8).
- **The discovery reviewer was again the best-value agent in the run** — one agent, four executed
  MAJORs, three of which nothing else in the process would have found.
- **Four CI re-runs were spent on the flake** (§3a), plus one control re-run. That is ~35 minutes of
  wall clock and no tokens, but it is the flake's real cost and it will recur.

**The honest read: 2.4M was a reasonable target set on mutant count, and mutant count is the wrong
meter for a deployment plan.** For an infra plan, count the DRILLS.

## 9. Residuals — what is true, and what is not finished

**Live and verified:** `hmis-prod` on `https://hmis.crkmch.com`, auto-HTTPS on the owner's
hostname · api healthy, worker healthy (`/health` reports `worker: ok`, not `stale`) · production
Postgres on the pgBackRest image with **WAL archiving to R2 verified end to end** · nightly full
02:30 IST and a weekly restore drill 03:30 IST Sunday installed as host cron · dev stack untouched
and green beside it.

**Not finished, in the order I would fix them:**
1. **§7.1** — Prometheus/Grafana/postgres-exporter configs are never installed. Monitoring is inert.
2. **§7.2** — the legal hold does not cover the side tables. **Must be fixed before
   `RETENTION_ENABLED` is ever flipped true.**
3. **§7.4** — no retention section in the runbook; retention keys absent from `.env.prod.example`.
4. **§7.3** — nothing pins `alerts.yml` to the job registry.
5. **§7.9** — the L14 census flake, with its trade-off analysis.
6. **§7.6 / §7.7** — no alert sink; the `X-Powered-By` leak.

**Owner actions still open:** the `SECRET_KEY` and repo-cipher-passphrase escrow ceremony (the
passphrase was minted by `deploy.sh` into `/opt/hmis-prod/.env.pgbackrest` — **without it every
backup in R2 is unreadable ciphertext, including by the owner**); the counsel engagement for the
retention values and the DPDP pilot posture; and the plan's Decisions item 6 — **mask the R2
endpoint under an owner-controlled domain**, which the owner asked to be reminded of.

## 10. Status

Plan 11a is **SHIPPED with four MAJOR residuals**, all booked above with executed evidence and a
named fix. Stage 1 exists: the hospital's data is on a box that backs itself up to object storage
and has had a restore performed and verified. **Plan 11c is unblocked.**

**Not next, and deliberately:** Plans 09, 11c and the relay belong to a session that reads this
report cold. E-1 (DMZ vs cloud relay) remains open and blocks only the relay.
