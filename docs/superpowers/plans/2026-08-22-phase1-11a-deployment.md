# Phase 1 / Plan 11a — Deployment: the production build, the shared box, partitioned events, and a restore that has actually been run · Implementation Plan

> **For agentic workers:** this plan is design law for the pipeline that executes it (EXECUTE-METHOD
> v2). Every agent reads [`AGENT-RULES.md`](../AGENT-RULES.md) and this document, nothing else.
> First draft 2026-08-22 at `9caa915`; **rewritten the same day at `f16aff1` after the owner
> brainstorm (eight rulings below) and the spike.** **No pipeline is compiled and nothing is
> executed by the session that wrote this** — that separation is deliberate and has paid three times.

> **STATUS: FINAL — ALL FOUR FORKS RESOLVED BY MEASUREMENT; AWAITING COMPILE BY A FRESH SESSION.**
> Spike brief: [`2026-08-22-phase1-11a-spike-brief.md`](2026-08-22-phase1-11a-spike-brief.md)
> (amended at `ffcd24c`: five questions A–E); **spike report:
> [`reports/plan-11a-spike-report.md`](reports/plan-11a-spike-report.md), committed `ca14f46`** —
> the measured basis for every FORK verdict below, resolved in place per §2.48. Verdicts in one
> line: **A = COMPILED · B = rename-and-recreate in one transaction · C = pgBackRest in the
> Postgres image (the fork dissolved: `archive_command` runs inside that container) · D = same
> box (~96 MiB ≈ 0.6% of it) · E (flag ④) = discharged, bare `reverse_proxy` suffices.**
> Execute-handoff prompt: `reports/PLAN-11A-EXECUTE-PROMPT-2026-08-22.md`.

## Why this plan has a spike when Plan 10 did not

Plan 10 skipped its spike correctly: every mechanism it used was already shipped and measured.
**11a is the opposite — almost nothing in it has ever been executed in this repository:**

- **No Dockerfile has ever existed here** (verified again at `f16aff1`).
- **`apps/core` has no `build` script.** There has never been compiled output. Both processes run
  through `tsx`, a dev transpiler — and the documented dev command has been broken since Plan 07
  (§2.58).
- **No production compose exists.** `docker/` holds the dev Postgres and an initdb script.
- **pgBackRest has never run against this database.**
- **No partitioned recreate has been attempted**, and it is an irreversible table rewrite.
- **Nothing has ever run behind Caddy**, including the WebSocket upgrade the realtime gateway needs.

EXECUTE-METHOD §1's rule applies exactly: *every verify-by-execution flag is an admission that we
wrote something we could not check.* The spike ran the same day (196,538 tokens against a ~50k
target — a calibration point for future spike budgets, and it answered all five questions with
controls; report `ca14f46`), and every fork below is resolved against its measurements.

---

## Owner rulings this plan encodes (2026-08-22, in conversation — two sessions)

**From the staging ruling (spec v4.7 §1, roadmap "Deployment topology" RESOLVED):**

1. **Deployment is STAGED.** Stage 1 (now): ONE Hetzner cloud box, no standby — this plan's
   target. Stage 2 (after Phase-1 UAT): live pilot as the secondary HMIS beside the incumbent,
   then hybrid — Plan 11b. Stage 3: fully on-prem, exactly as spec §1 line 21 says. **Spec §1 is
   not superseded; the destination stopped being the starting line.** The binding consequence:
   **nothing may be built that makes stage 3 expensive** (D4).

**From the 2026-08-22 brainstorm (this plan's writing session):**

2. **Stage-1 production SHARES the build host** (`62.238.106.231`, Hetzner CX43, 8 vCPU / 16 GB /
   160 GB). The separate-VM recommendation was put to the owner with the contention argument; the
   owner accepted the risk. The guardrails are structural, not luck: D13's `hmis-prod` compose
   project (rule 7 amended at `f16aff1`), its own Postgres container and volumes, its own port
   range, resource limits, and the accepted failure mode documented in the runbook.
3. **The backup destination is Cloudflare R2** over the S3 protocol (pgBackRest `repo-type=s3`).
   Chosen over a Hetzner Storage Box for the maturity of pgBackRest's S3 backend, zero egress on
   the weekly restore drill, and near-zero cost at current database size. **D4 survives**: S3 is
   an API with self-hostable implementations — at stage 3 the hospital NAS runs MinIO and the
   repo re-points an endpoint and credentials, no rewrite. Repo-level encryption is client-side;
   R2 only ever sees ciphertext.
4. **A hostname now**: the owner points a subdomain they already control at the box; Caddy does
   automatic HTTPS from day one. The real product domain (name still undecided — roadmap) re-points
   later in one Caddyfile line. No self-signed certs in front of UAT users.
5. **Remediation first**: Plan 10's two booked MAJORs (the unpinned suppression-gauntlet order;
   the dead `NOTIFY_STUCK_AFTER_MS` key) plus the `ci-watch.sh` stall (§2.63) land as **Phase 0**,
   before the pipeline compiles — the pipeline itself needs a working CI watch.
6. **Retention values are counsel's**: the owner starts the counsel engagement now; the mechanism
   ships inert (`RETENTION_ENABLED=false`, D6) and the signed values flip it whenever they land.
7. **The PRE-PILOT gate work starts now**, bundled into the same counsel engagement: the DPDP
   posture for real patient data on a cloud host outside India (spec §19 v4.7), plus E-11's
   transition-operations boundary map (owner/ops, in parallel).
8. **The 11a/11c boundary stands as drafted.** 11a = it deploys, it survives, it does not grow
   forever. 11c = operating modes, downtime kit, interface heartbeats, D-17 gate wiring — any time
   after 11a, before go-live.

**Owner cleanup preconditions surfaced by this session's measurement (execute-prerequisites §):**
the InsForge removal missed a host-level layer — an **enabled, active nginx** still serves the dead
`cc.elar.club` site (proxy to freed port 7130) and **holds 80/443**, which production Caddy needs;
the two orphaned self-matching wait-loop shells (PIDs `3501080`/`3502071`) are still spinning. Both
cleanups are the owner's, before the pipeline runs.

---

## Design (the decisions this plan makes — read before the tasks)

### D1. Two processes, not four — and the missing two are named, not skipped

Spec §2 v4.3 says *api · ws hub · worker · renderer*. **Measured: there are two.** `main.ts` boots
one Nest HTTP app whose `AppModule` imports `RealtimeModule` (the WS gateway and the event tail
live inside the API process); `worker.ts` boots a providers-only application context running the
Scheduler's **seven** jobs (nine after this plan — D5, D6).

11a ships **api + worker**, and says why the other two are absent:

- **The renderer cannot be split out because it does not exist.** Zero PDF code anywhere in
  `apps/` (measured). It arrives with the first real PDF surface; D3's shape makes it a compose
  entry when it does.
- **The WS hub stays inside the API.** At ~20 concurrent users on one box a split buys nothing
  measurable; the seam that makes it cheap later is already there (`tail.ts` is a distinct cursor
  from the dispatcher, deliberately), and D3 means a third process is a compose entry, not a
  refactor.

### D2. FORK-A RESOLVED — production runs COMPILED output *(spike question A, measured)*

> **RESOLVED — COMPILED won; read the rest of this section as measurement, not choice.** The
> `tsx`-in-production branch is **dead**: compiled output boots BOTH processes with **zero source
> edits** (API served `/health` in ≈919 ms; worker logged all seven jobs in ≈645 ms — faster than
> `tsx`'s ≈1069 ms), `tsc` emitted `design:paramtypes` (grep count 1 in the compiled opd module),
> and the control run proved **§2.58 is fixed as a by-product**: `tsx src/main.ts` still crashes
> at `OpdRealtimeRegistrar.onModuleInit` while `node dist/main.js` starts clean. T6's README
> section documents the compiled commands as the production truth.

**The obstacle the fork predicted was NOT the obstacle that exists** — recorded because the plan's
own reasoning was wrong in an instructive way: `apps/core` is a CJS package, so `NodeNext` emitted
plain CommonJS and produced **zero friction**. The real blocker (spike finding 1):
**`@hmis/contracts`' `"main": "./src/index.ts"`** — `tsx` transpiles that on the fly; plain `node`
cannot load it at all. The measured fix, all of it: two 12-line `tsconfig.build.json` files
(contracts + core: extends the package tsconfig, `outDir: dist`, `rootDir: src`, excludes tests,
`noEmit: false`) and **one line in `packages/contracts/package.json`** (`main` →
`./dist/index.js`, `types` staying on `./src/index.ts`).

**What T1 inherits with the win (spike §2.60-labelled risk, T1 must prove it):** jest also
resolves packages through `main`, so the flip risks the suite silently consuming **stale compiled
contracts** instead of source — rule 5's hazard one level up. T1 picks the mechanism (a jest
`moduleNameMapper` pin to contracts source, flipping `main` only inside the Docker build stage, or
`exports` conditions) and **proves the suite still reads source** — an acceptance criterion, not a
note.

**Build mechanics, measured + one authoring fact:** the spike's build shape is the starting point
(`pnpm exec tsc -p tsconfig.build.json` per package; contracts ≈1.4 s, core ≈9.3 s; no stray emit —
rule 5 checked). `apps/core/tsconfig.json`'s `include` omits `scripts/`, and the spike's
`rootDir: src` keeps it out — but production migrations run `scripts/migrate.ts`. T1 settles the
migration entrypoint (a second small tsc pass over `scripts/`, or a compiled entry under `src/`)
and the runtime image carries `drizzle/*.sql` + `drizzle/meta/` for the migrator. **The deploy
step runs migrations from inside the image against the production database** (D13) — never from
the build checkout.

### D3. One image, several entrypoints — this IS the spec's "one codebase, several processes"

A single build artefact; the process is chosen by the container's command. Adding the ws hub or
the renderer later is a compose entry plus an entrypoint file, never a second pipeline. The web
SPA is built in the same multi-stage Dockerfile and baked into the Caddy image's static root —
`vite.config.ts:13` already says production serving is Caddy, and the SPA calls same-origin paths.

### D4. PORTABILITY IS A GLOBAL CONSTRAINT, NOT A PREFERENCE (stage 3, spec §1 v4.7)

No provider-specific primitive in the deployable: no cloud load balancer, no cloud volume as a
hard dependency, no cloud DNS API, no cloud secrets manager. The stack stands up from **Compose +
Caddy + Postgres + pgBackRest on any capable metal**. The two permitted externals are
**protocol-shaped**: a backup destination speaking S3 (ruling 3 — stage 3 re-points at MinIO on
the NAS) and DNS pointing a name at a box. **The test any task can be failed on:** *if the
on-prem box were racked tomorrow, what in this diff would have to be REWRITTEN rather than
RE-POINTED? Nothing.*

### D5. Events partitioning: monthly on `recorded_at`, per the 2026-08-12 resolved decision

Transcribed from `kernel/db/schema/events.ts` at `f16aff1`: `seq bigserial PRIMARY KEY` ·
`event_id text NOT NULL UNIQUE` · `recorded_at timestamptz NOT NULL DEFAULT now()` · four plain
indexes — the idempotency index is already **plain, not unique**, with a comment saying uniqueness
lives in `event_idempotency` *"so it survives partitioning"*. The groundwork was laid on
2026-08-12; this plan collects it:

- PK `seq` → **`(seq, recorded_at)`**; `event_id` UNIQUE → **`(event_id, recorded_at)`** (ULIDs
  are unique by construction; semantic dedup lives in the non-partitioned `event_idempotency`).
- A **DEFAULT partition** plus months pre-created ahead.
- **The dispatcher gains ONE predicate.** `dispatcher.ts:138` says, in as many words: *"ONE WHERE
  CHAIN (Global Constraint 7) so Plan 11's partition floor is one added predicate"* — and the
  lookback docstring at :16-20 names the structural fix this floor completes. The floor:
  `recorded_at >= date_trunc('month', recorded_at-of-cursor's-seq)`, with a missing cursor row
  (cursor 0, or a dropped month) degrading to no floor — pruning is an optimization; the seq
  predicate still bounds correctness. Month truncation absorbs seq/recorded_at skew
  (`recorded_at` is transaction-start time). **The claim, the cursor arithmetic (`greatest`), the
  backoff, and the LEFT JOIN stay byte-identical** (GC4).
- The monthly creation job is **`createEventPartitions`, a `Scheduler` `dailyIst` job** (code
  constant `CREATE_EVENT_PARTITIONS_IST = "00:15"`, beside the existing three in `jobs.ts:18-20`),
  idempotent create-if-not-exists for the next 3 months. ~~pg-boss~~ is dead (08.5 FORK-B).
- **A schema fact that makes the recreate smaller than it looks (found at authoring):**
  `schema/worker.ts:3-8` records that `event_deliveries` and `event_dead_letters` carry **no FK to
  `events.seq` precisely so this recreate would not weld them to it.** The conversion touches one
  table.

**FORK-B RESOLVED — rename-and-recreate, in ONE transaction, first try** *(spike question B,
against a `createdb -T` copy of the dev database, dropped after)*. Branch (ii)
create-empty-and-cut-over is **dead** — never needed. **T2 starts from the spike report's verbatim
SQL** (`reports/plan-11a-spike-report.md`, Question B), which steps around three measured
landmines any rewrite must preserve:

1. **`ALTER TABLE … RENAME` does not rename indexes** — the seven `ALTER INDEX RENAME`s must
   precede the new table or `events_pkey` collides.
2. **`DROP TABLE events_old` takes the sequence with it** unless
   `ALTER SEQUENCE events_seq_seq OWNED BY events.seq` runs FIRST (control executed: the toy
   sequence died with its renamed table). Get the order wrong and the migration destroys `seq`
   allocation.
3. **Copy by explicit column list** — a migrated database's physical column order is not the
   declaration order.

Measured with it: `bigserial` survives (seq 16→22 monotone across the conversion, `appendEvent`'s
`RETURNING seq` live); the **unmodified** shipped dispatcher delivered 3-then-0 against the
partitioned table; the floor predicate prunes **at plan time** (the out-of-floor partition absent
from `EXPLAIN` entirely). **Drizzle cannot express any of it** *(read-based, labelled in the
report: zero `partition by` hits in drizzle-kit, no partitioning API in pg-core)* — T2 hand-writes
the SQL inside the `0016` migration file (journal integrity preserved — never hand-edit
`_journal.json`) and expects the **snapshot** side to need care: the generated snapshot will
describe a table drizzle did not create.

**Two more measured facts that harden D5/D6:** the **DEFAULT partition is never pruned by the
floor** — it can hold any month, so the planner always keeps it; pre-created months are therefore
**load-bearing, not hygiene** (keeping `events_default` near-empty is what keeps the floor
meaningful), and `createEventPartitions` is the mechanism that does it. And **partition month
boundaries are pinned to IST (`+05:30`)** — the retention unit is an IST concept (`dailyIst`
jobs, Indian statute); the spike measured pruning working with IST bounds; T2 states the timezone
in the SQL explicitly. **This remains the single most dangerous task in the plan** — AGENT-RULES
§6 is an irreversible host mutation and `git checkout` does not undo it; the spike de-risked the
SQL, not the discipline.

### D6. Retention: the mechanism ships now, the VALUES are owner gates (ruling 6)

Deleting a clinical record is not a decision a plan makes. 11a ships:

- `retentionSweep` as a `Scheduler` `dailyIst` job (code constant
  `RETENTION_SWEEP_IST = "01:15"`) that **drops whole partitions**, never rows — that is the
  point of partitioning by the retention unit.
- **A legal hold that is checked structurally.** `retention_legal_holds` is a table (a hold is a
  row, not a config flag): id · `patient_id` nullable (null = a global hold) · reason NOT NULL ·
  `released_at` nullable · created_at/created_by. A partition whose month contains any event of a
  patient under an active hold — or any active global hold — is never dropped, and the refusal is
  evented (`retention.drop_blocked`).
- The window as **config with a conservative default** (`RETENTION_EVENTS_MONTHS`, default 120),
  and **`RETENTION_ENABLED` defaulting to false** — the mechanism ships inert and the owner flips
  it with a value counsel has signed (ruling 6). This is Plan 10 D9's shape (the promotional
  refusal) reused deliberately: structure exists, the dangerous half is off, a later decision
  flips it.
- Drops are evented (`retention.partition_dropped`), and the sweep **never touches the DEFAULT
  partition or the current/adjacent months** regardless of configuration.
- **The companion sweep the spike discovered nobody owned (finding 3, measured):** a partition
  drop **orphans** the side tables — 3 `event_idempotency` and 3 `event_deliveries` rows survived
  the spike's drop, by design (no FKs), silently moving the growth problem one table over. The
  same `retentionSweep`, behind the same gate and the same events window, therefore also deletes:
  `event_idempotency` rows by `recorded_at` · `event_deliveries` rows by `updated_at` **where
  status is `done` or `parked` — a `retrying` row is never touched at any age** (D7's
  queued/sending immunity, mirrored) · `event_dead_letters` rows by `parked_at`. Counts are
  evented once per run (`retention.side_tables_pruned`). Stated consequence, accepted: deleting an
  idempotency row older than the window re-opens semantic dedup for a key whose event no longer
  exists — consistent, and said out loud.

**Assertion Book V5/V6/V12 enforce that a held month cannot be dropped, that disabled means inert,
and that the companion sweep respects the window and the `retrying` immunity.** A polite pass is
the worst outcome on this surface.

### D7. `notifications` retention — the outbox that never pruned

Plan 10 shipped an outbox that gains a row per would-be message and never prunes (~10⁶ rows/year
at target volume, plus params jsonb). Terminal rows (`sent` · `expired` · `suppressed` ·
`undeliverable`) older than `NOTIFY_RETAIN_DAYS` (default 180) are deleted in bounded batches by
the same `retentionSweep` job — **`queued` and `sending` are never touched at any age** (V7): a
`sending` row is the only record that a message may already be with a patient. The prune predicate
gets its index (`(status, updated_at)`, riding migration 0016). Prunes are evented with a count,
not per row (`retention.notifications_pruned`).

**And the config must demonstrably take effect (§2.60(a), the `NOTIFY_STUCK_AFTER_MS` scar):**
V9's mutant is the registration dropping the values — the exact defect Phase 0 R2 fixes one
surface over.

### D8. Backups: pgBackRest to Cloudflare R2, and the drill is the DR story

On a single server, backups are not one layer of defence — **they are the only one.** Stage 1 has
no standby, no promotion, no fencing (all 11b).

- **pgBackRest**: continuous WAL archiving + nightly fulls, `repo-cipher-type=aes-256-cbc` (repo
  encryption, spec E-2 — R2 sees ciphertext only), `repo-type=s3` pointed at R2 (ruling 3).
  Credentials live in `/opt/hmis-prod` config (D13), never in git, never in the image.
- **FORK-C RESOLVED — pgBackRest lives INSIDE the Postgres image, and the fork dissolved under
  measurement** *(spike question C)*: `archive_command` executes inside the postgres server's
  container — booted without the binary it fails `FATAL … exit code 127` (control quoted in the
  report) — so the sidecar and host placements **cannot do continuous WAL archiving at all**, and
  `restore_command` has the same shape. Both losing branches are **dead on a measured fact, not a
  preference.** T4 builds a small derived image (`docker/prod/db.Dockerfile`: `postgres:16` + the
  pgbackrest package); the repo and spool live on volumes, which is where the destination
  flexibility D4 wants actually belongs. The spike's full drill on 78 MB: full 3 s · incr 2 s ·
  **restore 2 s, verified by a second postmaster reading 2002 rows + the sentinel** — WAL replayed
  past the last backup.
- **Two measured config facts T4 must carry** (spike findings 5): `POSTGRES_USER=hmis` breaks
  pgBackRest's defaults — `pg1-user=hmis` is required in `pgbackrest.conf` or stanza-create fails
  `role "postgres" does not exist`; and **`repo1-retention-full` / `repo1-retention-archive` must
  be set** or the repo grows without bound (every spike backup printed the warning) — the same
  problem class D6/D7 exist for, one layer down.
- **The spike's repo was a local volume; no byte travelled remotely.** T4's drill against the
  owner's real R2 bucket is the **first** remote proof, and the task halts rather than shipping
  an untested remote leg (execute-prerequisite 4).

- **THE AUTOMATED WEEKLY RESTORE DRILL IS NOT OPTIONAL AND IT IS NOT A `--dry-run`.** It restores
  into a scratch database, runs the migrator's own consistency check, asserts a row count and a
  known event id, appends `backup.drill_passed` / `backup.drill_failed` (events, so the owner's
  existing surfaces see them), and drops the scratch database. **A backup nobody has restored is
  a belief, not a backup.** RPO/RTO are stated honestly in the runbook for a single box: RPO ≈
  the WAL-push interval; RTO ≈ measured restore time + bring-up — not §12's <15 min, which
  assumes a standby.

### D9. Monitoring: Prometheus + Grafana on the shared box, Loki deferred, sizing measured

Spec §5 names Grafana + Prometheus + Loki. 11a ships **Prometheus + Grafana + node_exporter +
postgres_exporter** in the `hmis-prod` project, a provisioned dashboard, and the
**heartbeat-staleness alert rule** (reads the shipped `scheduler_heartbeats` — worker liveness is
its heartbeat row, D12). **Loki is deferred to stage 2** with the reason written down: on one box,
`docker compose logs` and journald are the log story; aggregation earns its cost with a second
machine. Grafana and Prometheus bind `127.0.0.1` high ports (SSH tunnel; a Caddy route is a later
nicety — Decisions §), so no new public surface ships.

**FORK-D RESOLVED — same box, by an order of magnitude** *(spike question D)*. The reduced stack
(Prometheus v2.53 + Grafana 11.1 + node_exporter + postgres_exporter) idles at **≈96 MiB resident,
≈0% CPU — ~0.6% of the CX43** against the 15% branch threshold. The off-box branch (the CAX21) and
the defer-Grafana branch are **dead**; a year of TSDB growth does not close a 25× margin. The
spike also proved the heartbeat gauge end to end: postgres_exporter with a custom query file
served `hmis_scheduler_heartbeat_staleness_seconds` with real per-job labels from the shipped
`scheduler_heartbeats` — no new instrumentation.

**And it found the alert's blind spot (spike finding 6):** the table held **5 rows for 7 jobs** —
a heartbeat row exists only once a job has ever started, so alerting on staleness of existing rows
misses a job that never starts. **T6's rule must treat a MISSING series as alertable** (an
expected-jobs count check beside the staleness threshold), or the alert is green precisely when
the worker is at its most broken.

### D10. First-boot cursor seeding — the step 08.5 booked and 10 re-booked

`event_cursors.last_seq` defaults to 0 and `runDispatchCycle` creates the row on first sight
(dispatcher.ts:130-136), so the first cycle after a consumer is registered walks the entire event
history at 100 rows/tick. Volume concern, not correctness (consumers are idempotent). 11a ships it
as **a deployment step with a script**: `scripts/seed-cursors.ts`, run by `deploy.sh` before the
worker first starts against a database with history, seeds every production consumer's cursor at
`max(seq)` — and **never lowers an existing cursor** (V11).

**The shipped precedent is `tail.ts:20`** — *"floor = max(seq) at start (history is never
replayed)"* — the tail solved this for itself on day one; the dispatcher's cursor is shared and
claiming, so seeding belongs in a deployment step, not in cursor-creation semantics (08.5's
deliberate refusal to pre-empt this stands). The consumer list comes from the one importable place
it exists: `workerConsumers(db)`'s keys (Plan 10 T5 built exactly this seam). Covers
`kernel.alerts` AND `kernel.notify` — for the latter it is defence in depth behind Plan 10's
send-time expiry, and the flood has never actually been observed (the dev DB holds no subscribed
events), so **the script's test seeds history first** (V10).

### D11. `SECRET_KEY`: generated in a ceremony, escrowed, never in the repo

Spec E-2. The production key is generated on the box (`openssl rand -hex 32`) into
`/opt/hmis-prod/.env`, `chmod 600`; the escrow procedure is a **printed runbook step** in T6's
README section. `.env.example`'s promise (*"the production key is generated and escrowed in Plan
11"*) is discharged here. **No secret enters git, no task may add one** — production `.env` lives
in `/opt/hmis-prod` (D13), outside the checkout entirely.

### D12. Health, readiness and restart policy

`health.controller.ts` ships `@Public() @Get("health")` reading db + freshest scheduler heartbeat
(`ok`/`stale`/`not_running`, degraded never down). Compose: `restart: unless-stopped` everywhere;
healthchecks — api via `/health`, db via `pg_isready`; **the worker deliberately has no compose
healthcheck** — it has no HTTP surface, its liveness is its heartbeat row, and that is what D9's
alert rule reads; a `pgrep`-style check would assert the wrong thing. Resource limits per service
(values from spike D's measurement), load-bearing under ruling 2, not hygiene.

### D13. The shared box, made survivable — `hmis-prod` beside the dev stack (ruling 2)

The architecture of coexistence, all of it structural:

- **Compose project `hmis-prod`** (top-level `name:` in the yml). Dev and production deliberately
  do not share a project name, so a `compose down`/`up` against one can never act on the other.
  Rule 7 (amended `f16aff1`) names it and protects its containers and volumes as production data.
- **`/opt/hmis-prod` is the deploy directory** — compose yml, Caddyfile, prometheus config,
  `.env` (chmod 600), pgBackRest config. `deploy.sh` copies configs there from the repo and runs
  `docker compose -p hmis-prod` against them, so a git operation in `/opt/hmis` can never mutate
  what production is running. **Rule 3 is amended alongside this plan** to name `/opt/hmis-prod`
  as the second writable path (deploy-script-managed; never scratch).
- **Port map, stated once:** dev Postgres 5433 (untouched) · prod Postgres `127.0.0.1:5434` ·
  Caddy 80/443 (owner clears nginx first — execute-prerequisite) · Grafana `127.0.0.1:3001` ·
  Prometheus `127.0.0.1:9090` · api and exporters compose-network-internal only.
- **Images are built from the checkout, run from the daemon** — production never executes from
  `/opt/hmis`'s working tree.
- **The deploy sequence** (`deploy.sh`, idempotent): build images → copy configs → `db` up →
  migrations from inside the image (D2) → `seed-cursors` (D10) → `api`/`worker`/`caddy` up →
  `/health` through Caddy green.
- **The accepted failure mode, documented not hidden:** a pipeline run on the dev side can
  contend with a live UAT session for CPU/IO. The runbook says so, names the symptom (latency,
  never data), and the resource limits bound it. The dev suite's databases (`hmis_test_<N>`) and
  the prod database are different containers, different volumes, different ports — a truncate
  cannot cross.

### D14. Caddy: TLS by hostname, the SPA, the API prefixes, and a parity pin

Caddy serves the built SPA as static files with an `index.html` fallback and reverse-proxies the
API path prefixes + `/ws` (WebSocket) to `api:3000`. **The upgrade needs nothing special — spike
question E measured it**: a bare `reverse_proxy` produced HTTP 101 through Caddy, the gateway then
ran its own auth protocol (auth_timeout frame, close 4001) over the proxied connection, the
direct-connection control behaved byte-identically, and a wrong-path upgrade came back 502. Flag
④ is discharged by that measurement and **re-proven** in T3's real bring-up over HTTPS. The
prefix list already exists in one place — `vite.config.ts`'s dev proxy (`/auth /patients
/approvals /workflow /health /opd /billing /alerts /ws`) — and the Caddyfile must mirror it
forever, which is a drift class §3.34 knows by name. **So
the parity is a test** (`apps/core/test/caddyfile-parity.test.ts`): parse both files, assert the
Caddyfile's proxy matchers equal the vite proxy keys. A future module adding a prefix breaks the
test until it adds the Caddy route — one enforcement point, not a convention. TLS: automatic via
the owner's hostname (ruling 4); HTTP→HTTPS redirect on; security headers set; no extra auth gate
in front of the app (Plan 02's auth is the gate; an IP allowlist is a Decisions § option the owner
can flip on in one Caddyfile line).

### D15. What this plan deliberately does NOT build

No replication, standby, promotion, fencing, watchdog (E-16), NAS, LUKS beyond the `SECRET_KEY`
ceremony — **all 11b, stage 2, second machine.** No ws-hub split, no renderer (D1 — triggers
named). No Loki (D9). No operating-mode service, downtime kit, `interface.down/.restored`
framework, D-17 gate wiring — **all 11c** (ruling 8). No CI changes: the deploy key cannot push
workflows; a task believing one is needed **stops and reports**. No provider adapters, no relay
(E-1 still open, blocks only the relay). No new npm dependency anywhere: **a `pnpm-lock.yaml`
diff in any task is a halt** — build tooling is `typescript` (already a devDependency) and
container images, not packages.

---

## Phase 0 — remediation BEFORE the pipeline (ruling 5; executed by the compile session, not this writer)

Three items, three commits, each verified on the build host before the pipeline compiles. R1 and
R2 are one opus agent (mutant work — fixture-discrimination routing); R3 the compile session does
itself.

**R0-1. Pin the suppression gauntlet's order** *(gate report §7.1 — MAJOR).* One test in
`apps/core/src/kernel/notify/pump.test.ts`: a patient **both deceased and phoneless** must yield
`suppressed` + `notification.suppressed(deceased)` + **zero `notification.failed`** + zero adapter
calls. Required-DIED mutant (Book R1): relocate the deceased stop past channel resolution — the
gate report's own executed mutant, which today turns a dead patient's family into a duty-manager
phone task. Shipped code is correct; only the pin is missing.
Commit: `test(core): pin the gauntlet order — deceased-and-phoneless suppresses, never desk-tasks`

**R0-2. Thread `NOTIFY_STUCK_AFTER_MS`** *(gate report §7.2 — MAJOR).* The key parses into
`cfg.notifyStuckAfterMs` and nothing reads it. Fix: widen the `JobIntervals` Pick
(`jobs.ts:68-79`) with `notifyStuckAfterMs`; the pump registration (`jobs.ts:148-152`) passes
`{ now, stuckAfterMs: intervals.notifyStuckAfterMs }`; **`CENSUS_INTERVALS`
(`scheduler.test.ts:196`) stops compiling until it carries the new key — that literal is in this
item's files list on purpose** (§2.65; the amendment-7 comment at `jobs.ts:74-77` predicts exactly
this). A wiring test (in `jobs.test.ts`) registers with a distinct value and asserts the pump
receives it (Book R2). Correct `pump.ts:54`'s comment (the "mirrors the zod default" duplicate).
Files: `jobs.ts` · `jobs.test.ts` · `scheduler.test.ts` · `pump.ts` (comment only).
Commit: `fix(core): thread NOTIFY_STUCK_AFTER_MS to the pump — the key an operator sets now takes effect`

**R0-3. `ci-watch.sh` stops stalling** *(§2.63).* (a) a sha the watcher cannot resolve after a
bounded number of sweeps is added to `seen` as UNRESOLVED and reported once, so one runless commit
(§2.62) never blocks every later one; (b) a heartbeat line per sweep — "checked N, latest `<sha>`
STATE" — so a stalled watcher is visible within one sweep. Validate against history: the log must
show T3's red (`b7546cf` att.1), `0f512c3` as UNRESOLVED-once, and green tips.
File: `docs/superpowers/pipelines/ci-watch.sh`.
Commit: `fix(pipelines): ci-watch marks unresolvable commits seen and heartbeats every sweep`

---

## Consumed shipped surfaces (transcribed from source at `f16aff1`, 2026-08-22, this session)

- **`events`** — `kernel/db/schema/events.ts`: `seq bigserial PK` :6 · `event_id` UNIQUE :7 ·
  `occurred_at NOT NULL` :10 · `recorded_at NOT NULL DEFAULT now()` :11 · idempotency index
  **plain** with the survives-partitioning comment :24-25 · name/patient/correlation indexes
  :26-28. T2 rewrites the shape (D5).
- **`event_idempotency`** — separate, non-partitioned; the 2026-08-12 side-table decision. Not
  modified.
- **`event_cursors`** — `kernel/db/schema/eventCursors.ts`: `consumer` PK, `last_seq bigint
  default 0`, `updated_at`. Seeded by D10's script; semantics untouched.
- **`event_deliveries` / `event_dead_letters`** — `kernel/db/schema/worker.ts:26-55`; **no FK to
  `events.seq`, by recorded design (:3-8), so the recreate does not touch them.**
- **`scheduler_heartbeats`** — `worker.ts:13-19`: `job` PK, `last_started_at NOT NULL`,
  `last_ok_at`, `last_error`, `last_duration_ms`. D9's alert rule and D12's health read it; not
  modified.
- **`runDispatchCycle`** — `kernel/events/dispatcher.ts:118`; cursor bootstrap :130-136; **the
  one-WHERE-chain window :141-153 with the floor's reserved slot named at :138 and :16-20**;
  in-loop backoff filter :170-173; claim-on-success :209-217; `greatest` cursor advance :224-229.
  **T2 adds ONE predicate to the window and one floor lookup; every other line byte-identical.**
- **`Scheduler`** — `kernel/worker/scheduler.ts`: `register(spec: EverySpec | DailyIstSpec)`,
  `start()`, `stop()`, `jobs()`. Not modified.
- **`registerAllJobs(scheduler, db, registry, consumers, intervals)`** — `kernel/worker/jobs.ts:104`;
  seven registrations; `dailyIst` clock instants are code constants :18-20; `JobIntervals` Pick
  :68-79 **with the amendment-7 warning that widening it is a type event**; reads no environment
  (:96-102, the B1 scar). T2 and T5 each add one `dailyIst` registration (no Pick change); Phase 0
  R0-2 and T5 widen the Pick (`notifyStuckAfterMs`; `retentionEnabled`,
  `retentionEventsMonths`, `notifyRetainDays`).
- **The job-name censuses (§2.65's files, named up front):** `kernel/worker/scheduler.test.ts` —
  `THE_SEVEN` :115, `CENSUS_INTERVALS` (a `JobIntervals` object literal) :196, `registerAllJobs`
  calls :246/:316, set-equality :253; `test/worker-runtime.e2e.test.ts` — `THE_SEVEN` :94,
  `jobs()` equality :358. **Every task that registers a job owns both files in its wave: R0-2
  (literal only), T2 (seven→eight), T5 (eight→nine) — sequential, carried forward in each brief.**
- **`workerConsumers(db)`** — `kernel/worker/worker.module.ts` (Plan 10 T5): the one importable
  production consumers map. D10's script enumerates its keys. Not modified.
- **`worker.ts`** — boots a providers-only context; `Scheduler(db, pool, pgLocks(pool),
  cfg.workerDailyTickMs)`; keep-alive interval; SIGTERM → `shutdownWorker`. Not modified (D2's
  container runs it as-is).
- **`main.ts` / `app.bootstrap.ts`** — `loadConfig()` → `NestFactory.create(AppModule,
  { bodyParser: false })` → `configureApp` (1 MB json parser — patient photos) →
  `enableShutdownHooks` → `listen(cfg.port)`. Not modified.
- **`health.controller.ts`** — `@Public() @Get()` on `Controller("health")`; worker staleness from
  the freshest heartbeat vs `workerStaleAfterMs`; `degraded` never `down`. Compose healthchecks
  and Caddy proxy it unauthenticated.
- **`config.ts`** — schema :34-63 (every worker/notify key defaulted — the B1 scar comment :57-59);
  `AppConfig` :65-81; `NOTIFY_STUCK_AFTER_MS` :62/:80/:101 **parsed and consumed by nothing**
  (R0-2's subject). T5 adds `RETENTION_ENABLED` (default `false`), `RETENTION_EVENTS_MONTHS`
  (default `120`), `NOTIFY_RETAIN_DAYS` (default `180`) — all defaulted, no `.env` change
  anywhere.
- **`notifications`** — `kernel/db/schema/notifications.ts`: status enum :44 (`queued|sending|
  sent|suppressed|expired|undeliverable`), `updated_at` :53, indexes :55-59. T2 adds the prune
  index; T5's sweep deletes terminal rows only (D7).
- **`tail.ts:17-25`** — the max(seq) floor precedent D10 copies. Not modified.
- **`vite.config.ts:12-24`** — the dev proxy prefix list D14's Caddyfile mirrors and the parity
  test parses. Not modified.
- **`pnpm-workspace.yaml` + `pnpm-lock.yaml`** at the root; `apps/web` builds with `vite build`.
  **The lockfile must not change in any task.**
- **`.env.example`** — the Plan-11 `SECRET_KEY` promise :5 that D11 discharges.
- **Migrations** — `apps/core/drizzle/`, latest `0015_previous_shiver_man.sql`; **next is `0016`**
  (measured).
- **Baseline (gate report, measured 2026-08-22, exit VALUE from a file):** core **132 / 908** ·
  web **31 / 152** · contracts **3 / 7**. CI green at `b6d5647` and every later docs commit with a
  run. **Re-measure at compile; measurement beats this document.**
- **The box (measured this session):** CX43, 8 vCPU / 15 GiB (1.5 used) / 150 GB disk (17 used) ·
  only `hmis-db-1` + `hmis_hmis_pgdata` · **80/443 held by the nginx residue** (owner clears —
  prerequisite) · orphan PIDs `3501080`/`3502071` still present (owner kills).

## Global Constraints

1. **Stage-3 portability** (D4): re-point, never rewrite. Any provider-specific primitive in the
   deployable is a task failure.
2. **No secret in git, ever** (D11): no `.env`, no key, no R2 credential, no cipher passphrase.
   Production secrets live in `/opt/hmis-prod`, chmod 600.
3. **No new npm dependency**: a `pnpm-lock.yaml` diff anywhere is a halt (D15).
4. **The dispatcher edit is ONE added predicate plus its floor lookup** (D5); the claim, cursor
   arithmetic, backoff, LEFT JOIN, and one-WHERE-chain shape stay byte-identical. A diff beyond
   that is a task failure.
5. **Retention deletes nothing by default** (D6): `RETENTION_ENABLED=false`; a held month is
   undroppable structurally; DEFAULT and current/adjacent partitions never dropped.
6. **`queued` and `sending` notifications are never pruned at any age** (D7).
7. **The restore drill restores for real** (D8). A `--dry-run` discharges nothing.
8. **Migration `0016` ONLY**, owned by T2; rollback stated in the task BEFORE the generator runs
   (AGENT-RULES §6); full output committed. **The recreate is irreversible — if applied then
   abandoned, STOP and REPORT which databases carry it. Never delete the file.**
9. Jobs ride the shipped `Scheduler`; `pg-boss` is dead and must not appear.
10. Workspace totals never decrease; no test deleted (AGENT-RULES §4). No per-task count targets.
11. Every clock-reading function takes `now: Date = new Date()`; no wall-clock timing assertions
    (08.5 GC9/10).
12. **Infra tasks are verified by DRILLS, and a drill transcript is evidence only if the drill
    actually ran** — transcripts go in the gate report (Plan 10 flag-④ discipline).
13. **Production containers belong to `hmis-prod` and only to it** (rule 7 as amended); nothing
    any task does may stop, remove, or prune `hmis-db-1`/`hmis_hmis_pgdata`, and a blanket prune
    is forbidden outright.
14. **Config that ships must demonstrably take effect** (§2.60(a)): every new key has an
    assertion that a non-default value changes behaviour through the production wiring shape.

## File Structure (locked; the frozen-path block is GENERATED from these lists — §2.25)

```
(repo root)
  Dockerfile                                        T1 create (multi-stage: core + web + caddy)
  .dockerignore                                     T1 create
packages/contracts/
  package.json                                      T1 (main → ./dist/index.js — the FORK-A blocker, measured)
  tsconfig.build.json                               T1 create (the spike's 12-line shape)
apps/core/
  package.json                                      T1 (build + compiled start scripts)
  tsconfig.build.json                               T1 create (include src+scripts, rootDir ".", no test — D2)
  jest.config.cjs                                   T1 (the contracts source-resolution pin, if that mechanism wins — D2)
  drizzle/0016_<generated-name>.sql                 T2 (generated/custom; full output committed)
  drizzle/meta/*                                    T2 (generator-owned)
  src/kernel/db/schema/events.ts                    T2 (partitioned shape: composite PK + unique)
  src/kernel/db/schema/retention.ts                 T2 create (retention_legal_holds)
  src/kernel/db/schema/retention.test.ts            T2 create
  src/kernel/db/schema/index.ts                     T2 (export retention)
  src/kernel/db/schema/notifications.ts             T2 (prune index (status, updated_at))
  src/kernel/events/dispatcher.ts                   T2 (the ONE floor predicate + floor lookup)
  src/kernel/events/dispatcher.test.ts              T2 (V1 floor pin; partition-boundary delivery)
  src/kernel/worker/partitions.ts                   T2 create (createEventPartitions)
  src/kernel/worker/partitions.test.ts              T2 create
  src/kernel/worker/jobs.ts                         T2 (register createEventPartitions) AND T5 (register retentionSweep; widen Pick) — sequential two-owner
  src/kernel/worker/scheduler.test.ts               R0-2 (CENSUS_INTERVALS key) AND T2 (census 7→8) AND T5 (8→9; literal keys) — sequential
  test/worker-runtime.e2e.test.ts                   T2 (census 7→8) AND T5 (8→9) — sequential two-owner
  test/helpers/db.ts                                T2 (retention_legal_holds joins truncate; TRUNCATE on partitioned parent verified)
  src/kernel/retention/sweep.ts                     T5 create (partition drops + holds + notify prune)
  src/kernel/retention/sweep.test.ts                T5 create
  src/kernel/retention/events.ts                    T5 create (partition_dropped, drop_blocked, notifications_pruned, drill_passed, drill_failed)
  src/kernel/config.ts                              T5 (three defaulted retention keys)
  src/kernel/config.test.ts                         T5 (defaults + take-effect leg)
  src/kernel/worker/seed-cursors.ts                 T6 create (seedCursors(db) — the importable logic)
  src/kernel/worker/seed-cursors.test.ts            T6 create (V10/V11, history-seeded)
  scripts/seed-cursors.ts                           T6 create (thin runner)
  test/caddyfile-parity.test.ts                     T3 create (D14's pin)
docker/prod/
  docker-compose.prod.yml                           T3 create AND T4 (pgBackRest per FORK-C) — sequential two-owner
  Caddyfile                                         T3 create (from spike E's measured config)
  .env.prod.example                                 T3 create (placeholders only, no secrets)
  deploy.sh                                         T3 create (build → configs → migrate → seed → up → verify)
  db.Dockerfile                                     T4 create (postgres:16 + pgbackrest — FORK-C's measured placement)
  pgbackrest/pgbackrest.conf                        T4 create (pg1-user=hmis; repo1-retention-* set — spike finding 5)
  drill/restore-drill.sh                            T4 create (the weekly drill; T5 wires the evented verdict)
  prometheus/prometheus.yml                         T6 create
  prometheus/alerts.yml                             T6 create (staleness + MISSING-series — spike finding 6)
  postgres-exporter/queries.yml                     T6 create (the heartbeat gauge the spike proved)
  grafana/provisioning/dashboards/hmis.json         T6 create
  grafana/provisioning/dashboards/dashboards.yml    T6 create
  grafana/provisioning/datasources/prometheus.yml   T6 create
README.md                                           T6 (Deployment section; §2.58 correction per FORK-A)
```

**Phase 0 files (before the pipeline):** R0-1 `src/kernel/notify/pump.test.ts` · R0-2 `jobs.ts`,
`jobs.test.ts`, `scheduler.test.ts`, `pump.ts` (comment) · R0-3
`docs/superpowers/pipelines/ci-watch.sh`.

**Forward-reference audit (§2.47), run on these lists:** T2 consumes only shipped surfaces; T3
consumes T1's images (wave behind) and spike E's Caddyfile (a report, not a file); T4 consumes
T3's compose file (behind); T5 consumes T2's `retention_legal_holds` and partitioned `events`
(behind) and its own events file; T6 consumes T5's heartbeat surface (already shipped, actually —
`scheduler_heartbeats` is 08.5's) and `workerConsumers` (shipped). **No task names a file, export
or symbol owned by a LATER task.** One resolution made at authoring: partition-creation events
could have lived in `kernel/worker/events.ts` beside `consumerPoisoned` (T2's wave) — instead, all
five retention/backup event definitions live in **T5's `kernel/retention/events.ts`**, and T2's
`createEventPartitions` **emits no event** (a monthly create-if-not-exists is not a fact the
hospital record needs; the partitions' existence is the record). `kernel/worker/events.ts` is
therefore not in this plan at all.
**Two-owner files, all sequential, each named in both briefs (§3.2):** `jobs.ts` (T2→T5),
`scheduler.test.ts` (R0-2→T2→T5), `worker-runtime.e2e.test.ts` (T2→T5),
`docker-compose.prod.yml` (T3→T4).

## Tasks

### Task 1: The production build — one artefact, several entrypoints *(CRITICAL, opus coder + opus gate; FORK-A = COMPILED, from the spike's measured shape)*

D2 resolved: the two `tsconfig.build.json` files (contracts per the spike's 12-line shape; core
widened to `include: src+scripts`, `rootDir: "."` so `dist/scripts/migrate.js` exists — if
`scripts/` fights that shape, fall back to the spike's `rootDir: src` plus a second small pass,
and say which won), **the contracts `main` flip with the jest-resolution proof** (D2: pick the
mechanism, prove by running the affected suites that they still read contracts SOURCE — quote the
evidence; a green suite alone does not discharge it, since stale-dist consumption is silently
green until contracts change), the `build` scripts in `package.json`, the multi-stage `Dockerfile`
(corepack pnpm; `--frozen-lockfile`; contracts + core compiled; web `vite build`; runtime stage
pruned to production dependencies + `drizzle/` + `meta/`; a caddy stage with the SPA at its static
root), `.dockerignore`. **Acceptance is a container that boots and answers `/health`, and a worker
container whose boot line names the seven current jobs — not a successful `docker build`** (flags
①②); ② re-measures `OpdRealtimeRegistrar` injection in the artefact that ships. All task-local
containers under a temporary compose project, removed before report (rule 7).

**Consumes:** shipped sources; the spike report's Question A shape. **Produces:** the image(s)
T3's compose runs; the §2.58 fix (T6's README documents it).

### Task 2: Migration 0016 — the events partitioning conversion *(CRITICAL, opus + gate; FORK-B = rename-and-recreate, from the spike's verbatim SQL; the most dangerous task in the plan)*

D5 in full, **starting from the spike report's Question-B SQL verbatim** — one transaction,
preserving its three measured landmines (index renames first · `ALTER SEQUENCE … OWNED BY` before
the `DROP` · explicit column list) and the IST month boundaries: the recreate, PK/unique reshape,
DEFAULT partition + 3 months pre-created, `retention_legal_holds` (D6's table — schema file +
test), the notifications prune index (D7), the `createEventPartitions` job + registration (census
7→8 in BOTH census files — §2.65), the dispatcher's floor predicate + lookup with its regression
pin (V1), truncate-helper coverage for the new table, the drizzle **snapshot** reconciled to the
hand-written SQL (the report's read-based caveat), and **rollback stated in the task body BEFORE
the generator runs** (GC8) — noting honestly that the recreate itself is one-way: the stated
rollback is for the additive pieces; the recreate's abort path is STOP-AND-REPORT.
`EXPLAIN (ANALYZE)` output demonstrating plan-time pruning goes in the gate report (flag ③).

**Consumes:** T1 nothing (parallel-independent but sequenced after for wave discipline); shipped
dispatcher/schema. **Produces:** partitioned `events`, `retention_legal_holds`,
`createEventPartitions` (T5's sweep reads the same partition inventory helpers), the floor.

### Task 3: `hmis-prod` compose, Caddy, and the deploy script *(CRITICAL, opus + gate)*

`docker/prod/docker-compose.prod.yml` (project name `hmis-prod`: db on `127.0.0.1:5434` with its
own volume · api · worker · caddy on 80/443 · monitoring services arrive in T6), healthchecks and
`restart: unless-stopped` (D12), resource limits (values from spike D), the Caddyfile from spike
E's measured config (SPA static root + API prefixes + `/ws` upgrade + auto-HTTPS on the owner's
hostname + HTTP→HTTPS + headers), `.env.prod.example` (placeholders: `DATABASE_URL` pointing at
the prod db service, `SECRET_KEY` empty with the ceremony pointer, R2 keys empty), `deploy.sh`
(D13's sequence, idempotent, refuses to run if `/opt/hmis-prod` missing or 80/443 occupied), and
the **caddyfile-parity test** (D14). **Acceptance: the full bring-up drill on the box — deploy.sh
from zero, `/health` answering THROUGH Caddy over HTTPS on the real hostname, a WebSocket frame
through Caddy (flag ④), dev suite still green with `hmis-prod` up (the ruling-2 coexistence
drill, flag ⑧) — transcripts in the gate report.** The dev compose is untouched.

**Consumes:** T1's images, spike E's Caddyfile. **Produces:** the running substrate T4/T6 extend;
`deploy.sh` (T6's runbook documents it).

### Task 4: pgBackRest and the weekly restore drill *(CRITICAL, opus + gate; FORK-C = in the Postgres image, dissolved by measurement)*

D8: `db.Dockerfile` (postgres:16 + pgbackrest — the measured placement; the compose db service
swaps onto it as the second sequential owner of the compose file), archiving + nightly fulls,
`repo-type=s3` → R2 with repo encryption, `pgbackrest.conf` carrying the two spike-measured
requirements (`pg1-user=hmis`; `repo1-retention-full`/`repo1-retention-archive` set), config in
`docker/prod/pgbackrest/` deployed to `/opt/hmis-prod`, `drill/restore-drill.sh` —
a REAL restore into a scratch database (its own container or schema per FORK-C), the migrator
consistency check, asserted counts and a known event id, `backup.drill_passed`/`.drill_failed`
appended via T5's event definitions — **wait: T5 is a later wave.** Resolution (§2.47, the seam
rule): **the drill events belong to T5's `kernel/retention/events.ts`, so T4's drill script emits
its verdict as an exit code + transcript only, and T5 wires the evented verdict** — one line in
T5's sweep/events scope, named in both briefs. Scheduling: the drill is a host cron entry
installed by `deploy.sh` (weekly, IST off-hours), NOT a Scheduler job — the worker must not hold
restore privileges or block on a multi-minute restore. **Acceptance: a completed restore with
timings and repo size, transcript in the gate report (flag ⑤); the R2 leg exercised for real with
the owner's bucket — if credentials are not yet present, the task HALTS rather than shipping an
untested remote leg** (execute-prerequisite: R2 bucket + token exist before this wave).

**Consumes:** T3's compose/deploy substrate. **Produces:** the backup fabric; the drill T6's
runbook documents.

### Task 5: Retention — events by partition, notifications by row *(CRITICAL, opus + gate)*

D6 + D7: `kernel/retention/sweep.ts` (`retentionSweep(db, opts)` — partition inventory, hold
check (patient-scoped via the partition's own rows + global), drops evented, DEFAULT/current
months never dropped; **the D6 companion sweep over the three side tables** — `event_idempotency`
by `recorded_at`, `event_deliveries` by `updated_at` with `retrying` untouchable,
`event_dead_letters` by `parked_at`, counts evented; notifications terminal-row prune in bounded
batches), `kernel/retention/events.ts` (all six definitions incl. `retention.side_tables_pruned`
and T4's drill verdicts — the T4 seam), the three defaulted config keys + take-effect assertions
(GC14, V9), registration as `dailyIst` `RETENTION_SWEEP_IST = "01:15"` (census 8→9 in both census
files), the T4 drill-script wire (evented verdict). Mutants: V5 (held month undroppable), V6
(disabled = inert — covering the companion sweep too), V7 (`sending` survives any age), V8
(boundary), V9 (config reaches the sweep through the production registration shape), V12 (the
companion sweep respects the window and the `retrying` immunity).

**Consumes:** T2's table/partitions/helpers; T4's drill script (the wire is one call). **Produces:**
the sweep; the events T4's drill and D9's dashboards reference.

### Task 6: Monitoring, cursor seeding, and the deployment runbook *(ROUTINE, sonnet + mechanical check; FORK-D = same box, measured)*

D9 + D10 + D11: the monitoring services joining `hmis-prod` (FORK-D: same box, measured ~0.6%) —
prometheus + the alert rules (**staleness AND the missing-series leg**, spike finding 6: a job
with no heartbeat row must alert, proven by a drill against a job name absent from the table —
flag ⑨) + node_exporter + postgres_exporter with the spike-proven heartbeat query
(`postgres-exporter/queries.yml`) + provisioned Grafana dashboard, all on `127.0.0.1` high ports —
`seedCursors(db)` + its history-seeded test
(V10/V11) + the thin script runner + its `deploy.sh` slot, and the README **Deployment** section:
the full runbook (deploy sequence, SECRET_KEY ceremony + escrow (D11), the R2/credentials
procedure, the drill and how to read its verdicts, the accepted shared-box failure mode (D13),
stage-1 RPO/RTO honestly stated, FORK-A's resolution reflected in the run commands — the §2.58
correction if COMPILED won). Written to the D-12 stranger-drill standard.

**Consumes:** everything prior. **Produces:** the operational surface the owner actually uses.

## Commit messages — one per task, exact (AGENT-RULES §5 step 1 resolves here)

| task | subject |
|---|---|
| R0-1 | `test(core): pin the gauntlet order — deceased-and-phoneless suppresses, never desk-tasks` |
| R0-2 | `fix(core): thread NOTIFY_STUCK_AFTER_MS to the pump — the key an operator sets now takes effect` |
| R0-3 | `fix(pipelines): ci-watch marks unresolvable commits seen and heartbeats every sweep` |
| T1 | `feat(core): the production build — one image, api and worker entrypoints, web static` |
| T2 | `feat(core): migration 0016 — events partitioned monthly, legal holds, the dispatcher floor, the partition job` |
| T3 | `feat(infra): hmis-prod compose and Caddy — the deploy script, TLS by hostname, the parity pin` |
| T4 | `feat(infra): pgBackRest to R2 — archiving, nightly fulls, and a restore drill that restores` |
| T5 | `feat(core): retention — partitions dropped under structural holds, notifications pruned, inert by default` |
| T6 | `feat(infra): monitoring on the box, cursor seeding, and the deployment runbook` |

## Assertion Book — predictions until executed; the verdict column is filled by the shipping task

Rows marked **P** carry inputs the task must confirm by building the mutant and watching it die
(rule 21; §2.57's lesson that the Book's own input is a prediction).

| # | task | assertion | killing mutant | discriminating input | P? |
|---|---|---|---|---|---|
| R1 | R0-1 | Deceased-and-phoneless suppresses; zero `notification.failed` (gate §7.1) | relocate the deceased stop past channel resolution (the gate's own executed mutant) | patient deceased + `phone NULL`, pump cycle → shipped: `suppressed(deceased)`, `failed` count 0; mutant: `undeliverable` + a desk task | |
| R2 | R0-2 | `NOTIFY_STUCK_AFTER_MS` reaches the pump through the production registration | registration drops the pass-through | register with `notifyStuckAfterMs: 1000`; a `sending` row 2 min stale flips under the job's own `run(now)`; under the mutant it stays `sending` | |
| V1 | T2 | The floor prunes and does not skip: an undelivered event in the cursor's own month is still delivered | compute the floor from `now` instead of the cursor's seq | cursor seq in month M, undelivered event later in M, `now` in M+1 → shipped delivers; mutant's floor is M+1 and misses it | **P** |
| V2 | T2 | `seq` stays monotone through the recreate; `RETURNING seq` intact | (drill, not mutant) | append after conversion → seq > pre-conversion max; dispatcher cycle delivers it | |
| V3 | T2 | Rows land in their month's partition; out-of-range lands in DEFAULT | (drill) | `tableoid::regclass` per inserted row, quoted | |
| V4 | T2 | `createEventPartitions` is idempotent and creates ahead | drop the if-not-exists guard | run twice for the same month set → shipped: second run no-op; mutant: error/duplicate | |
| V5 | T5 | A month intersecting an ACTIVE hold is never dropped; refusal evented | delete the hold check | ancient month, hold on a patient with one event in it, `RETENTION_ENABLED=true` → shipped: partition present + `retention.drop_blocked`; mutant: dropped | |
| V6 | T5 | `RETENTION_ENABLED=false` → the sweep is inert | ignore the flag | ancient months + ancient terminal notifications, flag false → zero drops, zero deletes, zero events | |
| V7 | T5 | `queued`/`sending` survive any age | prune filter loses the status predicate | a `sending` row dated years back → shipped: survives; mutant: deleted | |
| V8 | T5 | Terminal rows: older-than-window deleted, inside-window retained | boundary comparison flipped | two `sent` rows straddling `NOTIFY_RETAIN_DAYS` by one day each side | **P** |
| V9 | T5 | Retention config reaches the sweep through the production registration (GC14) | registration drops the values | register with `retentionEventsMonths: 1` + enabled; behaviour differs from the 120-month default on a 2-month-old partition | |
| V10 | T6 | `seedCursors` leaves a new consumer at `max(seq)`; next cycle delivers nothing | write 0 / skip the upsert | history seeded THEN consumer seeded THEN one cycle → shipped: 0 delivered; mutant: full replay begins | |
| V11 | T6 | `seedCursors` never lowers an existing cursor | unconditional update | existing cursor > `max(seq)` fixture → shipped: untouched; mutant: regressed and replay begins | |
| V12 | T5 | The companion sweep deletes only outside the window, and never a `retrying` delivery (D6) | drop the window predicate / drop the status guard | one fresh `done` delivery + one ancient `retrying` + one ancient `done`, sweep enabled → shipped: only the ancient `done` deleted; mutant a: fresh row deleted; mutant b: `retrying` deleted | |

**Required-DIED mutant count: 12** — R1, R2 (Phase 0) · V1, V4 (T2) · V5, V6, V7, V8, V9, V12
(T5) · V10, V11 (T6); V2 and V3 are drills, not mutants. This number is the §2.68 input to the
budget below.

## Verify-by-execution flags (each names its owning task)

- **①** (T1) A container from the Dockerfile boots; `/health` answers; the worker container's boot
  line names the seven current jobs (nine after T5 — the T6 deploy drill re-verifies).
- **②** (T1) `OpdRealtimeRegistrar` injects in the container — §2.58 measured in the artefact
  that ships.
- **③** (T2) Dispatcher green against the partitioned table; `EXPLAIN (ANALYZE)` shows pruning;
  transcript in the gate report.
- **④** (T3) A WebSocket connects THROUGH Caddy over HTTPS and receives a frame — **already
  discharged once by spike question E** (HTTP 101, gateway auth frames, close 4001, controls both
  ways); T3 re-proves it in the real bring-up on the real hostname.
- **⑤** (T4) A restore drill completes against a real R2-backed backup; transcript + timings in
  the gate report.
- **⑥** (T5) V5 executed: a held month survives an enabled sweep.
- **⑦** (T6) The seeding script against a history-seeded database: cursor at `max(seq)`, next
  cycle delivers zero.
- **⑧** (T3) The coexistence drill: `hmis-prod` fully up, dev `pnpm verify` green beside it, both
  transcripts in the gate report (ruling 2's acceptance).
- **⑨** (T6) The missing-series alert fires for a job name with NO heartbeat row (spike finding
  6's blind spot, closed by drill — the staleness leg alone cannot see it).

## Pipeline Notes (for the compile session — do not compile before the forks are resolved in this document)

- **Phase 0 first**, three commits, verified on the host, CI checked per commit by full SHA
  (§2.62: never let two commits share a push).
- **One pipeline, six waves, STRICTLY SEQUENTIAL** — W1[T1] → W2[T2] → W3[T3] → W4[T4] → W5[T5]
  → W6[T6]. No parallel waves: §2.62's coalesced-push hole stays closed, and every wave after W1
  runs drills against shared host state.
- **Models:** T1–T5 opus coder + per-task opus gate (CRITICAL — infra drills and mutant work);
  T6 sonnet + mechanical check. Phase 0: one opus agent for R0-1+R0-2; R0-3 by the compile
  session itself.
- Briefs POINT at AGENT-RULES.md and this plan (never paste); restricted tool set; baseline
  re-measured at compile start, detached, exit value from a file.
- The compile-time sweep (EXECUTE-METHOD §3) runs before any brief: paths resolved against the
  tree; forward references (§2.47); **fork-loser grep (§2.48) — the losing branches
  (`tsx`-in-production · create-empty-and-cut-over · sidecar/host pgBackRest · off-box
  monitoring) may appear ONLY inside a RESOLVED block as marked-dead history**;
  vacuous-assertion check; script `files` arrays vs this File Structure both directions (§2.54);
  a commit message per task (above); CI per commit by full SHA with R0-3's fixed watcher running.
- **Budget, from the Book per §2.68:** 12 required-DIED mutants (2 Phase 0 · 2 T2 · 6 T5 ·
  2 T6) + five CRITICAL gates + drill-heavy acceptance; the spike's ~197k is already spent.
  Plan 10 ran 13 agents at ~203k for 20 mutants; this plan is 6 tasks + the Phase-0 agent +
  5 gates + mechanical checks + discovery reviewer ≈ 14 agents with roughly half the mutant
  load but drill transcripts in its place. **Target: ≤ 2.4M subagent tokens, stated as
  arithmetic, not analogy** — and if the compiled Assertion Book's mutant count grows, the
  target moves with it, in the execute prompt, before the run.
- The `hetzner` MCP server is available to the MAIN session only; pipeline agents get no MCP
  roster.

## Execute-prerequisites (owner actions; the pipeline halts where noted)

1. **nginx/Certbot residue removed; 80/443 free** (verified: `ss -tlnp` shows no listener) —
   blocks T3's bring-up drill.
2. **The two orphan shells killed by PID** (`3501080`, `3502071`) — blocks nothing, but every
   agent's rule-20 probe reads cleaner; owner's call under rule 8. **Same visit, same standing:**
   the pre-existing `hmis_spike85_1` database on `hmis-db-1` (visibly the 08.5 spike's residue —
   spike finding 8) is the owner's to drop or keep.
3. **DNS: the chosen subdomain → `62.238.106.231`** — blocks T3's auto-HTTPS leg (Caddy needs the
   name to resolve).
4. **Cloudflare R2: bucket + scoped API token created; credentials handed to the deploy `.env`
   by the owner** — T4 HALTS without them (its remote leg must be real).
5. **`SECRET_KEY` ceremony scheduled** (T6 documents it; the owner performs it at first prod
   deploy).
6. **Counsel engagement started** (rulings 6+7): retention floors + DPDP pilot posture — blocks
   nothing in 11a; blocks flipping `RETENTION_ENABLED` and the stage-2 pilot respectively.

## Decisions for the owner (listed with what stalls without each)

1. **Grafana behind Caddy** (a route + auth) vs SSH tunnel only (shipped default). Stalls
   nothing; convenience only.
2. **An IP allowlist in front of the app during UAT** — one Caddyfile line, off by default (D14).
   Stalls nothing.
3. **When to flip the repo private again** — the repo is public for Actions minutes; this plan
   ships no secrets either way (GC2), but a public production compose invites probes reading the
   port map. Stalls nothing; worth deciding before the stage-2 pilot.
4. **Staff/owner phone numbers** for `users.phone` (Plan 10's decision 4) — deployment data for
   the runbook's seed step. Stalls staff/owner external messages only.
5. **Plan 11c's slot** — any time after 11a, before go-live (ruling 8).

## Self-review — what this plan's own passes caught before commit, and what the spike refuted

1. **Every factual claim re-verified against the tree at `f16aff1`**, not inherited from the
   draft: no Dockerfile/build script/prod compose (re-measured) · `events` schema + the
   plain-idempotency-index comment · `worker.ts:3-8`'s no-FK-by-design note (which makes the
   recreate one-table — the draft did not know this) · the dispatcher's :138 one-WHERE-chain
   reservation and :16-20 floor pointer · `JobIntervals` and both census files with the
   amendment-7 warning comment in place · `NOTIFY_STUCK_AFTER_MS` parsed at config.ts:62/:80/:101
   and consumed by nothing (R0-2's subject, re-confirmed) · `vite.config.ts:13`'s "production
   serving is Caddy (Plan 11)" line · `.env.example:5`'s ceremony promise · `scripts/` outside
   the tsconfig include (D2's build-mechanics discovery — the draft did not know this either) ·
   `event_idempotency.recorded_at` / `event_deliveries.updated_at` / `event_dead_letters.parked_at`
   verified sweepable before D6's companion sweep was designed on them.
2. **What the spike REFUTED in this plan's own reasoning, kept visible on purpose:** D2 predicted
   the compiled-output obstacle would be `NodeNext` semantics — measured friction was ZERO (CJS
   package) and the real blocker was `@hmis/contracts`' `main`, which no amount of reading this
   repo's tsconfigs would have surfaced. FORK-C's three-way placement question **dissolved**
   rather than resolved — `archive_command`'s execution locus removes two branches as impossible,
   not inferior. And the draft treated pre-created months as hygiene; the DEFAULT-partition
   pruning measurement shows they are load-bearing. Three reminders that this plan's remaining
   untested claims deserve their flags.
3. **What the spike found that nobody owned:** the partition-drop orphan rows in the three side
   tables. D6 grew the companion sweep, T5 grew V12, and the mutant count moved 11 → 12 with the
   budget note updated in the same edit (§2.24 — both places, one pass).
4. **§2.65 run at authoring, not at compile:** every symbol this plan widens or census it grows
   was grep'd for its other readers — `JobIntervals` (4 files), `THE_SEVEN` (2 files),
   `@hmis/contracts`' `main` (jest configs checked; `apps/web` measured NOT to depend on
   contracts, so the flip's blast radius is core's jest only) — and every reader is in an owning
   task's Files list. The multi-owner censuses are sequential with carried-forward notes.
5. **§2.47 double-resolved in T4/T5:** the drill's evented verdict originally forward-referenced
   T5's event definitions from T4; resolved seam-style — T4 ships transcript+exit-code, T5 wires
   the events — and both briefs carry the note.
6. **This session's own authoring defects, caught and fixed before commit:** a File Structure row
   (`kernel/worker/events.ts`) that a later paragraph struck instead of deleting — the §2.24 trap
   in miniature, removed; the Book's stated mutant count (10) disagreeing with its own rows (11,
   then 12 after V12); a task-header typo. Recorded because a plan that only lists the draft's
   defects is advertising, not review.
7. **The nginx discovery** (80/443 held by InsForge residue) came from this session's own
   measurement, is execute-prerequisite 1, and was pushed into the spike brief's ground rules the
   same hour so no probe bound those ports.
8. **Scope cut, not padded:** monitoring contact points, Grafana-behind-Caddy, IP allowlists,
   Loki, and the relay all stayed out with their trigger conditions written down.

## Carried forward

- **Closes** the roadmap's Plan-11 partitioning obligation, the `event_cursors` seeding step
  booked by 08.5 and re-booked by 10, `.env.example`'s Plan-11 `SECRET_KEY` promise, **§2.58's
  four-day-invisible broken run command** (measured fixed by the spike under compiled output;
  shipped by T1, documented by T6), and — via Phase 0 — Plan 10's two booked MAJORs and §2.63's
  broken watcher.
- **Does not touch** 08.5's remaining booked items (`start()`-clears-latch, `shutdownWorker`'s
  logger `.catch`, `TS151002` noise, the OPD `SubmitButton` retrofit, `POLL_MS`) or Plan 10's
  §7.3 MINOR (the patient-audience-without-patient_id chain) — all stay booked where they are.
- **E-1** (DMZ vs cloud relay) remains open and blocks only the relay.
