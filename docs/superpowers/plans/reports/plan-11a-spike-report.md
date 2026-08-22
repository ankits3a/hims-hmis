# Plan 11a — Spike report: questions A–E answered by execution

**Spike run 2026-08-22 on the build host (`root@62.238.106.231:/opt/hmis`), starting at `ffcd24c`,
on throwaway branch `spike/11a` (deleted; was `b488d6f`).** All evidence below was produced by
running commands on the server. Everything asserted from *reading* rather than *running* is
collected in its own section near the end, per §2.60. Spike brief:
[`../2026-08-22-phase1-11a-spike-brief.md`](../2026-08-22-phase1-11a-spike-brief.md).

**The five verdicts in one block:**

| Q | Fork | Verdict |
|---|------|---------|
| A | FORK-A | **COMPILED.** `tsc` output boots both processes; §2.58 fixed as a by-product. The one obstacle was `@hmis/contracts`, not `NodeNext`. |
| B | FORK-B | **Branch (i) rename-and-recreate**, one transaction, worked first try. Dispatcher green unmodified; pruning demonstrated. Drizzle cannot express it — T2 hand-writes SQL. |
| C | FORK-C | **Placement (i): pgBackRest in the Postgres image.** Full → incr → real restore all completed (3s / 2s / 2s on 78 MB). The archive_command coupling was measured, not argued. |
| D | FORK-D | **Same box.** The reduced stack idles at ~96 MiB / ~0% CPU — ~0.6% of a CX43, nowhere near the 15% branch threshold. |
| E | (flag ④) | **Discharged.** HTTP 101 through a bare `reverse_proxy`; the gateway then runs its own auth protocol and closes 4001. No special Caddy directive needed. |

---

## Question A — compiled output boots (FORK-A = COMPILED)

**Verdict: FORK-A = COMPILED.** The plan's recommended branch is confirmed, and the fix was small —
but the obstacle the plan predicted (`NodeNext` output semantics) is NOT the obstacle that exists.
`apps/core` is a CJS package (no `"type": "module"`), so `tsc` under `NodeNext` emits plain
CommonJS and extensionless relative imports, `__dirname`, and CJS/ESM interop never came up.
**Zero source files were edited.** The entire fix was:

1. `apps/core/tsconfig.build.json` (new, 12 lines): extends `./tsconfig.json`, `outDir: dist`,
   `rootDir: src`, includes `src`, excludes `src/**/*.test.ts`, `noEmit: false`.
2. `packages/contracts/tsconfig.build.json` (new, same shape).
3. **`packages/contracts/package.json`: `"main": "./src/index.ts"` → `"./dist/index.js"`**
   (`"types"` stays at `./src/index.ts`). This is the real finding: the workspace package's `main`
   points at a `.ts` file, which `tsx` transpiles on the fly and plain `node` cannot load. Without
   this one line, `node dist/main.js` cannot start no matter how `apps/core` is compiled.

Build (from the run log, `pnpm exec tsc -p tsconfig.build.json` in each package):

```
contracts tsc exit=0 elapsed≈1.40s
core      tsc exit=0 elapsed≈9.27s
```

Stray-emit check (rule 5): `git status --porcelain` after both builds showed only
`?? .spike/`, `?? apps/core/tsconfig.build.json`, `?? packages/contracts/tsconfig.build.json` —
no `.js` beside any `.ts` (emit went to gitignored `dist/`).

**The §2.58 measurement, both directions:**

Control — `timeout 30 node_modules/.bin/tsx src/main.ts` (the documented dev path) still crashes,
exit 1:

```
    at OpdRealtimeRegistrar.onModuleInit (/opt/hmis/apps/core/src/modules/opd/opd.module.ts:19:52)
    at MapIterator.iteratee (.../nest-application-context ... callModuleInitHook ...)
```

(the `registerTopicSpace`-on-undefined crash, at the exact line §2.58 names). Compiled —
`node dist/main.js` from `apps/core` (cwd carries `.env`):

```
compiled API /health answered after ≈919ms: {"status":"degraded","db":"ok","worker":"stale"}
[Nest] ... Nest application successfully started
```

"Successfully started" is logged *after* every `onModuleInit` hook has run, so
`OpdRealtimeRegistrar` injected and registered — and `grep -c "design:paramtypes"
apps/core/dist/modules/opd/opd.module.js` returned `1`: `tsc` emitted the metadata esbuild does
not. (`"degraded"/"stale"` is correct: no worker was running, and the health controller degrades
rather than fails by design.)

Worker — `node dist/worker.js`:

```
worker started: jobs=runDispatchCycle,runDueTimers,sweepExpiredTempRoles,sweepGuardianMajority,sweepAppointmentNoShows,runDailyClose,runNotifyPump
```

Seven jobs, by name. Boot times measured: **compiled API ≈919ms to a served `/health`; compiled
worker ≈645ms to the started line; `tsx` worker ≈1069ms** (the `tsx` API cannot boot at all, so
that comparison does not exist — which is itself the §2.58 point).

**What T1 inherits beyond the happy path:** flipping contracts' `main` to `dist` affects every
*other* consumer of that field. Jest resolves packages through `main` too, so tests could silently
consume stale compiled contracts instead of source — the exact hazard rule 5 exists for, one level
up. *(Labelled: this risk is from reading, not from running — the suite was not run, per the spike's
ground rules.)* T1 must pick a mechanism (a jest `moduleNameMapper` pin to `src`, or flipping
`main` only inside the Docker build stage, or `exports` conditions) and prove the suite still reads
source.

## Question B — the partitioned recreate works (FORK-B = branch (i))

**Verdict: FORK-B = rename-and-recreate, in ONE transaction, first try.** Run against
`hmis_spike_part` (`createdb -U hmis -T hmis_dev hmis_spike_part` inside `hmis-db-1`; the only
`hmis_dev` connection beforehand was this spike's own probe psql, read and confirmed). Dropped
afterwards (`dropdb -U hmis hmis_spike_part`, confirmed gone).

The SQL that worked, verbatim (T2 starts from this; full file was `.spike/qb-convert.sql`):

```sql
BEGIN;
ALTER TABLE events RENAME TO events_old;
ALTER INDEX events_pkey RENAME TO events_old_pkey;
ALTER INDEX events_event_id_unique RENAME TO events_old_event_id_unique;
ALTER INDEX events_idempotency_key_idx RENAME TO events_old_idempotency_key_idx;
ALTER INDEX events_name_idx RENAME TO events_old_name_idx;
ALTER INDEX events_patient_idx RENAME TO events_old_patient_idx;
ALTER INDEX events_correlation_idx RENAME TO events_old_correlation_idx;

CREATE TABLE events (
  seq bigint NOT NULL DEFAULT nextval('events_seq_seq'::regclass),
  event_id text NOT NULL,
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  patient_id text,
  encounter_id text,
  correlation_id text,
  causation_id text,
  module text NOT NULL,
  payload jsonb NOT NULL,
  site_id text NOT NULL DEFAULT 'main',
  idempotency_key text,
  CONSTRAINT events_pkey PRIMARY KEY (seq, recorded_at),
  CONSTRAINT events_event_id_unique UNIQUE (event_id, recorded_at)
) PARTITION BY RANGE (recorded_at);

ALTER SEQUENCE events_seq_seq OWNED BY events.seq;   -- MUST precede the DROP below

CREATE TABLE events_default PARTITION OF events DEFAULT;
CREATE TABLE events_2026_08 PARTITION OF events
  FOR VALUES FROM ('2026-08-01T00:00:00+05:30') TO ('2026-09-01T00:00:00+05:30');
CREATE TABLE events_2026_09 PARTITION OF events
  FOR VALUES FROM ('2026-09-01T00:00:00+05:30') TO ('2026-10-01T00:00:00+05:30');

CREATE INDEX events_idempotency_key_idx ON events (idempotency_key);
CREATE INDEX events_name_idx ON events (name);
CREATE INDEX events_patient_idx ON events (patient_id);
CREATE INDEX events_correlation_idx ON events (correlation_id);

INSERT INTO events (seq, event_id, name, version, occurred_at, recorded_at, actor_type, actor_id,
                    patient_id, encounter_id, correlation_id, causation_id, module, payload,
                    site_id, idempotency_key)
SELECT seq, event_id, name, version, occurred_at, recorded_at, actor_type, actor_id,
       patient_id, encounter_id, correlation_id, causation_id, module, payload,
       site_id, idempotency_key
FROM events_old;

DROP TABLE events_old;
COMMIT;
```

Three landmines this SQL steps around, each measured:

- **`ALTER TABLE ... RENAME` does not rename indexes.** Creating the new table's `events_pkey`
  collides unless the old index names are moved first — hence the seven `ALTER INDEX RENAME`s.
- **`DROP TABLE` takes sequences OWNED BY its columns.** A control in the same session proved it:
  a toy `serial` table renamed and dropped printed `control: sequence DIED with the renamed table`.
  The `ALTER SEQUENCE ... OWNED BY events.seq` line must run *before* `DROP TABLE events_old`, or
  `bigserial` does not survive.
- **Copy by explicit column list** — a migrated database's physical column order is not the
  declaration order.

**`bigserial` survives.** `INSERT 0 15` copied every dev row, and three post-conversion inserts
returned `seq` 16, 17, 18 — the original sequence, continuing monotonically. `appendEvent`'s
`RETURNING seq` path was then exercised for real (below): gave 19, 20, 21. After a partition drop:
22. Rows route correctly by `tableoid`:

```
   partition    |   event_id    |         recorded_at
----------------+---------------+------------------------------
 events_2026_08 | spike-evt-aug | 2026-08-22 06:30:59.02821+00
 events_2026_09 | spike-evt-sep | 2026-09-15 04:30:00+00
 events_default | spike-evt-old | 2025-01-15 04:30:00+00
```

**The UNMODIFIED shipped dispatcher is green against the partitioned table.** A tsx probe imported
the real `appendEvent`, `SubscriptionBus`, `runDispatchCycle`, appended three `spike.dispatch_test`
events and ran two cycles:

```
appendEvent RETURNING seq gave: 19,20,21
cycle 1 delivered=3 seqs=[19,20,21]
cycle 2 delivered=0 (expect 0: claims resolved)
cursor after: [{"consumer":"spike_probe","last_seq":"21"}]
DISPATCHER GREEN against partitioned events
```

**The floor predicate prunes — at plan time.** The dispatcher's window query verbatim,
`EXPLAIN (ANALYZE, BUFFERS)`, without and with `and e.recorded_at >= '2026-09-01T00:00:00+05:30'`:
without the floor, the Append node scans **all three** partitions (`events_2026_08`,
`events_2026_09`, `events_default` all present with index scans). With it, `events_2026_08` is
**absent from the plan entirely** (pruned at plan time, not "never executed"):

```
->  Append  (cost=0.14..16.35 rows=2 width=176) ...
      ->  Index Scan using events_2026_09_name_idx on events_2026_09 e_1 ...
      ->  Index Scan using events_default_name_idx on events_default e_2 ...
```

**But note: the DEFAULT partition is never pruned by the floor** — it can hold rows of any month,
so the planner must keep it. Consequence for T2/D5: the pre-created-months job is not a
convenience; keeping `events_default` near-empty is what keeps the floor predicate meaningful.

**Partition drop = the retention mechanism, and what it leaves behind.** Dropping
`events_2026_08` (which held the three idempotency-keyed probe events): events 21 → 2, and:

```
idem_before=3   deliveries_before=3
DROP TABLE
idem_after_orphaned=3   deliveries_after_orphaned=3
```

`event_idempotency` and `event_deliveries` rows **survive as orphans** — the side-table design
holds (no FK anywhere: `event_idempotency` has only its PK, verified from `pg_constraint`), nothing
blocks or cascades, and the drop is instant. But see "what the plan does not know" below: retention
by partition drop silently moves the growth problem into the two side tables.

**Can drizzle express this? No** *(labelled: from reading, not running — see §2.60 section)*.
T2's task body should say: hand-written SQL inside a generated migration file (`0016` is next:
`drizzle/` currently ends at `0015_previous_shiver_man.sql`).

## Question C — pgBackRest completes a real restore (FORK-C = in the Postgres image)

**Verdict: FORK-C = placement (i), pgBackRest inside the Postgres container image — and the
"least coupling" question dissolved under measurement: WAL archiving gives you no choice.**
`archive_command` executes inside the postgres server's container. Booted with
`archive_command='pgbackrest ... archive-push %p'` and no binary installed, the archiver fails
FATAL (control, from `docker logs`):

```
FATAL:  archive command failed with exit code 127
DETAIL:  The failed archive command was: pgbackrest --stanza=spike archive-push pg_wal/000000010000000000000001
```

So a sidecar (ii) or host placement (iii) **cannot do continuous WAL archiving at all** unless the
postgres image carries the binary anyway — at which point the sidecar is decoration. The restore
side has the same shape: the restored cluster replays WAL through `restore_command`, which is also
pgbackrest, also inside whatever container boots the restored PGDATA. T4 therefore builds a
postgres image with pgBackRest installed (a two-line Dockerfile layer on `postgres:16`); the repo
and spool live on volumes, which is where the *destination* flexibility (SFTP, D4) belongs.
Placement (iii) was probed only as far as availability (`apt-cache policy pgbackrest` on the host:
candidate 2.58.0-1, not installed) and not pursued: it loses on the same archive_command fact.

The drill itself, on a 1000-row / 78 MB cluster in the throwaway `hmis-spike` project
(`postgres:16` + `apt-get install pgbackrest` → 2.59.1):

```
stanza-create command end: completed successfully (24ms)
check command end: completed successfully (1125ms)
archived_count=4  failed_count=6  last_archived_wal=000000010000000000000004
full backup took 3s
incr backup took 2s          (after 500 more rows + a sentinel row)
repo 13M   PGDATA 111M      (restore size = 29.6MB, file total = 1271)
restore command end: completed successfully (1865ms)  → restore took 2s
```

(the `failed_count=6` is the pre-install control still visible in `pg_stat_archiver` — the
measurement fossilised.) **The restore was verified by booting a second postmaster on the restored
directory** (`pg_ctl -D /restore -o "-p 5601 -c archive_mode=off"` inside the same container) and
querying it:

```
select count(*) from drill;                          → 2002
select note from drill where note='SENTINEL...';     → SENTINEL-AFTER-FULL
```

2002 = 1000 + 501 written before the (failed-first) incr attempt + 501 after — i.e. the restore
replayed archived WAL to the end, past the last backup. A backup that has been restored, counted,
and sentinel-checked.

**Two findings T4 must carry:**

1. **`POSTGRES_USER=hmis` breaks pgBackRest's defaults.** First stanza-create failed:
   `FATAL: role "postgres" does not exist` → `ERROR: [056]: unable to find primary cluster`.
   The docker entrypoint creates the superuser named by `POSTGRES_USER`; pgBackRest connects as
   the OS user. Fix measured: `pg1-user=hmis` (here `pg1-user=spike`) in `pgbackrest.conf`.
   The dev compose uses `POSTGRES_USER: hmis`, so production will hit exactly this.
2. **Retention must be configured**: every backup printed
   `option 'repo1-retention-archive' is not set - archive logs will not be expired`. Unset, the
   repo grows without bound — the same class of problem D6/D7 exist for.

**The SFTP leg is UNTESTED.** No SFTP destination was available to this spike; the repo was a
local volume. pgBackRest 2.59.1's help does list the SFTP repo options (`--repo-sftp-host-user`
observed in executed `pgbackrest help` output), so the capability exists in the shipped binary,
but no byte travelled over SFTP here and T4 should treat that leg as unproven.

## Question D — the monitoring stack costs ~0.6% of the box (FORK-D = same box)

**Verdict: FORK-D = same box, by an order of magnitude.** Prometheus v2.53 + Grafana 11.1 +
node_exporter v1.8.1 + postgres_exporter v0.15.0, host-network on loopback high ports, settled
60s after both targets were up:

```
hmis-spike-prometheus     cpu=0.00%  mem=26.77MiB / 15.24GiB
hmis-spike-grafana        cpu=0.05%  mem=48.47MiB / 15.24GiB
hmis-spike-node-exporter  cpu=0.00%  mem=8.242MiB / 15.24GiB
hmis-spike-pg-exporter    cpu=0.00%  mem=12.55MiB / 15.24GiB
```

**Total ≈ 96 MiB resident, ≈0% CPU idle — ~0.6% of a 16 GB CX43**, against the 15% branch
threshold. (Idle numbers on a quiet box; a year of TSDB and real dashboards grow Prometheus, but
not by two orders of magnitude.) Endpoints: prometheus `/-/ready` 200; grafana `/api/health`
`{"database":"ok","version":"11.1.0"}`; both scrape targets `up` on the first pass.

**The heartbeat-staleness rule reads shipped data — verified through the exporter, not just psql.**
postgres_exporter with a custom query file (`PG_EXPORTER_EXTEND_QUERY_PATH`) against
`hmis-db-1`'s `hmis_dev`:

```
# TYPE hmis_scheduler_heartbeat_staleness_seconds gauge
hmis_scheduler_heartbeat_staleness_seconds{job="runDispatchCycle",server="127.0.0.1:5433"} 26551.42
hmis_scheduler_heartbeat_staleness_seconds{job="runDueTimers",...} 26561.49
hmis_scheduler_heartbeat_staleness_seconds{job="runNotifyPump",...} 26551.47
hmis_scheduler_heartbeat_staleness_seconds{job="sweepExpiredTempRoles",...} 26581.49
hmis_scheduler_heartbeat_staleness_seconds{job="sweepGuardianMajority",...} 26611.49
```

Real staleness (~7.4h — the dev worker was last run the previous evening), real per-job labels,
no new instrumentation. **But note the row count: five, not seven.** `scheduler_heartbeats` only
has rows for jobs that have started at least once (`runDailyClose` and `sweepAppointmentNoShows`
absent here). T6's alert rule must treat a **missing** series as alertable, not just a stale one —
`absent()` or a join against the expected-jobs list — or a worker that never manages to start a
job would never alert.

## Question E — the WebSocket upgrade survives Caddy (flag ④ discharged)

**Verdict: a bare `reverse_proxy` is sufficient. Nothing extra is needed for the upgrade.**
The Caddyfile that worked, verbatim (T3 starts here; production adds a hostname for auto-HTTPS):

```
{
	auto_https off
}

http://:8091 {
	reverse_proxy 127.0.0.1:3000
}
```

(`caddy:2`, host network, high port — 80/443 are owner-reserved on this box.) Against the
compiled API from Question A:

- `/health` through Caddy: `{"status":"degraded","db":"ok","worker":"stale"}`, `http_code=200`.
- WebSocket through Caddy, raw `node:http` probe so the status line is observed, not inferred:

```
UPGRADE: HTTP 101 Switching Protocols
  sec-websocket-accept: 1J8DTiIKDPUqTwUBAFGD0IexVWo=
  TEXT FRAME: {"type":"error","code":"auth_timeout"}
  CLOSE FRAME: code=4001 reason=auth_timeout
```

The upgrade completes, and what the gateway then does is its own auth protocol: the probe sent no
auth message, the gateway's timer fired, sent the error frame and closed **4001 auth_timeout** —
an auth-rejection close over a completed, proxied, bidirectional connection (server-to-client
frames traversed Caddy). Control direct to `:3000`: byte-identical behaviour
(`sec-websocket-accept` differs per nonce, as it must). Control on a wrong path through Caddy:
`NO UPGRADE: plain HTTP 502` — the gateway destroys non-`/ws` upgrade sockets and Caddy reports
the dead upstream as 502.

---

## What the plan does not know (the section that earns the spike)

1. **The blocker FORK-A actually had:** `@hmis/contracts` `"main": "./src/index.ts"`. Runtime code
   in `node` cannot load it; the fix (main → `dist/index.js` + a contracts build) must be part of
   T1, and T1 must decide how jest keeps resolving contracts *source* afterwards (risk labelled
   under §2.60 below). The plan's suspected obstacle — `NodeNext` semantics — produced zero
   friction, because `apps/core` is a CJS package.
2. **The DEFAULT partition is never pruned by the floor predicate.** The plan's D5 treats
   pre-created months as hygiene; measurement shows they are what keeps the floor useful, because
   `events_default` is in every plan regardless.
3. **Retention by partition drop orphans `event_idempotency` and `event_deliveries` rows** (3 of
   each survived the drop, measured). D6's retention task needs either companion sweeps for both
   side tables or an explicit decision to keep orphans. Nobody owns this today — D7 covers only
   `notifications`.
4. **The sequence-ownership landmine in T2's migration:** `DROP TABLE events_old` silently drops
   `events_seq_seq` unless `ALTER SEQUENCE ... OWNED BY events.seq` runs first (control executed:
   the toy sequence died). Get the order wrong and the migration destroys `seq` allocation.
5. **`pg1-user`:** pgBackRest's defaults assume a `postgres` role; this project's composes create
   `hmis` instead. One config line, measured — but a T4 that copies upstream examples verbatim will
   fail its stanza-create, and `repo1-retention-*` must be set or the repo grows forever.
6. **The staleness alert has a missing-row blind spot:** `scheduler_heartbeats` holds 5 rows for
   7 jobs on this dev database. Alerting only on staleness of *existing* rows misses a job that
   has never started.
7. **Boot-time economics are a non-issue:** compiled API serves `/health` in ~0.9s, worker starts
   in ~0.65s (faster than `tsx`'s ~1.07s). No FORK-A tiebreaker needed from performance.
8. **Pre-existing residue, not created and not touched by this spike:** a database
   `hmis_spike85_1` exists on `hmis-db-1` (visibly the 08.5 spike's; owner may want to drop it),
   and the two orphaned wait-loop shells (PIDs 3501080, 3502071) were still spinning throughout.

## Claims made from READING rather than RUNNING (§2.60)

- **"Drizzle cannot express `PARTITION BY`."** Basis: zero hits for `partition by` in
  `drizzle-kit`'s `bin.cjs` (grep executed on the server, count 0) and no partitioning API in
  `drizzle-orm/pg-core`'s type declarations. `drizzle-kit generate` was **not** run against a
  partitioned schema definition, because no such definition can be written in the schema DSL to
  begin with. T2 should still expect the *snapshot* side to need care (the generated snapshot will
  describe a table drizzle did not create).
- **"Flipping contracts' `main` to `dist` may make jest resolve stale compiled contracts."**
  Reasoned from jest's resolution rules; the suite was not run in this spike (ground rule: no full
  suite). T1 must prove it either way.
- **"The SFTP repo type exists in pgBackRest 2.59.1"** — from executed `pgbackrest help` output
  listing the SFTP options; the SFTP transfer itself is untested here.
- **Partition month boundaries were written in IST (`+05:30`)** on the strength of the retention
  unit being an IST concept (`dailyIst` jobs, Indian statute). Pruning was measured to work with
  IST bounds and an IST floor literal; the *choice* of timezone for boundaries is the plan's to
  pin, and T2 should state it explicitly.

## Host end-state (all measured after cleanup)

- `git status --porcelain` on the server: **empty**, on `main`, up to date with `origin/main` at
  `f16aff1242be0b9a818f5e3154c8b0265f00f264` (origin moved during the spike — an owner docs commit
  landed and was taken by `git pull --rebase` per rule 11). Throwaway branch `spike/11a` deleted
  (tip was `b488d6f`, one commit: the contracts `main` flip; nothing from it touched `main`).
- Containers: `docker ps -a` → **`hmis-db-1` only**. Volumes: `docker volume ls` →
  **`hmis_hmis_pgdata` only**. The `hmis-spike` project (six containers over the spike's course)
  and its five volumes removed by `docker compose -p hmis-spike down --volumes`; the five images
  this spike pulled (`caddy:2`, `prom/prometheus:v2.53.0`, `grafana/grafana:11.1.0`,
  `prom/node-exporter:v1.8.1`, `prometheuscommunity/postgres-exporter:v0.15.0`) removed by
  explicit name. No prune of any kind was run.
- Databases: `hmis_spike_part` **dropped** (created with `createdb -T hmis_dev`, used for all of
  Question B, dropped the same session; confirmed absent from `pg_database`). `hmis_dev` intact —
  `select count(*) from events` → **15**, exactly the pre-spike count. `hmis_test_*` untouched.
  (`hmis_spike85_1` pre-existed this spike and was left alone.)
- Processes: `pgrep -af "dist/main.js|dist/worker.js|tsx src"` matched **only its own compound
  shell** (line read, per rule 20). Every API/worker this spike started was killed by PID.
- Scratch: `/opt/hmis/.spike/` and both `dist/` trees deleted (`find -delete`); both
  `tsconfig.build.json` files deleted; no `*.mutant.*`, `.log`, or `.exit` residue under
  `/opt/hmis`. The local mirror remains in the session scratchpad per rule 22(f).
- No migration was generated or applied to any database this spike did not create and drop
  (AGENT-RULES §6: nothing irreversible happened outside `hmis_spike_part` and the `hmis-spike`
  compose project, both destroyed).
