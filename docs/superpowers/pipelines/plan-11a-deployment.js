export const meta = {
  name: 'plan-11a-deployment',
  description: 'Plan 11a: production build, partitioned events, hmis-prod compose+Caddy, pgBackRest to R2, retention, monitoring',
  phases: [
    { title: 'Wave 1', detail: 'T1 the production build — one image, api and worker entrypoints' },
    { title: 'Wave 2', detail: 'T2 migration 0016 — events partitioned, legal holds, dispatcher floor' },
    { title: 'Wave 3', detail: 'T3 hmis-prod compose, Caddy, deploy.sh' },
    { title: 'Wave 4', detail: 'T4 pgBackRest to R2 and the restore drill' },
    { title: 'Wave 5', detail: 'T5 retention — partitions, holds, notifications prune' },
    { title: 'Wave 6', detail: 'T6 monitoring, cursor seeding, deployment runbook' },
    { title: 'Discovery', detail: 'one opus reviewer reads all six commits together' },
  ],
}

// ============================== COMPILE-TIME CONSTANTS ==============================
// Baseline re-measured by the main session on the build host immediately before this run,
// detached, exit VALUE read from /opt/hmis/.verify.exit. NEVER a remembered number (§2.6).
const BASELINE = 'apps/core 132 suites / 911 tests · apps/web 31 files / 152 tests · packages/contracts 3 suites / 7 tests'
const PHASE0_TIP = '51c2e3678ca3279618574e70271092d1460e71cc'

const RULES = '/opt/hmis/docs/superpowers/AGENT-RULES.md'
const PLAN = '/opt/hmis/docs/superpowers/plans/2026-08-22-phase1-11a-deployment.md'
const SPIKE = '/opt/hmis/docs/superpowers/plans/reports/plan-11a-spike-report.md'
const SCRATCH = 'C:\\Users\\ankit\\AppData\\Local\\Temp\\claude\\C--Users-ankit-hmis\\f0cb517a-8f84-42a5-a47e-7bde9bd14e4f\\scratchpad'
const FINDINGS_INBOX = '/opt/hmis/docs/superpowers/plans/reports/plan-11a-findings-inbox.md'

// ============================== TASKS ==============================
// `files` arrays are the plan's File Structure rows for each task, AS AMENDED at compile time
// (§2.54 — the plan and this array are two copies of one fact and nothing else reconciles them).
// The compile sweep found four files the plan's PROSE requires a later task to edit that its
// File Structure did not name; the plan was amended in the same commit that carries this script.
const TASKS = [
  {
    id: 'T1',
    wave: 1,
    tier: 'CRITICAL',
    model: 'opus',
    gate: true,
    deps: [],
    commit: 'feat(core): the production build — one image, api and worker entrypoints, web static',
    files: [
      'Dockerfile',
      '.dockerignore',
      'packages/contracts/package.json',
      'packages/contracts/tsconfig.build.json',
      'apps/core/package.json',
      'apps/core/tsconfig.build.json',
      'apps/core/jest.config.cjs',
    ],
    brief: `## Task T1 — The production build: one artefact, several entrypoints

Read the plan's **D2** (FORK-A RESOLVED = COMPILED), **D3**, **Task 1** and **flags ①②**. Read the
spike report's **Question A** — its measured shape is your starting point, not a suggestion.

**FORK-A is RESOLVED and closed: production runs COMPILED output.** The \`tsx\`-in-production branch
is dead. Do not re-open it, do not benchmark it, do not mention it except as history.

What the spike measured, so you do not rediscover it:
- \`apps/core\` is a **CJS** package. \`tsc\` under \`NodeNext\` emits plain CommonJS. The \`NodeNext\`
  friction the plan originally predicted **does not exist** — zero source edits were needed.
- **The real blocker is \`packages/contracts/package.json\`'s \`"main": "./src/index.ts"\`.** \`tsx\`
  transpiles that on the fly; plain \`node\` cannot load it at all. The measured fix is
  \`main\` → \`"./dist/index.js"\`, with \`"types"\` STAYING at \`./src/index.ts\`.
- Build shape: \`pnpm exec tsc -p tsconfig.build.json\` per package. Contracts ≈1.4 s, core ≈9.3 s.
  Each \`tsconfig.build.json\` is ~12 lines: extends the package tsconfig, \`outDir: dist\`,
  \`rootDir\`, includes \`src\`, excludes \`src/**/*.test.ts\`, \`noEmit: false\`.
- Measured boot: compiled API served \`/health\` in ≈919 ms; compiled worker logged all seven jobs
  in ≈645 ms. \`grep -c "design:paramtypes"\` in the compiled opd module returned 1 — \`tsc\` emits
  the decorator metadata esbuild does not.

### The four things this task must settle, and two of them are proofs, not code

1. **The contracts \`main\` flip, WITH the jest-resolution proof.** Flipping \`main\` to \`dist\`
   affects every other consumer of that field — jest resolves packages through \`main\` too, so the
   suite could silently start consuming **stale compiled contracts** instead of source. That is
   AGENT-RULES rule 5's hazard one level up, and it is **silently green until contracts change**,
   which is precisely why a passing suite does not discharge it.
   Pick the mechanism — a jest \`moduleNameMapper\` pin to contracts \`src\`, flipping \`main\` only
   inside the Docker build stage, or \`exports\` conditions — and **PROVE the suite still reads
   SOURCE with a check that could fail**. A green suite is not the proof. Something like: change a
   symbol in contracts source without rebuilding \`dist\`, observe the suite see the change (then
   revert); or assert the resolved module path. Quote the evidence. Measured for you already:
   \`apps/core\` is the ONLY workspace depending on \`@hmis/contracts\` (\`apps/web\` does not), and
   \`apps/core/jest.config.cjs\` currently has NO \`moduleNameMapper\` at all.
2. **The migration entrypoint.** \`apps/core/tsconfig.json\`'s \`include\` omits \`scripts/\`, but
   production migrations run \`scripts/migrate.ts\`. The plan's preference: widen core's build
   config to \`include\` src+scripts with \`rootDir: "."\` so \`dist/scripts/migrate.js\` exists. If
   \`scripts/\` fights that shape, fall back to the spike's \`rootDir: src\` plus a second small tsc
   pass — and **say which won and why**. The runtime image must carry \`drizzle/*.sql\` and
   \`drizzle/meta/\` for the migrator.
3. **The multi-stage \`Dockerfile\`** (repo root): corepack pnpm · \`--frozen-lockfile\` · contracts
   and core compiled · web built with \`vite build\` · a runtime stage pruned to production
   dependencies plus \`drizzle/\` and \`drizzle/meta/\` · a caddy stage with the built SPA at its
   static root. **One image, several entrypoints — the process is chosen by the container's
   command** (D3). Adding the ws hub or the renderer later must be a compose entry, never a
   second pipeline.
4. **\`.dockerignore\`** (repo root).
5. \`build\` scripts (and compiled start scripts) in both \`package.json\` files.

### Manifest facts measured by the main session at compile — do not re-derive them

- Root: \`"packageManager": "pnpm@10.0.0"\`, \`"engines": { "node": ">=22" }\`. Corepack pins cleanly.
- **\`pnpm verify\` = \`pnpm typecheck && pnpm lint && pnpm test\`, and \`typecheck\` is
  \`pnpm -r exec tsc --noEmit\`** — the \`--noEmit\` is on the CLI, so it overrides whatever your
  \`tsconfig.build.json\` sets and \`verify\` cannot be made to emit into the tree. That is the
  mechanism rule 5 relies on; do not disturb it.
- \`packages/contracts/package.json\` today: \`"main": "./src/index.ts"\`, \`"types":
  "./src/index.ts"\`. **Keeping \`types\` on \`src\` is what lets \`apps/core\`'s typecheck keep
  resolving contracts' TYPES from source even before any \`dist\` exists** — that is why the spike
  moved only \`main\`.
- \`apps/core/package.json\` has **no \`main\`, no \`types\`, and no \`build\` script**. Its run
  scripts today are \`start:dev\` (\`tsx watch src/main.ts\`) and \`start:worker\`
  (\`tsx src/worker.ts\`) — **both are the §2.58-broken path**. Add the build and compiled start
  scripts; T6's README documents the compiled commands as the production truth.

### AGENT-RULES rule 5 is live here in its original form

**Never emit compiled JavaScript into the source tree.** Emit goes to gitignored \`dist/\` only.
After every build run \`git status --porcelain\` on the server and confirm no \`.js\` appeared beside
any \`.ts\`. The spike checked exactly this and you must too.

### Acceptance is a BOOT, not a build

**\`docker build\` succeeding discharges nothing.** Flags ①②:
- **①** A container from your Dockerfile **boots** and **answers \`/health\`** — quote the response
  body and the HTTP code. And a **worker** container whose boot line **names the seven current
  jobs** — quote the line.
- **②** \`OpdRealtimeRegistrar\` **injects in the container**. This is §2.58's four-day-invisible
  defect measured in the artefact that actually ships: under \`tsx\` the API crashes at
  \`OpdRealtimeRegistrar.onModuleInit\`; under compiled output it starts clean. Prove it in YOUR
  image, not in the spike's.

All task-local containers run under a **temporary compose project you name** (e.g. \`hmis-t1build\`)
and you **remove them by explicit name before you report** (rule 7). Never a blanket prune.`,
    criteria: [
      'Both `tsconfig.build.json` files exist and `pnpm exec tsc -p tsconfig.build.json` exits 0 in each package, with the exit VALUE quoted (not a pipeline or wrapper status).',
      '`packages/contracts/package.json` has `main: ./dist/index.js` and `types: ./src/index.ts`.',
      'THE JEST-RESOLUTION PROOF: a check that COULD fail demonstrates the suite still resolves contracts SOURCE, not stale `dist`. A green suite alone is explicitly NOT acceptable. The evidence is quoted.',
      'The migration entrypoint is settled and the report says which shape won and why; the runtime image carries `drizzle/*.sql` and `drizzle/meta/`.',
      'FLAG ①: a container from the Dockerfile boots and answers `/health` — body and HTTP code quoted; a worker container boot line naming the seven current jobs is quoted verbatim.',
      'FLAG ②: `OpdRealtimeRegistrar` is proven to inject in the built image (not the spike\'s) — evidence quoted.',
      'Rule 5: `git status --porcelain` on the server shows no `.js` emitted beside any `.ts` after the builds.',
      'Detached `pnpm verify` green on the build host, exit VALUE read from a file; per-workspace counts quoted and not decreased against the stated baseline.',
      'Every task-local container and its compose project removed by explicit name; `docker ps -a` and `docker volume ls` quoted showing ONLY `hmis-db-1` and `hmis_hmis_pgdata`.',
      'No `pnpm-lock.yaml` diff.',
    ],
  },

  {
    id: 'T2',
    wave: 2,
    tier: 'CRITICAL',
    model: 'opus',
    gate: true,
    deps: ['T1'],
    commit: 'feat(core): migration 0016 — events partitioned monthly, legal holds, the dispatcher floor, the partition job',
    files: [
      'apps/core/drizzle/',
      'apps/core/src/kernel/db/schema/events.ts',
      'apps/core/src/kernel/db/schema/retention.ts',
      'apps/core/src/kernel/db/schema/retention.test.ts',
      'apps/core/src/kernel/db/schema/index.ts',
      'apps/core/src/kernel/db/schema/notifications.ts',
      'apps/core/src/kernel/events/dispatcher.ts',
      'apps/core/src/kernel/events/dispatcher.test.ts',
      'apps/core/src/kernel/worker/partitions.ts',
      'apps/core/src/kernel/worker/partitions.test.ts',
      'apps/core/src/kernel/worker/jobs.ts',
      'apps/core/src/kernel/worker/scheduler.test.ts',
      'apps/core/test/worker-runtime.e2e.test.ts',
      'apps/core/test/helpers/db.ts',
    ],
    brief: `## Task T2 — Migration 0016: the events partitioning conversion

**THIS IS THE MOST DANGEROUS TASK IN THE PLAN.** Read the plan's **D5**, **D6** (the
\`retention_legal_holds\` table only), **D7** (the prune index only), **Global Constraints 4 and 8**,
**Task 2**, **Assertion Book rows V1–V4** and **flag ③**. Read the spike report's **Question B**
in full.

### AGENT-RULES §6 governs everything you do here

A migration is an **irreversible host mutation**. Running \`db:generate\` and letting a suite
migrate **mutates all per-worker databases**, and \`git checkout\` does not undo it. Plan 08
pipeline A generated an \`0011\`, applied it, deleted the file, and left fourteen orphan tables and
a phantom migration row across seven databases — ~934k tokens, nothing delivered.

- **State the rollback in your report BEFORE you run the generator** (Global Constraint 8).
- **The recreate itself is ONE-WAY.** The stated rollback covers the ADDITIVE pieces only. The
  recreate's abort path is **STOP AND REPORT which databases carry it** — never delete the file,
  never clean up, never hand-edit \`drizzle/meta/_journal.json\`, never touch
  \`drizzle.__drizzle_migrations\` by hand.
- **Migration \`0016\` ONLY.** Latest on disk is \`0015_previous_shiver_man.sql\` (verified by the
  main session at compile). A second migration is a HALT.

### Start from the spike's verbatim SQL — it is measured, and it steps around three landmines

The spike report's Question B contains the exact \`BEGIN; … COMMIT;\` that worked **first try**
against a \`createdb -T\` copy of the dev database. Use it as your starting point. The three
landmines it steps around, each measured with a control, and **any rewrite must preserve all
three**:

1. **\`ALTER TABLE … RENAME\` does not rename indexes.** The seven \`ALTER INDEX … RENAME\`s must
   precede the new table or \`events_pkey\` collides.
2. **\`DROP TABLE events_old\` takes the sequence with it** unless
   \`ALTER SEQUENCE events_seq_seq OWNED BY events.seq\` runs **FIRST**. A control proved it: a toy
   sequence died with its renamed table. Get this order wrong and the migration **destroys \`seq\`
   allocation**.
3. **Copy by explicit column list** — a migrated database's physical column order is not the
   declaration order.

**Partition month boundaries are pinned to IST (\`+05:30\`)** and you state the timezone in the SQL
explicitly. The retention unit is an IST concept (\`dailyIst\` jobs, Indian statute); the spike
measured pruning working with IST bounds.

**Drizzle cannot express \`PARTITION BY\`** (spike: zero \`partition by\` hits in drizzle-kit, no
partitioning API in pg-core — labelled read-based, so confirm it rather than assume it). You
hand-write the SQL **inside** the generated \`0016\` migration file, preserving journal integrity.
**Expect the SNAPSHOT side to need care**: the generated snapshot will describe a table drizzle did
not create. Reconcile it deliberately and say what you did.

### The shape

- PK \`seq\` → **\`(seq, recorded_at)\`**; \`event_id\` UNIQUE → **\`(event_id, recorded_at)\`**. ULIDs
  are unique by construction; semantic dedup lives in the non-partitioned \`event_idempotency\`,
  whose idempotency index on \`events\` is already **plain, not unique**, with a shipped comment
  saying uniqueness lives elsewhere *"so it survives partitioning"*.
- A **DEFAULT partition** plus 3 months pre-created ahead.
- **\`retention_legal_holds\`** (D6's table): id · \`patient_id\` nullable (null = a global hold) ·
  reason NOT NULL · \`released_at\` nullable · created_at/created_by. Schema file + test. Export it
  from \`schema/index.ts\`.
- **The notifications prune index \`(status, updated_at)\`** (D7) rides this migration.
- **\`createEventPartitions\`**, a \`Scheduler\` \`dailyIst\` job, code constant
  \`CREATE_EVENT_PARTITIONS_IST = "00:15"\` beside the existing three in \`jobs.ts:18-20\`.
  Idempotent create-if-not-exists for the next 3 months. It **emits no event** — a monthly
  create-if-not-exists is not a fact the hospital record needs; the partitions' existence is the
  record. \`pg-boss\` is dead and must not appear (GC9).
- **\`test/helpers/db.ts\`**: \`retention_legal_holds\` joins the truncate list, and you **verify
  TRUNCATE works on the partitioned parent**.

### GLOBAL CONSTRAINT 4 — the dispatcher edit is BYTE-BOUNDED

\`dispatcher.ts:138\` says in as many words that Plan 11's partition floor is **one added
predicate**, and \`:16-20\` names the structural fix it completes. You add **ONE predicate to the
one-WHERE-chain window, plus one floor lookup. Nothing else.**

**The claim (\`:209-217\`), the \`greatest\` cursor advance (\`:224-229\`), the in-loop backoff filter
(\`:170-173\`) and the LEFT JOIN stay BYTE-IDENTICAL.** A diff beyond the floor predicate and its
lookup is a task failure, and it is on the plan's HALT list.

The floor: \`recorded_at >= date_trunc('month', <recorded_at of the cursor's seq>)\`. A missing
cursor row (cursor 0, or a dropped month) **degrades to no floor** — pruning is an optimization
and the seq predicate still bounds correctness. Month truncation absorbs seq/recorded_at skew
(\`recorded_at\` is transaction-start time).

Measured by the spike so you can recognise success: the **unmodified** shipped dispatcher was
already green against the partitioned table (3 delivered then 0), and the floor predicate prunes
**at plan time** — the out-of-floor partition is **absent from the \`EXPLAIN\` output entirely**,
not merely never executed. **But the DEFAULT partition is NEVER pruned by the floor** (it can hold
any month), which is why pre-created months are load-bearing rather than hygiene.

### Mutants — CRITICAL tier, AGENT-RULES §3 in full

- **V1 (a pre-declared P row — the Book's own stated input is a PREDICTION you must confirm).**
  Assertion: the floor prunes and does not SKIP — an undelivered event in the cursor's own month
  is still delivered. Mutant: compute the floor from \`now\` instead of from the cursor's seq.
  Stated input: cursor seq in month M, an undelivered event later in M, \`now\` in M+1 → shipped
  delivers it; the mutant's floor is M+1 and misses it. **If both survive on that input, the
  route is to ADJUST THE INPUT and record the adjustment in the Book — never to accept the
  mutant.**
- **V4.** \`createEventPartitions\` is idempotent and creates ahead. Mutant: drop the
  if-not-exists guard. Input: run twice for the same month set → shipped no-ops, mutant errors.
- **V2 and V3 are DRILLS, not mutants** — \`seq\` stays monotone through the recreate and
  \`RETURNING seq\` is intact (append after conversion, dispatcher cycle delivers it); rows land in
  their month's partition and out-of-range lands in DEFAULT (quote \`tableoid::regclass\` per row).

Rule 21: build every mutant as a **separate scratch file beside the source**, never by editing,
moving or reverting the shipped file. A mutant that dies at TYPECHECK proves nothing. Run isolated
and prove isolation from the runner's OUTPUT (rule 19). Quote expected vs received.

### §2.65 — CARRIED-FORWARD, MULTI-OWNER SEQUENTIAL FILES

\`jobs.ts\`, \`scheduler.test.ts\` and \`test/worker-runtime.e2e.test.ts\` are **multi-owner sequential**
files and they are in your Files list ON PURPOSE:
- \`scheduler.test.ts\` was already edited by **Phase 0 R0-2** (which added \`notifyStuckAfterMs\` to
  the \`CENSUS_INTERVALS\` object literal). **T5 will edit all three after you.** Registering an
  eighth job means the censuses go **7 → 8**: \`THE_SEVEN\` at \`scheduler.test.ts:115\` and at
  \`test/worker-runtime.e2e.test.ts:94\`, plus the set-equality assertions. Rename the constants if
  the name no longer tells the truth, and keep both files in step.
- You do **NOT** widen the \`JobIntervals\` \`Pick\` — a \`dailyIst\` registration needs no interval
  key. T5 widens it.

### A LIVE CI HAZARD YOU MUST KNOW ABOUT

\`scheduler.test.ts\`'s L14 25-fake-hour census is **a measured flake**: the main session found it
red on **two of the last twenty-five commits on \`main\`**, both of them DOCS-ONLY commits, failing
with an empty or partial \`invoked\` set under CI's slower container. It is starvation-sensitive,
not logic-sensitive. **Do not "fix" it, do not weaken it, and do not change its timing.** If you
see it fail locally, re-run it before diagnosing. Report honestly if you observe it.

### Flag ③

\`EXPLAIN (ANALYZE)\` output demonstrating **plan-time** pruning goes in your report verbatim — the
out-of-floor partition must be ABSENT from the plan, not present-with-zero-rows.`,
    criteria: [
      'The rollback statement appears in the report BEFORE any generator output, per Global Constraint 8 — and states plainly that the recreate itself is one-way and its abort path is STOP-AND-REPORT.',
      'Exactly ONE migration exists and it is `0016`. `drizzle/meta/_journal.json` was never hand-edited and no `drizzle.__drizzle_migrations` row was touched by hand.',
      'The migration SQL preserves all three measured landmines: index renames precede the new table; `ALTER SEQUENCE … OWNED BY events.seq` precedes `DROP TABLE events_old`; the copy uses an explicit column list. Partition bounds state `+05:30` explicitly.',
      'The drizzle snapshot is reconciled to the hand-written SQL and the report says exactly what was done to it.',
      'GC4: `git diff` of `dispatcher.ts` is the floor predicate plus its lookup and NOTHING else — the claim, `greatest` cursor advance, backoff filter and LEFT JOIN are byte-identical. The diff is quoted.',
      'V1 mutant BUILT and DIED, with the isolation line and expected-vs-received quoted. V1 is a P row: if both survive on the Book\'s stated input, the input was adjusted and the adjustment recorded — the mutant was NOT accepted.',
      'V4 mutant BUILT and DIED, with counts and expected-vs-received quoted.',
      'V2 and V3 drills executed: `seq` monotone through the recreate with `RETURNING seq` live; `tableoid::regclass` quoted per inserted row showing month routing and DEFAULT fallback.',
      'FLAG ③: `EXPLAIN (ANALYZE)` output quoted showing the out-of-floor partition ABSENT from the plan (pruned at plan time, not merely unexecuted).',
      'Both censuses moved 7 → 8 (`scheduler.test.ts` and `test/worker-runtime.e2e.test.ts`) and both files pass; the `JobIntervals` Pick was NOT widened.',
      '`retention_legal_holds` ships with its schema file, its test, and its export from `schema/index.ts`; `test/helpers/db.ts` truncates it and TRUNCATE on the partitioned parent is verified.',
      'The notifications `(status, updated_at)` prune index rides 0016.',
      '`createEventPartitions` is registered as `dailyIst` at code constant `CREATE_EVENT_PARTITIONS_IST = "00:15"`, is idempotent, creates 3 months ahead, and emits no event. No `pg-boss` anywhere.',
      'Detached `pnpm verify` green, exit VALUE from a file; per-workspace counts quoted and not decreased.',
      'Server tree clean, no mutant/scratch residue; `docker ps -a` and `docker volume ls` show only `hmis-db-1` and `hmis_hmis_pgdata`. No `pnpm-lock.yaml` diff.',
    ],
  },

  {
    id: 'T3',
    wave: 3,
    tier: 'CRITICAL',
    model: 'opus',
    gate: true,
    deps: ['T2'],
    commit: 'feat(infra): hmis-prod compose and Caddy — the deploy script, TLS by hostname, the parity pin',
    files: [
      'apps/core/test/caddyfile-parity.test.ts',
      'docker/prod/docker-compose.prod.yml',
      'docker/prod/Caddyfile',
      'docker/prod/.env.prod.example',
      'docker/prod/deploy.sh',
    ],
    brief: `## Task T3 — \`hmis-prod\` compose, Caddy, and the deploy script

Read the plan's **D3**, **D4**, **D11**, **D12**, **D13**, **D14**, **Task 3**, **Global
Constraints 1, 2, 12, 13** and **flags ④⑧**. Read the spike report's **Question E**.

### Rule 7 as amended 2026-08-22 — read it before you create anything

You may create containers, and ONLY under the compose project **\`hmis-prod\`** (or a clearly
temporary project of your own that you remove before you report). **Dev and production
deliberately do not share a project name**, so a \`compose down\`/\`up\` against one can never act on
the other. **\`hmis-db-1\` and the \`hmis_hmis_pgdata\` volume are the DEV DATABASE — never stop,
remove, rebuild or prune them.** A blanket \`docker system prune\` / \`volume prune\` / \`rmi -a\` is
**forbidden outright, always** — remove by explicit name.

**Rule 3 as amended:** \`/opt/hmis\` and \`/opt/hmis-prod\` are the only writable paths. **NO writes
to \`/tmp\`, ever.** \`/opt/hmis-prod\` holds deploy-script-managed configs and the production
\`.env\` ONLY — never scratch, never a mirror, never a checkout.

### GLOBAL CONSTRAINT 1 — stage-3 portability is a task-failure condition

No provider-specific primitive in the deployable: no cloud load balancer, no cloud volume as a
hard dependency, no cloud DNS API, no cloud secrets manager. **The test you can be failed on:**
*if the on-prem box were racked tomorrow, what in this diff would have to be REWRITTEN rather
than RE-POINTED? Nothing.*

### GLOBAL CONSTRAINT 2 — no secret in git, ever

No \`.env\`, no key, no R2 credential, no cipher passphrase. \`.env.prod.example\` carries
**placeholders only**. Production secrets live in \`/opt/hmis-prod\`, chmod 600.

### What you build

**\`docker/prod/docker-compose.prod.yml\`** — top-level \`name: hmis-prod\`. Services: \`db\` on
**\`127.0.0.1:5434\`** with its own volume · \`api\` · \`worker\` · \`caddy\` on **80/443**.
*(Monitoring services arrive in T6 and pgBackRest's db image in T4 — you are the FIRST of three
sequential owners of this file. Leave it clean for them.)*
- \`restart: unless-stopped\` everywhere.
- Healthchecks: api via \`/health\`, db via \`pg_isready\`.
- **The worker deliberately has NO compose healthcheck** (D12) — it has no HTTP surface, its
  liveness is its heartbeat row, and that is what T6's alert rule reads. A \`pgrep\`-style check
  would assert the wrong thing. Do not add one.
- **Resource limits per service**, values informed by the spike's measurement. Load-bearing under
  ruling 2 (production shares the build host), not hygiene.
- Port map, stated once: dev Postgres 5433 **untouched** · prod Postgres \`127.0.0.1:5434\` ·
  Caddy 80/443 · Grafana \`127.0.0.1:3001\` and Prometheus \`127.0.0.1:9090\` (T6) · api and
  exporters compose-network-internal only.
- Images are **built from the checkout and run from the daemon** — production never executes from
  \`/opt/hmis\`'s working tree.

**\`docker/prod/Caddyfile\`** — start from the spike's measured config. Its Question-E verdict:
**a bare \`reverse_proxy\` is sufficient; nothing extra is needed for the WebSocket upgrade.** The
spike observed HTTP 101 with \`sec-websocket-accept\`, the gateway's own auth-timeout frame, and
close **4001** over the proxied connection; the direct control was byte-identical; a wrong-path
upgrade came back **502**. Production adds:
- The SPA served as static files with an \`index.html\` fallback.
- Reverse-proxy of the API path prefixes and \`/ws\` to \`api:3000\`.
- **Automatic HTTPS on the real hostname \`hmis.crkmch.com\`** — verified by the main session at
  compile as resolving to \`62.238.106.231\` **unproxied**, which is what ACME needs.
- HTTP→HTTPS redirect on; security headers set.
- No extra auth gate in front of the app — Plan 02's auth is the gate.

**\`docker/prod/.env.prod.example\`** — placeholders only: \`DATABASE_URL\` pointing at the prod db
service, \`SECRET_KEY\` empty with a pointer to the ceremony (D11: generated on the box with
\`openssl rand -hex 32\` into \`/opt/hmis-prod/.env\`, chmod 600, escrowed — T6 documents it), R2
keys empty.

**\`docker/prod/deploy.sh\`** — idempotent. D13's sequence: build images → copy configs to
\`/opt/hmis-prod\` → \`db\` up → **migrations from inside the image** (D2) → \`api\`/\`worker\`/\`caddy\`
up → \`/health\` through Caddy green. It **refuses to run** if \`/opt/hmis-prod\` is missing or if
80/443 are occupied.
**SEAM — DO NOT ADD THE CURSOR-SEEDING STEP.** D13's full sequence includes \`seed-cursors\`, but
\`scripts/seed-cursors.ts\` is created by **T6, three waves after you**. A \`deploy.sh\` that calls it
now would fail your own bring-up drill. T6 adds the slot; you leave the seam. Say so in a comment
so the next owner finds it. *(You are the first of three sequential owners of this file: T4 adds
the weekly restore-drill cron entry, T6 adds the seeding slot.)*

**\`apps/core/test/caddyfile-parity.test.ts\`** — D14's drift pin. The API prefix list exists in one
place today, \`apps/web/vite.config.ts\`'s dev proxy, and the Caddyfile must mirror it forever.
Parse both files and assert the Caddyfile's proxy matchers equal the vite proxy keys, so a future
module adding a prefix breaks the test until it adds the Caddy route.
**§2.49 — THIS TEST CAN PASS VACUOUSLY AND MUST NOT.** If either parser returns an empty set on a
format it does not recognise, \`[] === []\` passes forever. Measured for you: \`vite.config.ts\`
declares **nine** prefixes — \`/auth /patients /approvals /workflow /health /opd /billing /alerts
/ws\`. **Assert the parsed vite set is non-empty, has 9 entries, and contains \`/ws\` BEFORE
asserting equality**, and demonstrate the test FAILING when a prefix is removed from the Caddyfile
(a scratch mutation you revert — never a committed one).
\`apps/core/jest.config.cjs\`'s \`testMatch\` already covers \`**/test/**/*.test.ts\`, so the file
will be collected.

### Acceptance is DRILLS, and a transcript is evidence only if the drill ran (GC12)

- **The full bring-up drill on the box**: \`deploy.sh\` from zero.
- **\`/health\` answering THROUGH Caddy over HTTPS on the real hostname** \`hmis.crkmch.com\`.
- **FLAG ④** — a **WebSocket frame through Caddy over HTTPS**. Already discharged once by the
  spike over plain HTTP on a high port; you re-prove it in the real bring-up on the real hostname
  with TLS. Observe the status line, do not infer it.
- **FLAG ⑧ — THE COEXISTENCE DRILL, which is ruling 2's whole acceptance**: \`hmis-prod\` fully up
  **and** the dev \`pnpm verify\` green beside it. Both transcripts in your report. The dev suite's
  databases and the prod database are different containers, different volumes, different ports.
  *(The main session re-runs this drill itself in Phase 4; yours does not replace that.)*

**The dev compose is untouched.** 80/443 were verified free by the main session at compile (nginx
stopped and disabled); if you find a listener there, **HALT and report** rather than clearing it.`,
    criteria: [
      '`docker-compose.prod.yml` declares top-level `name: hmis-prod`; db is bound to `127.0.0.1:5434` with its own volume; caddy holds 80/443; `restart: unless-stopped` everywhere; api and db have healthchecks and the worker deliberately has none; resource limits are set per service.',
      'The Caddyfile serves the SPA with an index.html fallback, reverse-proxies all nine API prefixes plus `/ws` to `api:3000`, does automatic HTTPS on `hmis.crkmch.com`, redirects HTTP→HTTPS, and sets security headers.',
      '`.env.prod.example` contains placeholders ONLY — no secret, no real key, no R2 credential. GC2 holds across the whole diff.',
      '`deploy.sh` is idempotent, refuses to run when `/opt/hmis-prod` is missing or 80/443 are occupied, and runs migrations from INSIDE the image. It deliberately does NOT call seed-cursors, and a comment marks the seam for T6.',
      'The caddyfile-parity test asserts the vite set is non-empty, has 9 entries and contains `/ws` BEFORE asserting equality, and was demonstrated FAILING when a Caddyfile prefix was removed (scratch mutation, reverted).',
      'DRILL: `deploy.sh` ran from zero on the box; transcript quoted.',
      'DRILL: `/health` answered THROUGH Caddy over HTTPS on `hmis.crkmch.com`; response body and HTTP code quoted.',
      'FLAG ④: a WebSocket upgrade through Caddy over HTTPS on the real hostname — the 101 status line observed and quoted, plus a frame.',
      'FLAG ⑧: the coexistence drill — `hmis-prod` fully up AND dev `pnpm verify` green beside it, both transcripts quoted, dev suite exit VALUE read from a file.',
      'GC1 portability: nothing in the diff is provider-specific — the report states what would need RE-POINTING (not rewriting) on on-prem metal.',
      'Rule 7: no dev container or volume was stopped, removed, rebuilt or pruned; no blanket prune of any kind was run; `docker ps -a` and `docker volume ls` quoted.',
      'Detached `pnpm verify` green, exit VALUE from a file; counts not decreased. Server tree clean. No `pnpm-lock.yaml` diff.',
    ],
  },

  {
    id: 'T4',
    wave: 4,
    tier: 'CRITICAL',
    model: 'opus',
    gate: true,
    deps: ['T3'],
    commit: 'feat(infra): pgBackRest to R2 — archiving, nightly fulls, and a restore drill that restores',
    files: [
      'docker/prod/docker-compose.prod.yml',
      'docker/prod/deploy.sh',
      'docker/prod/db.Dockerfile',
      'docker/prod/pgbackrest/pgbackrest.conf',
      'docker/prod/drill/restore-drill.sh',
    ],
    brief: `## Task T4 — pgBackRest to Cloudflare R2, and the weekly restore drill

Read the plan's **D8**, **D4**, **Task 4**, **Global Constraints 1, 2, 7, 12, 13** and **flag ⑤**.
Read the spike report's **Question C**.

### Why this task matters more than its size suggests

**On a single server, backups are not one layer of defence — they are the only one.** Stage 1 has
no standby, no promotion, no fencing. **A backup nobody has restored is a belief, not a backup.**

### FORK-C is RESOLVED and it DISSOLVED under measurement

pgBackRest lives **inside the Postgres image**. This is not a preference: \`archive_command\`
executes inside the postgres server's container, and the spike booted a postgres container with
\`archive_command='pgbackrest … archive-push %p'\` and no binary installed, producing
\`FATAL: archive command failed with exit code 127\`. A **sidecar** or **host** placement therefore
**cannot do continuous WAL archiving at all**. \`restore_command\` has the same shape. Both losing
branches are dead on a measured fact.

**\`docker/prod/db.Dockerfile\`**: \`postgres:16\` plus the pgbackrest package — a small derived
image. The compose \`db\` service swaps onto it (you are the **second of three sequential owners**
of \`docker-compose.prod.yml\`; T3 created it, T6 adds monitoring after you). The repo and spool
live on **volumes**, which is where D4's destination flexibility actually belongs.

### Two measured config facts you must carry, or you will fail exactly as the spike first did

1. **\`POSTGRES_USER=hmis\` breaks pgBackRest's defaults.** The docker entrypoint creates the
   superuser named by \`POSTGRES_USER\`; pgBackRest connects as the OS user. The spike's first
   stanza-create failed \`FATAL: role "postgres" does not exist\` →
   \`ERROR: [056]: unable to find primary cluster\`. **\`pg1-user=hmis\` is required in
   \`pgbackrest.conf\`.** The dev compose uses \`POSTGRES_USER: hmis\`, so production hits this.
2. **\`repo1-retention-full\` AND \`repo1-retention-archive\` must be set** or the repo grows without
   bound — every spike backup printed
   \`option 'repo1-retention-archive' is not set - archive logs will not be expired\`. This is the
   same class of problem D6/D7 exist for, one layer down.

### The R2 leg — and the HALT that guards it

- \`repo-type=s3\` pointed at **Cloudflare R2** (ruling 3), with **\`repo-cipher-type=aes-256-cbc\`**
  (spec E-2: repo-level client-side encryption — **R2 only ever sees ciphertext**).
- **Credentials live at \`/opt/hmis-prod/.env.r2\` (chmod 600).** The main session verified at
  compile that the file exists with 600 perms. **Read them from there. They never enter git, never
  enter the image, and never appear in your report** (GC2) — quote around them, never through them.
- **The spike's repo was a LOCAL VOLUME. No byte travelled remotely. Your drill against the
  owner's real R2 bucket is the FIRST remote proof.**
- **HALT CONDITION:** if the credentials are absent, unreadable, or no longer authenticate, **STOP
  AND REPORT**. The plan forbids shipping an untested remote leg, and this is not a judgement call
  delegated to you.

### The drill — and Global Constraint 7 says what it may not be

**\`docker/prod/drill/restore-drill.sh\`.** **IT IS NOT A \`--dry-run\`. A \`--dry-run\` discharges
nothing.** It performs a **REAL restore into a scratch database** (its own container or schema),
runs the migrator's own consistency check, asserts a row count and a known event id, and drops the
scratch database.

**SEAM — the drill emits an EXIT CODE and a TRANSCRIPT ONLY, no events.** The verdict events
(\`backup.drill_passed\` / \`backup.drill_failed\`) are defined in **T5's**
\`kernel/retention/events.ts\`, one wave after you. Emitting them now would be a forward reference.
**T5 wires the evented verdict into this same script** — you are its first of two sequential
owners. Structure the script so that wire is one clean insertion point, and mark it with a comment
so T5 finds it.

**Scheduling: a host cron entry installed by \`deploy.sh\`** (weekly, IST off-hours) — **NOT** a
Scheduler job. The worker must not hold restore privileges or block on a multi-minute restore.
You are the **second of three sequential owners** of \`deploy.sh\` (T3 created it; T6 adds the
cursor-seeding slot after you). Add the cron install; change nothing else in it.

Measured by the spike on a 78 MB cluster, so you know what good looks like: full **3 s** · incr
**2 s** · **restore 2 s**, verified by booting a **second postmaster** on the restored directory
and querying it (2002 rows + a sentinel row written after the last backup — i.e. WAL was replayed
past it).

### Acceptance — flag ⑤

A **completed restore** with **timings and repo size**, transcript in your report, and **the R2 leg
exercised for real** against the owner's bucket. Verify the restore by reading data out of the
restored cluster, not by trusting pgbackrest's exit code.

Rule 7: every container you create belongs to \`hmis-prod\` or a clearly temporary project you
remove by explicit name before reporting. **\`hmis-db-1\` and \`hmis_hmis_pgdata\` are untouchable.
Once \`hmis-prod\` exists its containers and volumes are PRODUCTION DATA and are exactly as
untouchable — no agent stops, restarts or removes one unless its brief says so in as many words.**
Your brief says so ONLY for the drill's own scratch. No blanket prune, ever.`,
    criteria: [
      '`db.Dockerfile` derives from `postgres:16` and installs pgbackrest; the compose `db` service swaps onto it and nothing else in `docker-compose.prod.yml` changed.',
      '`pgbackrest.conf` sets `pg1-user=hmis`, BOTH `repo1-retention-full` and `repo1-retention-archive`, `repo-type=s3` pointed at R2, and `repo-cipher-type=aes-256-cbc`.',
      'Continuous WAL archiving plus nightly fulls are configured, with `archive_command` running inside the postgres container per FORK-C.',
      'R2 credentials were read from `/opt/hmis-prod/.env.r2` and appear NOWHERE in the diff, the image, or the report. GC2 holds.',
      'FLAG ⑤: a REAL restore completed against an R2-backed backup — not a `--dry-run`. Transcript, timings and repo size quoted, and the restored data was read back (row count + known event id) to verify it.',
      'The R2 remote leg was exercised for real against the owner\'s bucket; if credentials had been absent or invalid the task would have HALTED rather than shipped an untested leg.',
      '`restore-drill.sh` emits exit code + transcript ONLY and defines no events; a clearly marked insertion point is left for T5\'s evented verdict wire.',
      '`deploy.sh` gained the weekly host cron entry (IST off-hours) and nothing else; the drill is NOT a Scheduler job.',
      'Rule 7: no dev container/volume touched, no `hmis-prod` container stopped or removed outside the drill\'s own named scratch, no blanket prune. `docker ps -a` and `docker volume ls` quoted.',
      'Detached `pnpm verify` green, exit VALUE from a file; counts not decreased. Server tree clean. No `pnpm-lock.yaml` diff.',
    ],
  },

  {
    id: 'T5',
    wave: 5,
    tier: 'CRITICAL',
    model: 'opus',
    gate: true,
    deps: ['T4'],
    commit: 'feat(core): retention — partitions dropped under structural holds, notifications pruned, inert by default',
    files: [
      'apps/core/src/kernel/retention/sweep.ts',
      'apps/core/src/kernel/retention/sweep.test.ts',
      'apps/core/src/kernel/retention/events.ts',
      'apps/core/src/kernel/config.ts',
      'apps/core/src/kernel/config.test.ts',
      'apps/core/src/kernel/worker/jobs.ts',
      'apps/core/src/kernel/worker/scheduler.test.ts',
      'apps/core/test/worker-runtime.e2e.test.ts',
      'docker/prod/drill/restore-drill.sh',
    ],
    brief: `## Task T5 — Retention: events by partition, notifications by row

Read the plan's **D6**, **D7**, **Task 5**, **Global Constraints 5, 6, 9, 11, 14**, **Assertion
Book rows V5–V9 and V12**, and **flag ⑥**.

### Weight your skepticism here

**Deleting a clinical record is not a decision a plan makes.** Two rows on this surface are ones
where a polite pass is the worst possible outcome: **V5** (a held month must be undroppable) and
**V6** (disabled means inert). **A dropped held month is a legal record gone.**

### GLOBAL CONSTRAINT 5 — the mechanism ships INERT

\`RETENTION_ENABLED\` defaults to **false**. The owner flips it only with a value counsel has
signed (ruling 6). **Flipping that default, or weakening the hold check, is on the plan's HALT
list** — not a judgement delegated to you.

### What you build

**\`kernel/retention/sweep.ts\` — \`retentionSweep(db, opts)\`:**
- **Partition inventory and DROPS — never row deletes.** Dropping whole partitions is the entire
  point of partitioning by the retention unit. **T2 already shipped the partition helpers in
  \`apps/core/src/kernel/worker/partitions.ts\` (three waves back) — IMPORT them, do not rewrite
  them.** That file is FROZEN to you: importing is not editing, but if you find you need to CHANGE
  it, that is a plan defect and you report it rather than widening your scope.
- **A legal hold checked STRUCTURALLY.** A hold is a **row** in T2's \`retention_legal_holds\`, not
  a config flag: \`patient_id\` nullable (null = a **global** hold), \`released_at\` nullable. A
  partition whose month contains any event of a patient under an active hold — **or any active
  global hold** — is never dropped, and the refusal is evented (\`retention.drop_blocked\`).
- **The DEFAULT partition and the current/adjacent months are NEVER dropped, regardless of
  configuration.**
- Drops are evented (\`retention.partition_dropped\`).
- **The companion sweep the spike discovered nobody owned.** A partition drop **ORPHANS** the side
  tables — measured: 3 \`event_idempotency\` and 3 \`event_deliveries\` rows survived the spike's
  drop, by design (there are no FKs), silently moving the growth problem one table over. Behind the
  **same gate** and the **same events window**, the sweep also deletes:
  \`event_idempotency\` by \`recorded_at\` · \`event_deliveries\` by \`updated_at\` **where status is
  \`done\` or \`parked\` — a \`retrying\` row is NEVER touched at any age** · \`event_dead_letters\` by
  \`parked_at\`. Counts evented once per run (\`retention.side_tables_pruned\`).
  **Stated consequence, accepted by the plan, do not re-litigate:** deleting an idempotency row
  older than the window re-opens semantic dedup for a key whose event no longer exists.
- **\`notifications\` terminal-row prune** (D7): \`sent\` · \`expired\` · \`suppressed\` ·
  \`undeliverable\` older than \`NOTIFY_RETAIN_DAYS\`, deleted **in bounded batches**, riding T2's
  \`(status, updated_at)\` index. **GLOBAL CONSTRAINT 6: \`queued\` and \`sending\` are NEVER pruned at
  any age.** A \`sending\` row is the only record that a message may already be with a patient.
  Prunes are evented with a **count**, not per row (\`retention.notifications_pruned\`).

**\`kernel/retention/events.ts\`** — all six definitions: \`retention.partition_dropped\`,
\`retention.drop_blocked\`, \`retention.notifications_pruned\`, \`retention.side_tables_pruned\`, and
**T4's two drill verdicts \`backup.drill_passed\` / \`backup.drill_failed\`** (the §2.47 seam).

**\`docker/prod/drill/restore-drill.sh\` — THE T4 SEAM, and it is in your Files list on purpose.**
T4 created this script one wave ago emitting an **exit code and transcript only**, with a marked
insertion point, because these event definitions did not exist yet. **You wire the evented
verdict.** Keep the change to that wire.

**Config — three keys, all defaulted, no \`.env\` change anywhere:** \`RETENTION_ENABLED\` (default
\`false\`), \`RETENTION_EVENTS_MONTHS\` (default \`120\`), \`NOTIFY_RETAIN_DAYS\` (default \`180\`).

**Registration:** \`retentionSweep\` as a \`Scheduler\` \`dailyIst\` job, code constant
\`RETENTION_SWEEP_IST = "01:15"\`. Jobs ride the shipped \`Scheduler\`; **\`pg-boss\` is dead and must
not appear** (GC9).

### GLOBAL CONSTRAINT 14 — config that ships must DEMONSTRABLY take effect

This is the \`NOTIFY_STUCK_AFTER_MS\` scar, and Phase 0 R0-2 fixed exactly that defect one surface
over: a key that parsed, was asserted to parse, and reached nothing. **\`config.test.ts\` asserting
the keys parse is NOT protection** — that is §2.60's exact class. Every new key needs an assertion
that a **non-default value changes behaviour through the PRODUCTION WIRING SHAPE** (V9).

### §2.65 — CARRIED-FORWARD, MULTI-OWNER SEQUENTIAL FILES

- **You widen the \`JobIntervals\` \`Pick\`** in \`jobs.ts\` with \`retentionEnabled\`,
  \`retentionEventsMonths\`, \`notifyRetainDays\`. **WIDENING IT IS A TYPE EVENT** (the shipped
  comment at \`jobs.ts:68-79\` says so): every \`JobIntervals\` OBJECT LITERAL stops compiling until
  it carries the new keys.
  Measured for you by the main session: there is exactly **ONE** such literal —
  \`CENSUS_INTERVALS\` in \`scheduler.test.ts\`. \`worker.ts\` and \`test/worker-runtime.e2e.test.ts\`
  both pass the whole \`AppConfig\`, which satisfies a wider \`Pick\` structurally, and there is **no
  \`AppConfig\` object literal anywhere in the repo** — so adding three keys to \`AppConfig\` breaks
  nothing outside \`config.ts\`/\`config.test.ts\`. Both are yours.
- **The censuses go 8 → 9** in BOTH files (\`scheduler.test.ts\` and
  \`test/worker-runtime.e2e.test.ts\`). \`jobs.ts\` and both census files were edited by R0-2 and T2
  before you; you are the LAST owner. Keep them in step.

### A LIVE CI HAZARD

\`scheduler.test.ts\`'s L14 25-fake-hour census is **a measured flake** — red on two of the last
twenty-five commits on \`main\`, both DOCS-ONLY, with an empty or partial \`invoked\` set under CI's
slower container. Starvation-sensitive, not logic-sensitive. **Do not "fix" it, weaken it, or
change its timing.** Re-run before diagnosing, and report honestly if you observe it.

### Mutants — CRITICAL tier, AGENT-RULES §3 in full, SIX required-DIED rows

- **V5** — a month intersecting an ACTIVE hold is never dropped; the refusal is evented. Mutant:
  delete the hold check. Input: an ancient month, a hold on a patient with one event in it,
  \`RETENTION_ENABLED=true\` → shipped keeps the partition and appends \`retention.drop_blocked\`;
  the mutant drops it. **This is flag ⑥ and it is the row the plan says a polite pass is worst on.**
- **V6** — \`RETENTION_ENABLED=false\` → the sweep is inert. Mutant: ignore the flag. Input: ancient
  months AND ancient terminal notifications present, flag false → zero drops, zero deletes, zero
  events. **The fixture MUST carry the ancient data or this assertion is vacuous** (§2.49): with an
  empty fixture "zero of everything" passes under the mutant too. Covers the companion sweep.
- **V7** — \`queued\`/\`sending\` survive any age. Mutant: the prune filter loses the status
  predicate. Input: a \`sending\` row dated years back → shipped keeps it; mutant deletes it.
- **V8 (a pre-declared P row)** — terminal rows: older-than-window deleted, inside-window
  retained. Mutant: boundary comparison flipped. Input: two \`sent\` rows straddling
  \`NOTIFY_RETAIN_DAYS\` by one day each side. **If both survive on that input, ADJUST THE INPUT and
  record the adjustment in the Book — never accept the mutant.**
- **V9** — retention config reaches the sweep through the PRODUCTION REGISTRATION (GC14). Mutant:
  the registration drops the values. Input: register with \`retentionEventsMonths: 1\` + enabled;
  behaviour differs from the 120-month default on a 2-month-old partition.
- **V12** — the companion sweep deletes only outside the window and never a \`retrying\` delivery.
  Two mutants: (a) drop the window predicate, (b) drop the status guard. Input: one fresh \`done\`
  delivery + one ancient \`retrying\` + one ancient \`done\`, sweep enabled → shipped deletes only the
  ancient \`done\`; mutant (a) deletes the fresh row; mutant (b) deletes the \`retrying\`.

Rule 21: separate scratch file beside the source, never edit/move/revert the shipped file; a
mutant dying at TYPECHECK proves nothing; §2.61's nominal-typing trap for classes with \`private\`
members. Run isolated, prove isolation from OUTPUT, quote expected vs received.

**Global Constraint 11:** every clock-reading function takes \`now: Date = new Date()\`; no
wall-clock timing assertions.`,
    criteria: [
      'GC5: `RETENTION_ENABLED` defaults to `false` and the shipped sweep is inert by default. The default was NOT flipped and the hold check was NOT weakened.',
      'GC6: `queued` and `sending` notifications are never pruned at any age — proven by V7\'s mutant dying.',
      'The hold is structural: a row in `retention_legal_holds`, honouring both patient-scoped and GLOBAL (null `patient_id`) active holds; the DEFAULT partition and current/adjacent months are never dropped regardless of configuration.',
      'The companion sweep covers all three side tables (`event_idempotency` by `recorded_at`, `event_deliveries` by `updated_at` with `retrying` untouchable, `event_dead_letters` by `parked_at`) behind the same gate and window, with counts evented once per run.',
      'Notifications terminal-row prune runs in bounded batches and is evented with a count, not per row.',
      'All six event definitions live in `kernel/retention/events.ts`, including T4\'s `backup.drill_passed` / `backup.drill_failed`.',
      'THE T4 SEAM: `docker/prod/drill/restore-drill.sh` now emits the evented verdict, and the change is confined to that wire.',
      'Three config keys added, all defaulted, with NO `.env` change anywhere.',
      'GC14: each new key has an assertion that a NON-DEFAULT value changes behaviour through the production wiring shape — not merely that it parses (V9).',
      'FLAG ⑥ / V5 mutant BUILT and DIED: a held month survives an ENABLED sweep; expected-vs-received and the isolation line quoted.',
      'V6 mutant BUILT and DIED, with a fixture that carries ancient partitions AND ancient terminal notifications so the assertion cannot pass vacuously.',
      'V7, V9 mutants BUILT and DIED with quoted evidence. V12\'s BOTH mutants (window predicate, status guard) BUILT and DIED.',
      'V8 is a P row: BUILT and DIED, and if both survived on the Book\'s stated input the input was adjusted and the adjustment recorded — the mutant was NOT accepted.',
      '`retentionSweep` registered as `dailyIst` at `RETENTION_SWEEP_IST = "01:15"`; the `JobIntervals` Pick widened with the three keys; both censuses moved 8 → 9 and both files pass. No `pg-boss` anywhere.',
      'Detached `pnpm verify` green, exit VALUE from a file; counts not decreased. Server tree clean, no mutant residue. Container/volume roster unchanged. No `pnpm-lock.yaml` diff.',
    ],
  },

  {
    id: 'T6',
    wave: 6,
    tier: 'ROUTINE',
    model: 'sonnet',
    gate: false,
    deps: ['T5'],
    commit: 'feat(infra): monitoring on the box, cursor seeding, and the deployment runbook',
    files: [
      'apps/core/src/kernel/worker/seed-cursors.ts',
      'apps/core/src/kernel/worker/seed-cursors.test.ts',
      'apps/core/scripts/seed-cursors.ts',
      'docker/prod/docker-compose.prod.yml',
      'docker/prod/deploy.sh',
      'docker/prod/prometheus/prometheus.yml',
      'docker/prod/prometheus/alerts.yml',
      'docker/prod/postgres-exporter/queries.yml',
      'docker/prod/grafana/provisioning/dashboards/hmis.json',
      'docker/prod/grafana/provisioning/dashboards/dashboards.yml',
      'docker/prod/grafana/provisioning/datasources/prometheus.yml',
      'README.md',
    ],
    brief: `## Task T6 — Monitoring, cursor seeding, and the deployment runbook

Read the plan's **D9**, **D10**, **D11**, **D12**, **D13**, **Task 6**, **Assertion Book rows V10
and V11**, and **flags ⑦⑨**. Read the spike report's **Question D** and **finding 6**.

### FORK-D is RESOLVED — same box, by an order of magnitude

The reduced stack (Prometheus v2.53 + Grafana 11.1 + node_exporter + postgres_exporter) idles at
**≈96 MiB resident, ≈0% CPU — about 0.6% of the CX43** against a 15% branch threshold. The off-box
branch and the defer-Grafana branch are dead. Do not re-open them.

### Monitoring — joining the \`hmis-prod\` project

You are the **THIRD and last sequential owner** of \`docker/prod/docker-compose.prod.yml\` (T3
created it; T4 swapped the db image onto \`db.Dockerfile\`). Add prometheus, grafana, node_exporter
and postgres_exporter as services **in that same file**, under the same \`hmis-prod\` project name
(D13 pins the project to one top-level \`name:\`). **Change nothing T3 or T4 put there.**

- Grafana binds \`127.0.0.1:3001\`, Prometheus binds \`127.0.0.1:9090\` — SSH tunnel access, **no new
  public surface ships.**
- **\`postgres-exporter/queries.yml\`** — the custom query file the spike proved end to end. It
  served \`hmis_scheduler_heartbeat_staleness_seconds\` with **real per-job labels** from the
  already-shipped \`scheduler_heartbeats\` table (\`job\` PK, \`last_started_at\`, \`last_ok_at\`,
  \`last_error\`, \`last_duration_ms\`). **No new instrumentation is needed or wanted.**
- **Loki is deliberately deferred to stage 2** — on one box, \`docker compose logs\` and journald
  are the log story. Do not add it.
- Provisioned Grafana dashboard plus its dashboards.yml and datasource yml.

### FLAG ⑨ — the alert's blind spot, and it is the whole point of the rule

**\`prometheus/alerts.yml\` must treat a MISSING SERIES as alertable, not just a stale one.** The
spike measured \`scheduler_heartbeats\` holding **5 rows for 7 jobs**: a heartbeat row exists only
once a job has ever *started*. So alerting on the staleness of *existing* rows **misses a job that
never starts** — and the alert would be green precisely when the worker is at its most broken.

Ship **both legs**: the staleness threshold **and** an expected-jobs count / \`absent()\` check.
**Prove the missing-series leg by drill**: a job name with **no heartbeat row at all** must fire
the alert. The staleness leg alone cannot see it, so a drill that only ages a row discharges
nothing.

### Cursor seeding (D10) — flag ⑦

\`event_cursors.last_seq\` defaults to 0 and \`runDispatchCycle\` creates the row on first sight, so
the first cycle after a consumer is registered walks the **entire event history** at 100 rows/tick.
This is a volume concern, not a correctness one — consumers are idempotent.

- **\`kernel/worker/seed-cursors.ts\`** — \`seedCursors(db)\`, the importable logic. Seeds every
  production consumer's cursor at \`max(seq)\`, and **NEVER LOWERS AN EXISTING CURSOR** (V11).
- The consumer list comes from the one importable place it exists: **\`workerConsumers(db)\`'s keys**
  (\`kernel/worker/worker.module.ts\`, built by Plan 10 T5). Covers \`kernel.alerts\` and
  \`kernel.notify\`.
- **\`scripts/seed-cursors.ts\`** — a thin runner.
- **The shipped precedent is \`tail.ts:20\`** — *"floor = max(seq) at start (history is never
  replayed)"*. The tail solved this for itself on day one; the dispatcher's cursor is shared and
  claiming, so seeding belongs in a deployment step.

**The test MUST seed history FIRST** (V10). The flood has never actually been observed because the
dev DB holds no subscribed events — so a test that does not seed history first is asserting
nothing.

- **V10** — \`seedCursors\` leaves a new consumer at \`max(seq)\`; the next cycle delivers **nothing**.
  Mutant: write 0 / skip the upsert. Input: history seeded, THEN the consumer seeded, THEN one
  cycle → shipped delivers 0; the mutant begins a full replay.
- **V11** — \`seedCursors\` never lowers an existing cursor. Mutant: unconditional update. Input: an
  existing cursor **greater than** \`max(seq)\` → shipped leaves it untouched; the mutant regresses
  it and replay begins.

Build both mutants as separate scratch files beside the source (rule 21), run isolated, prove
isolation from OUTPUT, quote expected vs received.

**\`deploy.sh\` — you are the THIRD and last sequential owner.** T3 created it and deliberately left
the cursor-seeding seam open (its comment marks it), because \`scripts/seed-cursors.ts\` did not
exist for three waves. T4 added the restore-drill cron. **You add the seeding slot**, in D13's
position: after migrations, **before** \`api\`/\`worker\`/\`caddy\` come up. Change nothing else.

### The README Deployment section — written to the stranger-drill standard

A person who has never seen this system must be able to follow it. It carries:
- The deploy sequence.
- **The \`SECRET_KEY\` ceremony and escrow (D11)**: generated on the box with
  \`openssl rand -hex 32\` into \`/opt/hmis-prod/.env\`, chmod 600, escrow as a **printed runbook
  step**. This discharges \`.env.example:5\`'s promise that *"the production key is generated and
  escrowed in Plan 11"*. **No secret enters git** (GC2).
- The R2 credentials procedure (the file at \`/opt/hmis-prod/.env.r2\`, chmod 600 — **name the
  procedure, never the values**).
- The restore drill and **how to read its verdicts**.
- **The accepted shared-box failure mode (D13), documented not hidden**: a pipeline run on the dev
  side can contend with a live UAT session for CPU/IO. Name the symptom — **latency, never data** —
  and say the resource limits bound it. The dev suite's databases and the prod database are
  different containers, different volumes, different ports; a truncate cannot cross.
- **Stage-1 RPO/RTO stated HONESTLY for a single box**: RPO ≈ the WAL-push interval; RTO ≈
  measured restore time + bring-up. **NOT spec §12's <15 min, which assumes a standby this stage
  does not have.**
- **The §2.58 correction.** FORK-A resolved to COMPILED, so the production run commands are the
  compiled ones. The documented dev command has been broken since Plan 07 — \`tsx src/main.ts\`
  crashes at \`OpdRealtimeRegistrar.onModuleInit\` while \`node dist/main.js\` starts clean. Document
  what actually works.

**Global Constraint 1 (portability) still binds**: nothing provider-specific. **Global Constraint 3:
no new npm dependency — a \`pnpm-lock.yaml\` diff is a HALT.**`,
    criteria: [
      'Prometheus, Grafana, node_exporter and postgres_exporter join the SAME `docker-compose.prod.yml` under the `hmis-prod` project; nothing T3 or T4 placed in that file was changed. Grafana on `127.0.0.1:3001`, Prometheus on `127.0.0.1:9090`, no new public surface.',
      '`postgres-exporter/queries.yml` serves `hmis_scheduler_heartbeat_staleness_seconds` with per-job labels from the shipped `scheduler_heartbeats` table, with no new instrumentation.',
      'FLAG ⑨: `alerts.yml` carries BOTH the staleness leg AND a missing-series leg, and the missing-series leg was PROVEN BY DRILL against a job name with no heartbeat row. Transcript quoted.',
      'Loki was not added; it stays deferred to stage 2.',
      'FLAG ⑦: the seeding script run against a HISTORY-SEEDED database — cursor lands at `max(seq)` and the next cycle delivers zero. Transcript quoted.',
      'V10 mutant BUILT and DIED (history seeded FIRST), with isolation line and expected-vs-received quoted.',
      'V11 mutant BUILT and DIED: an existing cursor greater than `max(seq)` is left untouched; the unconditional-update mutant regresses it.',
      '`seedCursors` enumerates `workerConsumers(db)`\'s keys and never lowers an existing cursor.',
      '`deploy.sh` gained ONLY the cursor-seeding slot, positioned after migrations and before api/worker/caddy come up.',
      'The README Deployment section covers: deploy sequence, SECRET_KEY ceremony + escrow, R2 procedure (procedure only, never values), the drill and how to read its verdicts, the accepted shared-box failure mode with its symptom named, stage-1 RPO/RTO stated honestly and explicitly NOT spec §12\'s <15 min, and the §2.58 compiled-run-command correction.',
      'GC2: no secret anywhere in the diff. GC1: nothing provider-specific.',
      'Detached `pnpm verify` green, exit VALUE from a file; counts not decreased. Server tree clean. Container/volume roster clean. No `pnpm-lock.yaml` diff.',
    ],
  },
]

// ============================== SHARED PROMPT BLOCKS ==============================

const RULES_POINTER = 'THE RULES ARE IN THE REPO. READ THEM FIRST, IN FULL.\n\n  ' + RULES
  + '\n\nThat file is the binding contract. It is NOT pasted here — there is one copy, versioned with\n'
  + 'the repo, because two copies of a rule drift and one does not. Where this prompt and that file\n'
  + 'disagree about PROCESS, that file wins; where they disagree about CODE, the plan wins. It binds\n'
  + 'you whatever your role in this pipeline is: implementer, reviewer, mechanical checker.\n\n'
  + 'RULE 6 IS RETIRED and RULES 3 AND 7 WERE AMENDED ON 2026-08-22 FOR THIS VERY PLAN. Read them as\n'
  + 'they now stand, not as you may remember them: `/opt/hmis-prod` is a second writable path, and\n'
  + 'containers are permitted under the `hmis` / `hmis-prod` compose projects (or a clearly temporary\n'
  + 'project you remove before reporting). `hmis-db-1` and `hmis_hmis_pgdata` are the DEV DATABASE and\n'
  + 'are untouchable; once `hmis-prod` exists its containers and volumes are PRODUCTION DATA and are\n'
  + 'exactly as untouchable. A blanket `docker system prune` / `volume prune` / `rmi -a` is FORBIDDEN\n'
  + 'OUTRIGHT, ALWAYS — remove by explicit name.\n\n'
  + 'AND RULE 3\'S OTHER ABSOLUTE, WHICH APPLIES TO EVERY ROLE INCLUDING REVIEWERS AND CHECKERS:\n'
  + 'NEVER `/tmp`. Not for a throwaway sanity check, not for a scratch mutant, not for a log. The\n'
  + 'only writable paths on that server are `/opt/hmis` and brief-named `/opt/hmis-prod` paths. A\n'
  + 'mechanical checker once wrote four files to `/tmp` because its prompt had never been shown the\n'
  + 'rule (§2.32) — that is why this sentence is in the block EVERY agent renders, not in the\n'
  + 'coders\' half.'

const PLAN_POINTER = 'THE PLAN IS THE DESIGN LAW FOR THIS TASK, AND IT IS OWNER-APPROVED.\n\n  ' + PLAN
  + '\n\nRead it. Its owner rulings and D1–D15 are settled — you re-litigate none of them. The spike\n'
  + 'report it rests on, which you will be pointed at for measured shapes, is:\n\n  ' + SPIKE
  + '\n\nALL FOUR FORKS ARE RESOLVED BY MEASUREMENT AND CLOSED. A = COMPILED output · B =\n'
  + 'rename-and-recreate in one transaction · C = pgBackRest inside the Postgres image (the fork\n'
  + 'dissolved: `archive_command` runs in that container) · D = the monitoring stack on the same box.\n'
  + 'The losing branches are dead. Do not re-open, re-benchmark, or re-argue any of them.'

const GROUND_TRUTH = 'GROUND TRUTH, MEASURED BY THE MAIN SESSION IMMEDIATELY BEFORE THIS RUN:\n\n'
  + '- Build host `root@62.238.106.231`, checkout `/opt/hmis`, branch `main`. Everything that\n'
  + '  produces EVIDENCE runs there and only there.\n'
  + '- Phase 0 landed three commits before this pipeline compiled; the pipeline depends on them.\n'
  + '- Phase 0 completed at ' + PHASE0_TIP + '; the compile commit (the plan amendment, this script\n'
  + '  and its pre-flight) landed on top of it, and each task commits on top of the last.\n'
  + '  THIS IS A SEQUENTIAL PIPELINE: the\n'
  + '  commit you find will be the PREVIOUS TASK\'S, i.e. current `origin/main`, and that is correct\n'
  + '  and expected (§2.6). Do not stop to reconcile it.\n'
  + '- Baseline, detached `pnpm verify`, exit VALUE read from `/opt/hmis/.verify.exit`:\n'
  + '  ' + BASELINE + '\n'
  + '  Your run must not DECREASE any of these, and your diff must delete no test. Do not chase a\n'
  + '  predicted per-task total; if a number disagrees with what you measure, report the difference\n'
  + '  and its cause (AGENT-RULES §4).\n'
  + '- 80/443 were verified FREE (nginx stopped and disabled). `hmis.crkmch.com` resolves UNPROXIED\n'
  + '  to `62.238.106.231`. `/opt/hmis-prod/.env.r2` exists, chmod 600, holding verified R2\n'
  + '  credentials. Containers: `hmis-db-1` only. Volumes: `hmis_hmis_pgdata` only.\n'
  + '- THE REPO IS PUBLIC. A CI "failure" lasting SECONDS is the billing block (§2.59), not code.\n'
  + '- `gh` is installed on the build host but deliberately UNAUTHENTICATED. You cannot check CI.\n'
  + '  Report the CI item as delegated to the main session and move on — do NOT fail a task for it.'

const MIRROR = function (agentSuffix) {
  return 'YOUR LOCAL MIRROR (AGENT-RULES rule 22) — A DIRECTORY THAT IS YOURS ALONE:\n\n  '
    + SCRATCH + '\\mirror-' + agentSuffix
    + '\n\nEvery agent in this pipeline shares one scratchpad and `tar x` does not remove files the\n'
    + 'archive lacks, so a mirror without a per-agent suffix silently inherits every earlier agent\'s\n'
    + 'mutants and scratch — and they look exactly like files somebody left in the tree. Pull ONE tar\n'
    + 'into the directory above, author and grep there with native tools, `scp` exactly the paths your\n'
    + 'Files list names, and CONFIRM THE SYNC LANDED with `md5sum` on both sides before running\n'
    + 'anything. Read rule 22 for the exact commands.\n\n'
    + 'RULE 22(g): THE MIRROR IS A COPY AND IT IS NOT EVIDENCE ABOUT THE SERVER\'S TREE. Read code\n'
    + 'from it freely — that is what it is for. But every claim of the form "this file is present /\n'
    + 'absent / left behind" must be made against the SERVER, with `git status --porcelain` and\n'
    + '`find`, in the same batch as the claim. A positive observation from a mirror is the dangerous\n'
    + 'one, because it arrives looking like a discovery.\n\n'
    + 'RULE 22(f): DO NOT DELETE THE MIRROR and do not report its survival as an unfinished step —\n'
    + '`rm -rf` is denied outright on this host. Server-side scratch under `/opt/hmis` you DO delete,\n'
    + 'with plain `rm -f`, before your final counts and before committing.'
}

const EVIDENCE = 'READING A COMMAND\'S VERDICT — THE THREE WAYS THIS HAS SILENTLY LIED:\n\n'
  + '- NEVER take a PIPELINE\'s exit status as a COMMAND\'s verdict. `pnpm verify 2>&1 | tail -40`\n'
  + '  exits 0 even when verify FAILED — that is `tail`\'s status. `| head -N` fails the opposite\n'
  + '  way. Capture the real one or run unpiped (rule 16).\n'
  + '- NEVER take a WRAPPER\'s exit status as the command\'s. `; echo "exit: $?"` makes the shell\n'
  + '  exit 0 because the ECHO succeeded. Read the echoed VALUE (rule 17).\n'
  + '- RUN ANY LONG REMOTE COMMAND DETACHED with its exit code written to a file, then poll that\n'
  + '  file. A foreground SSH channel exits 255 on a dropped link and destroys the evidence\n'
  + '  mid-run (rule 18). SSH to this host is intermittently flaky: a 255 is TRANSPORT, not a\n'
  + '  verdict — retry.\n'
  + '- A JEST NAME FILTER MUST ISOLATE, and `pnpm --filter … test -- <path> -t X` does NOT: pnpm\n'
  + '  injects a literal `--`, your pattern becomes another PATH pattern, and the whole suite runs\n'
  + '  looking like a passing single test. Bypass the script (`pnpm --filter @hmis/core exec jest\n'
  + '  --passWithNoTests <path> -t "<name>"`) and confirm isolation in the OUTPUT (rule 19).\n'
  + '- `pgrep -af jest` and `pkill -f <pattern>` MATCH THEIR OWN INVOKING SHELL. Read the matched\n'
  + '  command LINES, never the count (rule 20, §2.53). Kill by PID, never by pattern (§2.66).'

const INBOX_WRITE = 'IF YOU FIND SOMETHING A LATER TASK IN THIS PIPELINE MUST KNOW, WRITE IT DOWN WHERE\n'
  + 'THAT TASK WILL READ IT. The waves run back-to-back with NO human in the gap, so a finding that\n'
  + 'names a later task has nowhere to go unless you put it here:\n\n  ' + FINDINGS_INBOX
  + '\n\nAPPEND to that file (never rewrite it) a dated entry naming the task it is for, what you found,\n'
  + 'and the evidence. Then also put it in your findings/interpretations. Do not assume anyone is\n'
  + 'between the waves.\n\n'
  + 'THE INBOX IS NOT YOUR SCRATCH AND IT IS NOT IN ANY FILES LIST. It is UNTRACKED (or modified)\n'
  + 'in `/opt/hmis` for the whole pipeline and the MAIN SESSION commits it at the end, with the gate\n'
  + 'report. So: do NOT delete it in your finish-block cleanup, do NOT `git add` it, and do NOT\n'
  + 'report its presence in `git status` as unclean — it is the one expected exception, named here\n'
  + 'so you do not have to guess. Everything else you created still goes.\n\n'
  + '§2.67 — WHEN YOU BOOK A SURVIVOR AS BENIGN, SAY WHICH MUTANT YOU BUILT AND WHAT THE CLASS OF\n'
  + 'UNBUILT ONES IS, OR SAY THAT YOU DO NOT KNOW. "I built the mutant and it was harmless"\n'
  + 'generalises from one mutant to a whole class, and that generalisation is a prediction like any\n'
  + 'other. A reassurance routed forward inherits rule 21\'s burden exactly as an explanation does.'

const INBOX_READ = 'STEP 0, BEFORE ANYTHING ELSE: read\n\n  ' + FINDINGS_INBOX
  + '\n\nIt holds findings that earlier tasks in THIS pipeline recorded FOR YOU — facts about the\n'
  + 'surfaces you are about to build on that were discovered after your brief was compiled. They are\n'
  + 'as binding as the brief. If it is empty of entries, nothing was found; say so and move on.\n\n'
  + 'THE INBOX IS NOT IN YOUR FILES LIST AND THAT IS DELIBERATE. It is UNTRACKED (or modified) in\n'
  + '`/opt/hmis` for the whole pipeline; the MAIN SESSION commits it at the end with the gate report.\n'
  + 'Do NOT delete it in your finish-block cleanup, do NOT `git add` it, and do NOT treat it as a\n'
  + 'dirty tree — it is the one expected exception. If YOU find something a LATER task must know,\n'
  + 'APPEND to it (never rewrite it): a dated entry naming the task it is for, what you found, and\n'
  + 'the evidence. The waves run back-to-back with NO human in the gap, so a finding that names a\n'
  + 'later task has nowhere else to go.'

function frozenBlock(t) {
  const mine = new Set(t.files)
  const others = []
  TASKS.forEach(function (o) {
    if (o.id === t.id) return
    o.files.forEach(function (f) { if (!mine.has(f)) others.push(f + '   (owned by ' + o.id + ')') })
  })
  const uniq = [...new Set(others)].sort()
  return 'YOUR FILES LIST — THE ONLY PATHS YOU MAY COMMIT:\n\n'
    + t.files.map(function (f) { return '  ' + f }).join('\n')
    + '\n\nIf you find yourself syncing or committing a file this list does not name, STOP — that is a\n'
    + 'scope violation, not a sync problem. If the work genuinely requires a file outside the list,\n'
    + 'that is a PLAN DEFECT: report it with evidence rather than widening your scope. Reporting a\n'
    + 'plan defect instead of working around it is explicitly the behaviour this process wants.\n\n'
    + 'FROZEN — OWNED BY OTHER TASKS IN THIS PIPELINE. DO NOT TOUCH THEM, EVEN IF YOUR CHANGE WOULD\n'
    + 'BE CORRECT:\n\n'
    + uniq.map(function (f) { return '  ' + f }).join('\n')
    + '\n\nEvery other path in the repository is likewise frozen to you. Two exceptions, both narrow:\n'
    + '(a) transient MUTANT SCRATCH may sit beside its source while you work and must be deleted\n'
    + 'before your final counts and before committing (AGENT-RULES §3); (b) `pnpm-lock.yaml` must\n'
    + 'NEVER change — a diff there is a HALT (Global Constraint 3).'
}

const HALT = 'HALT TO THE MAIN SESSION — STOP AND REPORT, DO NOT WORK AROUND. Any finding that would:\n'
  + '- add a SECOND migration, or ANY dependency (a `pnpm-lock.yaml` diff is a halt);\n'
  + '- touch `dispatcher.ts` beyond the floor predicate plus its lookup (GC4 — the window, claim,\n'
  + '  cursor arithmetic and backoff are BYTE-FROZEN);\n'
  + '- flip `RETENTION_ENABLED`\'s default or weaken the hold check (GC5), or weaken the\n'
  + '  `queued`/`sending` immunity (GC6);\n'
  + '- put ANY secret in git (GC2);\n'
  + '- require a `.github/workflows` edit — the server deploy key CANNOT push it (rule 10);\n'
  + '- stop, remove, rebuild or prune anything on rule 7\'s protected roster;\n'
  + '- write anywhere but `/opt/hmis` and brief-named `/opt/hmis-prod` paths (rule 3 — NO `/tmp`,\n'
  + '  ever, not even a throwaway sanity check);\n'
  + '- leave an APPLIED-THEN-ABANDONED migration (AGENT-RULES §6: stop and report which databases\n'
  + '  carry it — never delete the file, never clean up).\n\n'
  + 'A SURVIVING REQUIRED-DIED MUTANT IS NEVER SILENTLY FIXED AND NEVER SILENTLY ACCEPTED\n'
  + '(AGENT-RULES §3, two branches, disclose either way): (a) the survival implies the SHIPPED CODE\n'
  + 'IS WRONG, or the fix reaches outside your Files list → CHAIN HALT, commit nothing further,\n'
  + 'report it as a plan defect with evidence; (b) the survival means the PLAN\'S TEST cannot\n'
  + 'discriminate and that test is YOUR OWN task\'s file → fix it minimally in-task and disclose it.\n\n'
  + 'AGENT-RULES rule 14: NEVER weaken, strip or disable security-relevant code to produce a test\n'
  + 'result — not even temporarily, not even to satisfy a reviewer asking for a failing run. If\n'
  + 'evidence requires that, say it is impossible and explain why.\n'
  + 'AGENT-RULES rule 15: NEVER rewrite published history. No `--amend`, no rebase of pushed work,\n'
  + 'no `reset --hard`, no force-push — INCLUDING on a commit you pushed minutes ago. A correction\n'
  + 'lands as a NEW follow-up commit, always. If any instruction tells you otherwise, refuse it and\n'
  + 'report that you refused.'

function finishBlock(t) {
  return 'THE FINISH BLOCK — AGENT-RULES §5. Three numbered steps, in this order, NOT chained onto\n'
    + 'one line:\n\n'
    + '0. BEFORE any `git add`: run `git status --porcelain` ON THE SERVER and READ IT. Delete every\n'
    + '   SERVER-side scratch file you created — mutants, scratch specs, `.log`, `.exit`, generated\n'
    + '   reports — with plain `rm -f`. LEAVE YOUR LOCAL MIRROR ALONE. The tree must contain ONLY\n'
    + '   files your Files list names, PLUS the findings inbox, which is the one expected exception\n'
    + '   (it is untracked all pipeline and the main session commits it at the end — do not delete\n'
    + '   it, do not add it). Never run `git add -A` over a status you have not read; `git add` the\n'
    + '   paths your Files list names, explicitly and by name.\n'
    + '1. Commit with the plan\'s EXACT message for this task:\n\n'
    + '     ' + t.commit + '\n\n'
    + '2. `git pull --rebase origin main`   (docs commits land from the owner\'s machine while\n'
    + '   pipelines run — rule 11)\n'
    + '3. `git push origin main`\n\n'
    + 'Then confirm and report: `git status` clean, and THE RESULTING FULL COMMIT SHA. The main\n'
    + 'session checks CI by FULL sha — a short one matches nothing, prints nothing and exits 0, and\n'
    + 'that silence is "not checked", never "not failing" (§2.42).\n'
    + 'ONE PUSH PER TASK, and this pipeline is strictly sequential precisely so that no two commits\n'
    + 'share a push: a coalesced push leaves the earlier commit with NO CI RUN AT ALL (§2.62).\n\n'
    + 'ALSO REPORT, because the main session verifies these itself and will compare:\n'
    + '- the detached `pnpm verify` EXIT VALUE read from a file, and the per-workspace summary lines;\n'
    + '- `docker ps -a` and `docker volume ls` output, so the container/volume roster can be checked\n'
    + '  against rule 7 (no stray container, no stray volume);\n'
    + '- every drill transcript your acceptance criteria name, verbatim — a drill transcript is\n'
    + '  evidence ONLY if the drill actually ran (Global Constraint 12), and "the script exited 0" is\n'
    + '  not a transcript.'
}

const PERSONA_CODER = 'You are a senior software engineer executing a briefed implementation task in an\n'
  + 'automated pipeline. The brief you receive is your ENTIRE context — you cannot see the\n'
  + 'conversation that produced it.\n\n'
  + '- Read the files named in the brief before changing anything. Match the existing codebase: its\n'
  + '  style, naming, idiom and comment density. Introduce no new patterns, dependencies or\n'
  + '  abstractions unless the brief asks for them.\n'
  + '- Deliver exactly the scope in the brief. No drive-by refactors, no extra features, no\n'
  + '  speculative error handling.\n'
  + '- If the brief is contradictory or missing something essential, SAY SO in your report and do the\n'
  + '  part that is unambiguous — do not guess at the rest.\n'
  + '- EVIDENCE OVER ASSERTION (rule 12). Never report a test as passing without having run it in\n'
  + '  that state. Report results faithfully and paste failing output if anything fails.\n'
  + '- Use only the tools you need: the mirror for reading and authoring, ssh/scp for the server.\n'
  + '  DO NOT USE ANY MCP TOOL. Do not run any git command against `C:\\Users\\ankit\\hmis` — that is\n'
  + '  the owner\'s docs checkout (rule 2), not a build environment.'

const PERSONA_GATE = 'You are a senior reviewer GATING one implementation task in an automated pipeline.\n'
  + 'You receive the task\'s brief, its acceptance criteria and the implementing agent\'s report. You\n'
  + 'cannot see the conversation or the wider plan beyond what the brief points you at.\n\n'
  + '- Read the changed files. Judge the change against the brief: does it do what was asked, and\n'
  + '  ONLY what was asked?\n'
  + '- RE-RUN THE TESTS COVERING THE CHANGE YOURSELF. Never accept the coder\'s claim that tests pass\n'
  + '  without running them. Detached, exit VALUE from a file.\n'
  + '- Check every acceptance criterion explicitly, one by one.\n'
  + '- REBUILD THE TASK\'S REQUIRED-DIED MUTANTS YOURSELF where the task has any. This is the single\n'
  + '  most expensive practice in this process and it is the one that caught a surviving census\n'
  + '  mutant nobody else saw. A kill is evidenced by the ASSERTION\'s own failure — quote expected\n'
  + '  vs received. A mutant that dies at TYPECHECK proves NOTHING (this repo compiles with\n'
  + '  `noUncheckedIndexedAccess`), and a class with `private` members is compared NOMINALLY so a\n'
  + '  byte-copy mutant of one cannot be passed to a function typed against the shipped class\n'
  + '  (§2.61) — copy the one intermediate module and repoint ONLY its `import type`.\n'
  + '- Fail conditions beyond the criteria: SCOPE CREEP (the diff touches files or behaviour neither\n'
  + '  the brief nor the criteria asked for) and OVERENGINEERING (speculative abstractions,\n'
  + '  unrequested features, error handling for scenarios that cannot happen). Judge scope against\n'
  + '  the brief PLUS criteria PLUS any corrections quoted in the brief: authorized breadth is not\n'
  + '  creep.\n'
  + '- Rule on each interpretation the coder flagged: reasonable, or a wrong guess that changes the\n'
  + '  outcome? A wrong guess is a `bad-interpretation` violation.\n'
  + '- A DRILL TRANSCRIPT IS EVIDENCE ONLY IF THE DRILL RAN. "The script exited 0" is not a\n'
  + '  transcript, and a criterion reduced to an exit code is unmet.\n'
  + '- You cannot check CI (`gh` on the build host is unauthenticated). Report that item as delegated\n'
  + '  to the main session; do NOT fail the task for it.\n\n'
  + 'A pass requires: every criterion met, tests passing UNDER YOUR OWN RUN, and zero violations.\n'
  + 'Anything else is a fail. Your final message is consumed by a script, not a human — return only\n'
  + 'the structured data.'

const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['outcome', 'files_changed', 'tests', 'interpretations'],
  properties: {
    outcome: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    interpretations: { type: 'array', items: { type: 'string' } },
    commit_sha: { type: 'string' },
    evidence: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'violations', 'corrections', 'tests'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    violations: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['type', 'detail'],
        properties: {
          type: { type: 'string', enum: ['criterion-unmet', 'test-failure', 'scope-creep', 'overengineering', 'bad-interpretation', 'agent-error'] },
          detail: { type: 'string' },
        },
      },
    },
    corrections: { type: 'array', items: { type: 'string' } },
    retry_mode: { type: 'string', enum: ['reimplement', 'verify-only'] },
    findings: { type: 'array', items: { type: 'string' } },
    tests: {
      type: 'object', additionalProperties: false, required: ['ran', 'passed', 'failed'],
      properties: { ran: { type: 'string' }, passed: { type: 'number' }, failed: { type: 'number' } },
    },
  },
}

function coderPrompt(t, history) {
  let p = RULES_POINTER + '\n\n' + PLAN_POINTER + '\n\n' + INBOX_READ + '\n\n' + GROUND_TRUTH
    + '\n\n' + MIRROR(t.id.toLowerCase() + '-coder') + '\n\n' + EVIDENCE + '\n\n' + PERSONA_CODER
    + '\n\nRISK TIER: ' + t.tier.toUpperCase() + (t.tier === 'opus'
      ? ' / CRITICAL. AGENT-RULES §3\'s CRITICAL branch applies IN FULL: build every mutant the plan\'s\nAssertion Book names for your task, in a separate scratch file beside the source, run ISOLATED,\nquote the isolation line and expected-vs-received, and record DIED or SURVIVED with counts.\nFail-first is owed by the attempt that does the work and its failing output must be QUOTED — but\nNEVER manufacture a red by mutating shipped state (no throwaway databases, no relocating or\ndeleting source files, no weakening a guard). If a legitimate red is impossible, say so plainly.'
      : ' / ROUTINE. Tests are required and must pass; the Assertion Book rows named in your brief are\nstill required-DIED mutants and you build them. Fail-first is not owed — say so rather than\nmanufacturing one. If you NOTICE an assertion that cannot discriminate, say so: that is a finding,\nand it is worth more than a mutant you were not asked to build.')
    + '\n\n' + t.brief + '\n\n' + frozenBlock(t) + '\n\n' + HALT + '\n\n' + finishBlock(t)
  p += '\n\nACCEPTANCE CRITERIA YOUR WORK MUST MEET — each is checked independently by a reviewer:\n'
    + t.criteria.map(function (c) { return '- ' + c }).join('\n')
  p += '\n\nIf any part of the brief is ambiguous, choose the most reasonable interpretation, complete the'
    + ' task, and list every such choice in the interpretations field of your report. Never expand'
    + ' scope beyond the brief.'
  p += '\n\nIf a tool call is denied by the permission system, do not attempt the same change through'
    + ' another tool or shell command; stop and record the denial verbatim in the outcome field.'
  if (history && history.length) {
    p += '\n\nA reviewer FAILED ' + history.length + ' previous attempt(s) at this task. Full failure history, oldest first:'
    history.forEach(function (v, idx) {
      p += '\nAttempt ' + (idx + 1) + ' violations: ' + v.violations.map(function (x) { return x.type + ' - ' + x.detail }).join('; ')
      p += '\nAttempt ' + (idx + 1) + ' corrections: ' + v.corrections.join('; ')
    })
    if ((history[history.length - 1] || {}).retry_mode === 'verify-only') {
      p += '\nThe reviewer judged the implementation itself CORRECT AND COMPLETE. Do not rewrite,'
        + ' re-generate, or re-commit the code. This attempt is VERIFICATION ONLY: re-run the required'
        + ' commands, capture their real output, and satisfy every correction with evidence. Do NOT'
        + ' manufacture a fail-first run by mutating shipped state — if a legitimate red run is'
        + ' impossible without mutating what already shipped, say so plainly and quote the evidence'
        + ' you CAN legitimately obtain.'
        + '\nIMPORTANT: if the previous attempt already COMMITTED AND PUSHED, do not amend or re-commit'
        + ' it (rule 15). Report the existing SHA. AGENT-RULES §2.4\'s fallback applies: you may skip a'
        + ' red run by NAMING THE COMMIT SHA that already contains the artifact.'
    } else {
      p += '\nThe files are currently in the state the most recent attempt left them. Apply every correction.'
        + ' If the previous attempt already pushed a commit, corrections land as a NEW follow-up commit —'
        + ' never an amend or a force-push (rule 15).'
        + '\n\nAND THE STATE THAT IS NOT IN THE FILES: **A MIGRATION THE PREVIOUS ATTEMPT APPLIED IS STILL'
        + ' APPLIED.** AGENT-RULES §6 — running the generator and letting a suite migrate MUTATES ALL'
        + ' PER-WORKER DATABASES, and `git checkout` does not undo it. Before you regenerate anything,'
        + ' MEASURE what is already applied (the `drizzle.__drizzle_migrations` rows and the actual'
        + ' table shape) and say so. Do NOT generate a second migration to "fix" the first, do NOT'
        + ' delete the applied file, and do NOT hand-edit `drizzle/meta/_journal.json` or a'
        + ' `__drizzle_migrations` row. If the correction cannot be made without undoing an applied'
        + ' irreversible migration, that is a STOP-AND-REPORT, not a retry: name which databases carry'
        + ' it and halt.'
    }
  }
  return p
}

function gatePrompt(t, report) {
  return RULES_POINTER + '\n\n' + PLAN_POINTER + '\n\n' + INBOX_WRITE + '\n\n' + GROUND_TRUTH
    + '\n\n' + MIRROR(t.id.toLowerCase() + '-gate') + '\n\n' + EVIDENCE + '\n\n' + PERSONA_GATE
    + '\n\nTHE TASK BRIEF YOU ARE GATING:\n\n' + t.brief
    + '\n\n' + frozenBlock(t)
    + '\n\nACCEPTANCE CRITERIA — check every one explicitly:\n'
    + t.criteria.map(function (c) { return '- ' + c }).join('\n')
    + '\n\nTHE IMPLEMENTER\'S REPORT (JSON):\n' + JSON.stringify(report)
    + '\n\nDo not re-litigate the plan\'s design decisions or its resolved forks — they are owner-approved'
    + ' law. Judge execution. If you believe the PLAN itself is defective, that is a finding for the'
    + ' inbox and your findings array, not a task failure, unless the defect means a criterion is'
    + ' genuinely unmet.'
    + '\n\nYOUR OWN scratch is subject to the same hygiene rule: it lives under `/opt/hmis` or your'
    + ' mirror — NEVER `/tmp` — and you delete the server-side part with plain `rm -f` before you'
    + ' return. Leave the mirror in place. Do not commit anything: gating is read-and-run, not write.'
}

function mechanicalPrompt(t, report) {
  return RULES_POINTER + '\n\n' + INBOX_WRITE + '\n\n' + GROUND_TRUTH
    + '\n\n' + MIRROR(t.id.toLowerCase() + '-check') + '\n\n' + EVIDENCE
    + '\n\nYou are the MECHANICAL CHECK on one completed task. You are not a design reviewer: you'
    + ' verify that what was CLAIMED actually HAPPENED. Do not re-litigate the approach.'
    + '\n\nTASK BRIEF:\n\n' + t.brief
    + '\n\nACCEPTANCE CRITERIA:\n' + t.criteria.map(function (c) { return '- ' + c }).join('\n')
    + '\n\nIMPLEMENTER REPORT (JSON):\n' + JSON.stringify(report)
    + '\n\nTHE CHECKLIST — run each one YOURSELF and quote what you observed:\n'
    + '1. `pnpm verify` on the build host, run DETACHED, with the exit VALUE read from a file.\n'
    + '2. `git show --stat` of the ACTUAL commit against the task\'s Files list — never against the\n'
    + '   implementer\'s summary of it. Every path in the diff must be named by the Files list.\n'
    + '3. A frozen-path grep over that same diff. Any hit is a violation.\n'
    + '4. CI by FULL SHA — you CANNOT do this (`gh` on the build host is unauthenticated). Report it\n'
    + '   as delegated to the main session and move on; do NOT fail the task for it (§2.33).\n'
    + '5. The server tree is clean: `git status --porcelain` EMPTY, no mutant or scratch residue.\n'
    + '6. Workspace test totals did not decrease and the diff deletes no test. Quote the summary lines.\n'
    + '7. THE CONTAINER AND VOLUME ROSTER: `docker ps -a` and `docker volume ls`, compared against\n'
    + '   rule 7 — no stray container, no stray volume, nothing of the dev stack disturbed.\n'
    + '8. Every drill transcript the criteria name is PRESENT AND IS A TRANSCRIPT. A criterion\n'
    + '   reduced to "the script exited 0" is UNMET (Global Constraint 12).\n'
    + '9. `pnpm-lock.yaml` does not appear in the diff.\n'
    + '\nYour OWN scratch lives under `/opt/hmis` or your mirror — NEVER `/tmp` — and you delete the\n'
    + 'server-side part with plain `rm -f` before you return. Leave the mirror in place.'
}

// ============================== THE LADDER AND THE WAVES ==============================

// EXECUTE-METHOD v2 §4: ONE discovery reviewer per pipeline, reading every commit TOGETHER. This
// is not a downgrade from per-task gates — the findings that mattered most in Plan 10 were
// CROSS-TASK (a defect shipped dormant by one task and armed by another; a convention six tasks
// honour that no test protects), and a per-task gate structurally cannot see them. It was the
// best-value agent in that run: both MAJORs, with executed evidence, for one agent.
const DISCOVERY_PROMPT = RULES_POINTER + '\n\n' + PLAN_POINTER + '\n\n' + GROUND_TRUTH
  + '\n\n' + MIRROR('discovery') + '\n\n' + EVIDENCE
  + '\n\nYou are the ONE DISCOVERY REVIEWER for this pipeline. Every task has already shipped and'
  + ' passed its own gate. You are NOT re-gating them: you read ALL SIX COMMITS TOGETHER and look'
  + ' for what a per-task reviewer structurally could not see.\n\n'
  + 'The commit range is Plan 11a\'s six task commits on `main`, in order T1…T6. Read them with\n'
  + '`git log --oneline` and `git show` on the build host, and read the findings inbox at\n'
  + '  ' + FINDINGS_INBOX + '\n\n'
  + 'WHAT TO HUNT — the classes that have actually produced MAJOR findings here:\n'
  + '- A defect shipped DORMANT by one task and ARMED by a later one. Two commits can each be\n'
  + '  correct and their composition wrong.\n'
  + '- Two tasks that DISAGREE IN CODE about whether some state can exist.\n'
  + '- A convention several tasks honour that NO TEST PROTECTS — the shipped code is right and\n'
  + '  nothing pins that it stays right. That is the shape of both of Plan 10\'s MAJORs.\n'
  + '- An assertion that cannot discriminate: a census that asserts a SET cannot see a mutation\n'
  + '  that preserves the set; a config test that asserts a key PARSES asserts nothing about\n'
  + '  whether it takes EFFECT (§2.60).\n'
  + '- A REASSURANCE routed forward. §2.67: "I built the mutant and it was harmless" generalises\n'
  + '  from one mutant to a whole class, and that generalisation is a prediction like any other.\n'
  + '  Re-check every "benign" verdict in the inbox by building a DIFFERENT mutant of the same\n'
  + '  class. Plan 10\'s headline MAJOR was found exactly this way.\n\n'
  + 'RULE 21 BINDS YOU HARDEST OF ALL: you are the last reader, so an unexecuted claim from you\n'
  + 'reaches the gate report unchallenged. BUILD the mutant, do not predict it. Quote expected vs\n'
  + 'received. A mutant that dies at TYPECHECK proves nothing.\n\n'
  + 'You COMMIT NOTHING and you FIX NOTHING. Findings go in your return value with their executed\n'
  + 'evidence, severity, and — for anything you are NOT certain of — the words that say so. Clean\n'
  + 'up every scratch file you create on the server with plain `rm -f`; leave the mirror.'

const results = {}
const failed = new Set()

async function runTask(t) {
  const unmet = t.deps.filter(function (d) { return (results[d] || {}).status !== 'done' })
  if (unmet.length) {
    results[t.id] = { status: 'skipped', reason: 'dependency not done: ' + unmet.join(',') }
    failed.add(t.id)
    return
  }
  const history = []
  // A rung advances ONLY on a real gate rejection. Infrastructure failures (dead coder, dead gate)
  // retry the SAME rung and never promote the tier: an API 529 is not a code defect and must not
  // cost an escalation (§2.1).
  const LADDER = [
    { model: t.model, label: t.model + ':' + t.id },
    { model: t.model, label: 'retry:' + t.id },
    { model: 'opus', label: 'escalate:' + t.id },
  ]
  const MAX_INFRA = 3
  let infra = 0
  for (let rung = 0; rung < LADDER.length; ) {
    const a = LADDER[rung]
    const report = await agent(coderPrompt(t, history), {
      agentType: 'general-purpose', model: a.model,
      label: a.label + (infra ? '~' + infra : ''), phase: 'Wave ' + t.wave, schema: REPORT_SCHEMA,
    })
    if (!report) {
      if (++infra > MAX_INFRA) {
        results[t.id] = { status: 'failed', reason: 'infrastructure: coder unavailable', attempts: rung + 1, history }
        failed.add(t.id)
        return
      }
      log(t.id + ': coder infra failure ' + infra + ' — same rung, tier unchanged')
      continue
    }

    if (!t.gate) {
      // ROUTINE: mechanical check instead of a gate. §2.50 — under the Workflow tool a task
      // nothing judges CANNOT FAIL, so the wave-stall break is dead for it. This gives T6 a
      // verdict so the chain can still stop.
      let chk = null
      for (let g = 0; g <= MAX_INFRA; g++) {
        chk = await agent(mechanicalPrompt(t, report), {
          agentType: 'general-purpose', model: 'sonnet',
          label: 'check:' + t.id + (g ? '~' + g : ''), phase: 'Wave ' + t.wave, schema: VERDICT_SCHEMA,
        })
        if (chk) break
        infra++
        log(t.id + ': mechanical-check infra failure ' + infra + ' — re-judging the same work')
      }
      if (!chk) {
        results[t.id] = { status: 'failed', reason: 'infrastructure: mechanical check unavailable', attempts: rung + 1, history }
        failed.add(t.id)
        return
      }
      if (chk.verdict === 'pass') {
        results[t.id] = { status: 'done', attempts: rung + 1, files: report.files_changed, sha: report.commit_sha, tests: chk.tests, interpretations: report.interpretations, findings: (chk.findings || []).concat(report.findings || []), evidence: report.evidence }
        return
      }
      history.push(chk)
      log(t.id + ': rung ' + (rung + 1) + ' rejected by mechanical check — ' + chk.violations.map(function (v) { return v.type }).join(','))
      rung++
      continue
    }

    // A dead gate re-judges the SAME report. It must never trigger a fresh coder attempt.
    let verdict = null
    for (let g = 0; g <= MAX_INFRA; g++) {
      verdict = await agent(gatePrompt(t, report), {
        agentType: 'general-purpose', model: 'opus',
        label: 'gate:' + t.id + '#' + (rung + 1) + (g ? '~' + g : ''), phase: 'Wave ' + t.wave, schema: VERDICT_SCHEMA,
      })
      if (verdict) break
      infra++
      log(t.id + ': gate infra failure ' + infra + ' — re-judging the same work, no new coder attempt')
    }
    if (!verdict) {
      results[t.id] = { status: 'failed', reason: 'infrastructure: gate unavailable', attempts: rung + 1, history }
      failed.add(t.id)
      return
    }
    if (verdict.verdict === 'pass') {
      results[t.id] = { status: 'done', attempts: rung + 1, files: report.files_changed, sha: report.commit_sha, tests: verdict.tests, interpretations: report.interpretations, findings: (verdict.findings || []).concat(report.findings || []), evidence: report.evidence }
      return
    }
    history.push(verdict)
    log(t.id + ': rung ' + (rung + 1) + ' rejected — ' + verdict.violations.map(function (v) { return v.type }).join(',') + (verdict.retry_mode === 'verify-only' ? ' (verify-only retry)' : ''))
    rung++
  }
  results[t.id] = { status: 'failed', attempts: LADDER.length, history }
  failed.add(t.id)
}

// SIX STRICTLY SEQUENTIAL WAVES, ONE TASK EACH. No parallel waves anywhere: §2.62's
// coalesced-push hole stays closed (two commits in one push leave the earlier with NO CI run at
// all), and every wave after W1 runs drills against shared host state.
const waves = [...new Set(TASKS.map(function (t) { return t.wave }))].sort(function (a, b) { return a - b })
let stalled = false
for (const w of waves) {
  phase('Wave ' + w)
  const inWave = TASKS.filter(function (t) { return t.wave === w })
  for (const t of inWave) { await runTask(t) }
  if (inWave.some(function (t) { return (results[t.id] || {}).status !== 'done' })) {
    log('wave ' + w + ' did not complete — stopping the run rather than letting later waves discover it')
    stalled = true
    break
  }
}

// The discovery reviewer runs only on a complete pipeline: reading a half-shipped range for
// cross-task defects would be reading a system that does not exist yet.
let discovery = null
if (!stalled) {
  phase('Discovery')
  discovery = await agent(DISCOVERY_PROMPT, {
    agentType: 'general-purpose', model: 'opus', label: 'discovery:plan-11a', phase: 'Discovery',
    schema: {
      type: 'object', additionalProperties: false, required: ['summary', 'findings'],
      properties: {
        summary: { type: 'string' },
        findings: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['severity', 'title', 'evidence'],
            properties: {
              severity: { type: 'string', enum: ['MAJOR', 'MINOR', 'NOTE'] },
              title: { type: 'string' },
              evidence: { type: 'string' },
              executed: { type: 'boolean' },
            },
          },
        },
      },
    },
  })
}

return {
  tasks: results,
  stalled,
  discovery,
  halted: [...failed],
  summary: Object.values(results).filter(function (r) { return r.status === 'done' }).length + '/' + TASKS.length + ' done',
}
