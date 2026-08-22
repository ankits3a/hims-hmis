# Phase 1 / Plan 11a — Deployment: the production build, one server, partitioned events, and a restore that has actually been run · Implementation Plan

> **For agentic workers:** this plan is design law for the pipeline that executes it (EXECUTE-METHOD
> v2). Every agent reads [`AGENT-RULES.md`](../AGENT-RULES.md) and this document, nothing else.
> Written 2026-08-22 at `9caa915`. **No pipeline is compiled and nothing is executed by the session
> that wrote this** — that separation is deliberate and has paid three times.

> **STATUS: DRAFT, FORK-OPEN, AWAITING OWNER REVIEW. A SPIKE RUNS BEFORE THIS IS COMPILED.**
> Spike brief: [`2026-08-22-phase1-11a-spike-brief.md`](2026-08-22-phase1-11a-spike-brief.md).
> Four forks (A–D) carry decision rules; the spike resolves them from measurement and the resolving
> session marks each dead branch dead **in place** (§2.48), then a FRESH session compiles.

## Why this plan has a spike when Plan 10 did not

Plan 10 skipped its spike correctly: every mechanism it used — the claim shape, the consumer shape,
the config defaults, the manifest seam — was already shipped and measured. **11a is the opposite.
Almost nothing in it has ever been executed in this repository:**

- **No Dockerfile has ever existed here.** `find` over the whole tree returns none.
- **`apps/core` has no `build` script.** There is no compiled output, ever. Both processes run
  through `tsx` (`start:dev`, `start:worker`), which is a dev transpiler.
- **No production compose exists.** `docker/` holds one file: the dev Postgres.
- **pgBackRest has never run against this database.**
- **No partitioned recreate has been attempted**, and it is an irreversible table rewrite.
- **Nothing has ever run behind Caddy**, including the WebSocket upgrade the realtime gateway needs.

EXECUTE-METHOD §1's rule applies exactly: *every "verify-by-execution flag" a plan carries is an
admission that we wrote something we could not check.* A plan written straight through here would be
almost entirely flags. The spike costs ~50k and resolves the four that fork the task list.

---

## Owner ruling this plan implements (2026-08-22, in conversation)

**Deployment is STAGED** — spec v4.7 §1, roadmap "Deployment topology" (RESOLVED):

1. **Stage 1 — now.** ONE Hetzner cloud VM, no standby. Phase-1 build and owner UAT run here.
   **This plan's target.**
2. **Stage 2 — after Phase-1 UAT.** Live pilot in the working hospital **as a secondary HMIS beside
   the incumbent**, then hybrid: on-prem primary + cloud standby/backup. **Plan 11b.**
3. **Stage 3 — end state.** Fully on-prem, exactly as spec §1 line 21 says.

**Spec §1 is not superseded.** The destination is unchanged; it stopped being the starting line.
The consequence binds every task below: **nothing may be built that makes stage 3 expensive.**

---

## Design (the decisions this plan makes — read before the tasks)

### D1. Two processes, not four — and the missing two are named, not skipped

Spec §2 v4.3 says *api · ws hub · worker · renderer*. **Measured today: there are two.**
`main.ts` boots one Nest HTTP app whose `AppModule` imports `RealtimeModule` (the WS gateway and
the event tail live inside the API process); `worker.ts` boots a providers-only application context
running the Scheduler's seven jobs. **There is no renderer and no PDF library anywhere** — zero
matches for `puppeteer`/`pdfkit`/`PDFDocument` across `apps/`.

11a ships **api + worker**, and says why the other two are absent rather than letting a reader
assume they were forgotten:

- **The renderer cannot be split out because it does not exist.** The spec's reason for a separate
  renderer is *"a rendering storm can't stall the API"*; there is nothing to storm. It arrives with
  the first real PDF surface.
- **The WS hub stays inside the API.** Splitting it means extracting `RealtimeModule` and giving the
  tail its own process and cursor — real work, and at ~20 concurrent users on one box it buys
  nothing measurable. **The seam that makes it cheap later is already there** (`tail.ts` is a
  distinct cursor from the dispatcher, deliberately), and D3's one-image-many-entrypoints shape
  means adding a third command is a compose entry, not a refactor.

Both are booked in "What this plan deliberately does NOT build" (D13) with their trigger conditions.

### D2. FORK-A — production runs COMPILED output, not `tsx` *(spike resolves)*

**Recommended branch: compile with `tsc`.** `apps/core/tsconfig.json` already sets
`experimentalDecorators: true` **and `emitDecoratorMetadata: true`**, and the base config is
`module: NodeNext`, `target: ES2022`, `declaration: true`, `sourceMap: true`.

**The reason this is more than a preference — and the reason it is a FORK and not a decision.**
Ledger §2.58: `pnpm start:dev` has been broken since Plan 07 because `tsx` transforms with esbuild,
**esbuild does not emit `design:paramtypes`**, so Nest injects `undefined` into
`OpdRealtimeRegistrar`'s class-typed constructor. ts-jest *does* emit it, so all 908 tests pass and
the application cannot be started. `tsc` with `emitDecoratorMetadata: true` **should** emit it —
which would mean the compiled production build works where the documented dev command does not.

**That is a prediction, and rule 21 governs predictions.** Spike question A builds the output and
runs it. Decision rule:

- Compiled output boots, `/health` answers, the worker registers seven jobs, **and
  `OpdRealtimeRegistrar` injects** → **FORK-A = COMPILED.** Record the §2.58 fix as a measured
  by-product and correct the README.
- Compiled output does not run cleanly under `NodeNext` (ESM/CJS interop, extensionless imports,
  `import.meta`) and the fix is not small → **FORK-A = `tsx` IN PRODUCTION**, with the reason
  written down, the boot-time cost measured, and §2.58 explicitly still open.

Do not resolve this by taste. The obstacle, if there is one, is `NodeNext` output semantics, and
nobody has looked.

### D3. One image, several entrypoints — this IS the spec's "one codebase, several processes"

A single build artefact; the process is chosen by the container's command
(`node dist/main.js` / `node dist/worker.js`). No per-process image, no per-process build, no
divergence between what the API runs and what the worker runs. Adding the ws hub or the renderer
later is a compose entry plus an entrypoint file, never a second pipeline.

### D4. PORTABILITY IS A GLOBAL CONSTRAINT, NOT A PREFERENCE (stage 3, spec §1 v4.7)

**No provider-specific primitive may enter the deployable.** No cloud load balancer, no cloud
volume as a hard dependency, no cloud DNS API, no cloud secrets manager. The whole stack must stand
up from **Compose + Caddy + Postgres + pgBackRest on any capable metal**, because in stage 3 it
will have to. The one permitted external dependency is a **backup destination reachable over SFTP**
(D8) — a protocol, not a product, and swapping the host is one config line.

**The test of this constraint is a sentence any task can be failed on:** *if the hospital's on-prem
box were racked tomorrow, what in this diff would have to be rewritten rather than re-pointed?*
The answer must be "nothing".

### D5. Events partitioning: monthly on `recorded_at`, per the 2026-08-12 resolved decision

Transcribed from the shipped schema, not from memory — `kernel/db/schema/events.ts`:
`seq bigserial PRIMARY KEY` · `event_id text NOT NULL UNIQUE` · `recorded_at timestamptz NOT NULL
DEFAULT now()` · four plain indexes (`idempotency_key`, `name`, `patient_id`, `correlation_id`).

**Postgres requires every UNIQUE constraint on a partitioned table to contain the partition key**,
so the conversion is forced and the roadmap already names it:

- PK `seq` → **`(seq, recorded_at)`**
- `event_id` UNIQUE → **`(event_id, recorded_at)`** — harmless: ULIDs are unique by construction and
  semantic dedup already lives in the **non-partitioned** `event_idempotency` table, which is
  exactly why that side-table decision was taken on 2026-08-12.
- A **DEFAULT partition** plus several months pre-created.
- The dispatcher gains **one** predicate: `recorded_at >= floor`, floor =
  `date_trunc('month', recorded_at of the cursor's seq)`. Month truncation absorbs the fact that
  `seq` and `recorded_at` are not perfectly monotone together (`recorded_at` is transaction-start
  time). **One added line, and the one-WHERE-chain shape is preserved** — the same envelope
  discipline Plan 10 D5 held to, and the same byte-frozen lines.
- The monthly creation job is **a `Scheduler` `dailyIst` job**, idempotent
  (create-if-not-exists for the next K months). ~~pg-boss~~ is dead (08.5 FORK-B).

**FORK-B — how the conversion is performed** *(spike resolves)*. `events` has zero production rows
today but is not empty in dev. Branch (i) **rename-and-recreate** inside one migration
(`ALTER TABLE events RENAME TO events_old`, create partitioned `events`, `INSERT … SELECT`, drop);
branch (ii) **create-empty-and-cut-over** if the migrator or drizzle's snapshot cannot express (i).
Decision rule: the branch that survives a real run against a dump of the dev database with the
dispatcher still green afterwards. **This is the single most dangerous task in the plan** —
AGENT-RULES §6 is an irreversible host mutation and `git checkout` does not undo it.

### D6. Retention: the mechanism ships now, the VALUES are owner gates

Deleting a clinical record is not a decision a plan makes. 11a ships:

- `retentionSweep` as a `Scheduler` `dailyIst` job that **drops whole partitions**, never rows —
  that is the entire point of partitioning by the retention unit.
- **A legal hold that is checked structurally.** A partition whose month intersects any active hold
  is never dropped, and the refusal is evented. A hold is a row, not a config flag.
- The retention window as **config with a conservative default**, and `RETENTION_ENABLED` defaulting
  to **false** — so the mechanism ships inert and the owner switches it on with a value their
  counsel has signed off. This is Plan 10 D9's shape (the promotional refusal): the structure exists,
  the dangerous half is off, and a later decision flips it.

**Assertion Book N-rows enforce that a held month cannot be dropped.** That is the row where a
polite pass is the worst outcome on this surface.

### D7. `notifications` retention — new, and it was in nobody's scope list

Plan 10 shipped an outbox that gains one row per would-be message and **never prunes**. At 2,000
OPD visits/day that is a confirmation, a reminder and a welcome per patient — order 10⁶ rows/year,
plus their params jsonb. Nobody owned it.

Terminal rows (`sent` · `expired` · `suppressed` · `undeliverable`) older than
`NOTIFY_RETAIN_DAYS` are deleted. **`queued` and `sending` are never touched at any age** — a
`sending` row is D2's stuck-recovery surface and deleting one loses the only record that a message
may already be with a patient. Same `Scheduler` job as D6.

### D8. Backups: pgBackRest to SFTP, and the drill is the DR story

On a single server, backups are not one layer of defence — **they are the only one.** Stage 1 has no
standby, no promotion, no fencing (all Plan 11b).

- **pgBackRest** continuous WAL archiving + nightly fulls, repo-level encryption (spec E-2), to a
  **destination reachable over SFTP**. Recommended stage-1 host: a Hetzner Storage Box (~€3.5/mo,
  1 TB) — chosen because SFTP is a **protocol**, so D4 holds and stage 3 re-points one config line.
- **FORK-C — where pgBackRest runs** *(spike resolves)*: (i) inside the Postgres container image,
  (ii) as a sidecar container sharing the PGDATA volume, (iii) on the host. Decision rule: whichever
  produces a **restore that actually completes** with the least coupling to the Postgres image.
- **THE AUTOMATED WEEKLY RESTORE DRILL IS NOT OPTIONAL AND IT IS NOT A `--dry-run`.** It restores
  into a scratch database, runs the migrator's own consistency check, asserts a row count and a
  known event id, appends `backup.drill_passed` / `backup.drill_failed`, and drops the scratch
  database. **A backup nobody has restored is a belief, not a backup** — and this project has a
  ledger full of the difference between those two words.

### D9. Monitoring: Prometheus + Grafana now, Loki deferred, and the sizing said out loud

Spec §5 names Grafana + Prometheus + Loki. On one small VM already running Postgres, an API, a
worker and Caddy, a full log-aggregation stack is a meaningful fraction of the box.

11a ships **Prometheus + Grafana + node_exporter + postgres_exporter**, a dashboard, and the
**heartbeat-staleness alert rule** the roadmap names (the worker writes `scheduler_heartbeats`
already — Plan 08.5 — so the rule reads shipped data). **Loki is deferred to stage 2** and the
reason is written down: on a single box, `docker compose logs` and journald are the log story, and
aggregation earns its cost when there are two machines to aggregate. Deferred, not forgotten.

**FORK-D — whether the monitoring stack shares the box** *(spike resolves)*: measure the resident
footprint. If Prometheus + Grafana cost more than a stated fraction of the VM, branch (ii) puts them
on the existing build host instead, scraping over the private network. Decision rule is a
measurement, not an opinion.

### D10. First-boot cursor seeding — the step 08.5 and 10 both booked

`event_cursors.last_seq` defaults to 0 and `runDispatchCycle` creates the row on first sight, so
**the first cycle after a consumer is registered walks the entire event history** at 100 rows/tick.
It is a volume concern, not a correctness one (both consumers are idempotent). 11a ships it as a
**deployment step with a script**: on first boot against a database that already has history, seed
every registered consumer's cursor at `max(seq)`.

**There is already a shipped precedent for the exact shape, and the plan should copy it rather than
invent one.** `kernel/realtime/tail.ts` sets its own floor to `max(seq)` at start — its header says
so in as many words: *"floor = max(seq) at start (history is never replayed)"*. The tail solved this
problem for itself on day one; the dispatcher's cursor is shared and claiming, so it could not take
the same shortcut unilaterally — which is precisely why the seeding belongs in a deployment step.
Read `tail.ts:19-23` before writing the script.

**It now covers `kernel.alerts` AND `kernel.notify`.** For `kernel.notify` it is defence in depth
rather than the only guard — Plan 10's D5/N3 expires stale messages structurally at send time — but
"defence in depth" is not "unnecessary", and the flood has **never actually been observed**: Plan
10's demonstration could not exercise it because the dev database holds no subscribed events. The
script's test seeds history first.

### D11. `SECRET_KEY`: generated in a ceremony, escrowed, never in the repo

Spec E-2. The production key is generated on the box, `chmod 600`, and the escrow procedure is a
**printed runbook step**, not a code path. `.env.example` already carries the right warning
(*"Dev/test key only — the production key is generated and escrowed in Plan 11"*). 11a discharges
that promise. **No secret enters git, and no task may add one** — a plan that ships a key is worse
than a plan that ships nothing.

### D12. Health, readiness and restart policy

`apps/core/src/health/health.controller.ts` ships today. Compose gets a real `healthcheck` per
service and `restart: unless-stopped`. **The worker has no HTTP surface**, so its liveness is its
own heartbeat row — which is exactly what D9's alert rule reads, and why that rule is in this plan
rather than a later one.

### D13. What this plan deliberately does NOT build

No replication, no standby, no scripted promotion, no fencing, no post-failover revalidation, no
hot-standby analytics reads, no out-of-band watchdog (E-16), no NAS, no LUKS provisioning or key
ceremony beyond `SECRET_KEY` — **all Plan 11b, all stage 2, all requiring a second machine.**
No ws-hub process split (D1 — the seam exists; the trigger is measured WS load or a rendering
storm). No renderer (D1 — the trigger is the first PDF surface). No Loki (D9). No downtime-kit
generator, no `interface.down/.restored` heartbeat framework, no operating-mode service, no D-17
config-validation gate wiring — **those are hospital-operations concerns, not deployment**, and they
are re-split into **Plan 11c** (see the roadmap), which can run any time after 11a. No CI changes:
the server's deploy key cannot push `.github/workflows/*` (roadmap hard environment fact), so if a
task believes a workflow edit is needed it **stops and reports**.

---

## Global Constraints

1. **Stage 3 portability is a constraint, not an aspiration** (D4). If the on-prem box were racked
   tomorrow, nothing in this diff may need rewriting — only re-pointing.
2. **No secret in git, ever** (D11). No `.env`, no key, no backup credential.
3. **No provider-specific primitive in the deployable** (D4). SFTP is a protocol and is permitted.
4. **The dispatcher edit is ONE added predicate** (D5) — the claim, the cursor arithmetic, the
   backoff and the one-WHERE-chain shape stay byte-identical. A diff beyond that is a task failure.
5. **Retention deletes nothing by default** (D6) — `RETENTION_ENABLED` defaults false, and a held
   month is undroppable structurally, not by convention.
6. **`queued` and `sending` notifications are never pruned at any age** (D7).
7. **The restore drill restores for real** (D8). A `--dry-run` does not discharge it.
8. Migration `0016` ONLY; rollback stated in the task BEFORE the generator runs (AGENT-RULES §6);
   full generator output committed. **The partitioned recreate is irreversible — if it is applied
   and then abandoned, STOP and REPORT which migrations are applied. Never delete the file.**
9. Jobs ride the shipped `kernel/worker/scheduler.ts`. **`pg-boss` is dead and must not be added.**
   No new runtime dependency without an owner halt; a `pnpm-lock.yaml` diff outside T1's stated
   build tooling is a halt.
10. Workspace test totals never decrease; no test deleted (AGENT-RULES §4). No per-task count targets.
11. Every clock-reading function takes `now: Date = new Date()`; no timing assertion gates on a
    wall-clock mean or median (08.5 GC9/10).
12. **Infra tasks are verified by DRILLS, and a drill transcript is evidence only if the drill
    actually ran.** Where a task's proof is a transcript rather than a test, the transcript goes in
    the gate report — the flag-④ discipline Plan 10 discharged.

---

## Tasks (draft — the spike may move work between T1 and T3)

### Task 1: The production build — one artefact, several entrypoints *(CRITICAL, opus + gate; FORK-A lives here)*

`apps/core` gains a `build` script; a multi-stage `Dockerfile` at the repo root builds core and web
from the same context; `.dockerignore`; entrypoint verification for `dist/main.js` and
`dist/worker.js`. **The acceptance evidence is a container that boots and answers `/health`, and a
worker container whose log line names seven jobs** — not a successful `docker build`.
Carries the §2.58 measurement: does `OpdRealtimeRegistrar` inject under compiled output?

### Task 2: Migration 0016 — the events partitioning conversion *(CRITICAL, opus + gate; FORK-B lives here)*

D5, in full: partitioned recreate, PK and unique-index reshape, DEFAULT partition, months
pre-created, the `Scheduler` creation job, and the dispatcher's one floor predicate with its
regression pin. **The most dangerous task in the plan.** Rollback stated before the generator runs.

### Task 3: Production compose + Caddy *(CRITICAL, opus + gate)*

`docker/docker-compose.prod.yml` (db · api · worker · caddy), healthchecks, `restart:
unless-stopped`, resource limits, a Caddyfile with **WebSocket upgrade proven** (the realtime
gateway is inside the API — an untested proxy config is a dead bell). The dev compose is untouched.

### Task 4: pgBackRest and the weekly restore drill *(CRITICAL, opus + gate; FORK-C lives here)*

D8. Archiving, nightly fulls, repo encryption, SFTP destination as config. **The drill is the
deliverable**: a real restore into a scratch database with asserted counts, an evented verdict, and
a transcript in the gate report.

### Task 5: Retention — events by partition, notifications by row *(CRITICAL, opus + gate)*

D6 + D7. Legal holds as rows, checked structurally; `RETENTION_ENABLED` off by default;
`queued`/`sending` never pruned. Mutants: a held month must be undroppable, and a `sending` row must
survive any age.

### Task 6: Monitoring, cursor seeding, and the deployment runbook *(ROUTINE, sonnet + mechanical check; FORK-D lives here)*

D9 + D10 + D11. Prometheus/Grafana/exporters, the heartbeat-staleness rule, the cursor-seeding
script and its history-seeded test, the `SECRET_KEY` ceremony runbook, and a README **Deployment**
section that a stranger could follow — the D-12 continuity kit's annual stranger drill is the
standard this section is written to.

---

## Verify-by-execution flags (each names its owning task)

- **①** (T1) A container built from the Dockerfile boots and `/health` answers; the worker container
  logs seven job names. **②** (T1) `OpdRealtimeRegistrar` injects under compiled output — §2.58's
  four-day-invisible defect, measured either way. **③** (T2) The dispatcher is green against the
  partitioned table and the floor predicate prunes (`EXPLAIN` shows partition pruning).
  **④** (T3) A WebSocket connects through Caddy and receives a frame. **⑤** (T4) A restore drill
  completes against a real backup and its transcript is in the gate report. **⑥** (T5) A month
  under legal hold is not dropped. **⑦** (T6) The cursor-seeding script, run against a database
  seeded with history, leaves a newly-registered consumer at `max(seq)` and dispatches nothing.

---

## Decisions for the owner (listed with what stalls without each)

1. **Retention windows, and who signs them off.** Events and `notifications`. Indian medical-record
   retention has statutory floors that vary by record class and by whether a matter is under
   litigation — this is a counsel question, not a code one. **Stalls: nothing** — D6 ships inert
   with `RETENTION_ENABLED=false`. Without a value the database simply keeps growing, which is the
   safe failure.
2. **A domain name and TLS.** Caddy will do automatic HTTPS given a hostname; without one, stage 1
   is IP-only with a self-signed certificate, which is acceptable for a build/UAT box and **not**
   acceptable for the stage-2 pilot. **Stalls: nothing in 11a; blocks the pilot.**
3. **The stage-1 production VM.** It must be its own machine: `62.238.106.231` is the build host
   *and* the InsForge co-tenant's home, and production must not share a box with a suite that
   hammers Postgres. A CX43-class VM is ~€16/mo. **Stalls: T3's and T4's real-environment
   verification** — they can be built and unit-verified without it, but the drills need a box.
4. **The backup destination.** Recommended: a Hetzner Storage Box over SFTP (~€3.5/mo, 1 TB),
   chosen for portability (D4). **Stalls: T4's drill.**
5. **When the stage-2 pilot starts** — because it triggers the new PRE-PILOT gate (spec §19 v4.7):
   a DPDP posture for **real patient data on a cloud host outside India**, plus E-11's
   transition-operations boundary map for the two-system period. Weeks of lead time if counsel is
   involved. **Stalls: the pilot, not this plan.** Worth starting now.
6. **Plan 11c's slot** (operating modes, downtime kit, interface heartbeats, D-17 gate wiring) —
   split out of 11a above. Any time after 11a; before go-live.

## Self-review — what this plan's own passes caught before commit

1. **Every factual claim about the tree was resolved against the SERVER, not written from memory
   (§2.46).** Verified at `9caa915`: no Dockerfile anywhere · `apps/core` has no `build` script ·
   `docker/` holds only `docker-compose.dev.yml` + `initdb/` · `emitDecoratorMetadata: true` in
   `apps/core/tsconfig.json`, `module: NodeNext` in the base · `events` is
   `seq bigserial PK` + `event_id UNIQUE` + `recorded_at NOT NULL DEFAULT now()` ·
   `event_idempotency` is a separate non-partitioned table · `scheduler_heartbeats` exists ·
   `/health` is `@Public() @Get()` so a compose healthcheck reaches it unauthenticated ·
   `OpdRealtimeRegistrar` (`opd.module.ts:15`) really does take a class-typed
   `constructor(private readonly gateway: RealtimeGateway)` · **zero** PDF/renderer code in `apps/`.
2. **The sweep found something the draft did not know:** `tail.ts` already floors its cursor at
   `max(seq)` on start. D10 now points at it as the shipped precedent instead of describing the
   shape from scratch.
3. **Scope was cut, not padded.** The draft inherited the roadmap's whole pre-split Plan 11 list and
   came to nine or ten tasks — past the six-task pipeline limit, which is a compile-time failure,
   not a matter of taste. The operational-fabric half (operating modes, downtime kit, interface
   heartbeats, D-17 wiring) is genuinely a different subject and became **Plan 11c**; the roadmap
   was amended in the same commit so the two documents cannot disagree (§2.54's lesson, applied to
   prose rather than to a script).
4. **Four forks, each with a decision rule and a spike question**, rather than four
   verify-by-execution flags pretending to be decisions (EXECUTE-METHOD §1).
5. **The two absent processes are named with their trigger conditions** (D1/D13) rather than
   silently omitted — 08.5's D12 and Plan 10's D14 discipline.

## Carried forward

- **Closes** the roadmap's Plan-11 partitioning obligation and the `event_cursors` seeding step
  booked by 08.5 and re-booked by 10.
- **Inherits** Plan 10's two booked MAJORs — the unpinned suppression-gauntlet order and the dead
  `NOTIFY_STUCK_AFTER_MS` key (`reports/plan-10-gate-report.md` §7). **Neither is 11a's**, and both
  are small; recommend clearing them in a short remediation before or beside this plan.
- **Does not touch** 08.5's remaining booked items (`start()`-clears-latch, `shutdownWorker`'s
  logger `.catch`, `TS151002` noise, the OPD `SubmitButton` retrofit, `POLL_MS`).
