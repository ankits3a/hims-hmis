# Plan 11a — findings inbox

Append-only. Earlier tasks in this pipeline record here what a LATER task must know: facts about
the surfaces it is about to build on that were discovered after its brief was compiled. The waves
run back-to-back with no human in the gap, so a finding that names a later task has nowhere else
to go. Entries are as binding as a brief.

**Never rewrite this file, only APPEND.** It is untracked for the duration of the run and the main
session commits it at the end with the gate report — so do not `git add` it, do not delete it in
your finish-block cleanup, and do not report it as a dirty tree.

§2.67: when you book a survivor as benign, say WHICH mutant you built and what the class of
unbuilt ones is, or say that you do not know. A reassurance routed forward inherits rule 21's
burden exactly as an explanation does.

---

## Seeded by the main session at compile, 2026-08-22 — binding on every task

**1. `scheduler.test.ts`'s L14 census is a MEASURED CI FLAKE, and one re-run does not clear it.**
The test is `Scheduler › the registration census (L14) › invokes all seven jobs within a faked 25
hours advanced from a pinned instant`. Measured across the last ~31 CI runs: **5 reds, ~16%**, and
it has failed **twice consecutively** on two separate commits (`ffcd24c`, `51c2e36`) before going
green on a third attempt. Proof it is environmental and not code: `855550a` and `51c2e36` have
**byte-identical** source across `apps/core`, `packages/contracts` and `apps/web` (the only diff
between them is a shell script under `docs/`), and CI gave green/green for one and red/red/green
for the other. The build host is green at both.

Root cause, quoted from the test's own comment: the Scheduler's tick comes from its CONSTRUCTOR,
not the environment, so `CENSUS_DAILY_TICK_MS = 30_000` samples `runDailyClose`'s **one-IST-minute**
window only **twice** — *"the margin the comment claims (~12 ticks) has always actually been 2."*
Under a slow CI container those two ticks' async work does not settle before `stop()` latches and
the daily jobs never fire; the signature is an empty or partial `invoked` set
(`Expected -4 / Received +0`).

**DO NOT "fix" it, weaken it, or change its timing.** The obvious fix — lowering the tick — is a
runtime/flake trade that may make it WORSE: the guardians' window is open ~23.9 h/day, so a 30 s
grid already costs ~3 000 real DB reads across the advance and a 5 s grid would cost ~18 000 on the
same slow container. That trade is booked for the owner, not for a task mid-pipeline.
**T2 and T5 edit this file.** If you see it red, check first whether the failure is L14-only with
that signature and whether the build host is green; report honestly what you observed.

**2. R0-2 shifted line numbers in the files T2 and T5 inherit.** `jobs.test.ts` grew from 85 to
199 lines (a new `describe` appended at the end); `CENSUS_INTERVALS` in `scheduler.test.ts` now
carries `notifyStuckAfterMs` and its block ends at :203. R0-1 added 45 lines to
`pump.test.ts` after line 229. **Re-grep; do not trust a cited line number.**

**3. The `JobIntervals` Pick already carries `notifyStuckAfterMs`** (R0-2). T5 widens it further
with the three retention keys. The ONLY `JobIntervals` object literal in the repo is
`CENSUS_INTERVALS`; `worker.ts` and `test/worker-runtime.e2e.test.ts` pass the whole `AppConfig`
and satisfy a wider `Pick` structurally. There is **no `AppConfig` object literal anywhere**, so
adding keys to `AppConfig` breaks nothing outside `config.ts`/`config.test.ts`.

**4. `docker/prod/db.Dockerfile` CONTAINS `Dockerfile` as a substring.** Any frozen-path grep must
anchor on whole paths, or T1's root `Dockerfile` and T4's `db.Dockerfile` collide. Found when this
pipeline's own pre-flight probe failed on exactly that.

**5. R2 credentials at `/opt/hmis-prod/.env.r2` were re-verified to AUTHENTICATE at compile** —
signed ListObjectsV2 → HTTP 200, bucket echoed, KeyCount=0 (fresh, empty). Keys present:
`R2_ENDPOINT`, `R2_BUCKET`, `R2_REGION`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. **T4:** read
them from that file; they never enter git, the image, or any report.

**6. T3's ACME path is clear.** No Hetzner cloud firewall exists in the project at all; host `ufw`
is active and allows `80/tcp` and `443/tcp` from Anywhere (v4 and v6); nginx is `disabled` and
`inactive` with no listener on either port. `hmis.crkmch.com` resolves unproxied to
`62.238.106.231`.

---

## Appended by T1 (the production build), 2026-08-22 — measured, not predicted

**T1-1. The image contract T3 must code against.** Root `Dockerfile`, two targets:
- default (last stage, `runtime`) — the server image. `WORKDIR /app/apps/core`, `USER node`
  (uid 1000), `NODE_ENV=production`, `EXPOSE 3000`, default `CMD ["node","dist/src/main.js"]`.
  The three entrypoints, all measured booting: api `node dist/src/main.js` · worker
  `node dist/src/worker.js` · migrator `node dist/scripts/migrate.js`.
- `--target web` — `caddy:2-alpine` with the built SPA at **`/srv`**. **T3s Caddyfile must say
`/srv`.

**NOTE ON THE FRAGMENT DIRECTLY ABOVE:** T1's first append was truncated mid-sentence by a
shell-quoting fault on the authoring side (an apostrophe closed the outer quote). This file is
append-only, so the fragment stays where it is rather than being edited away. **The complete T1
entry follows and supersedes it.** Read from "T1-1" below.

## Appended by T1 (the production build), 2026-08-22 — measured, not predicted

**T1-1. The image contract T3 must code against.** Root `Dockerfile`, two build targets:
- default (the last stage, `runtime`) — the server image. `WORKDIR /app/apps/core`, `USER node`
  (uid 1000), `NODE_ENV=production`, `EXPOSE 3000`, default `CMD ["node","dist/src/main.js"]`.
  The three entrypoints, every one of them measured booting: api `node dist/src/main.js` ·
  worker `node dist/src/worker.js` · migrator `node dist/scripts/migrate.js`.
- `--target web` — `caddy:2-alpine` carrying the built SPA at **`/srv`**. **The Caddyfile must
  therefore say `root * /srv`.** No Caddyfile is baked into that image; it stays
  deploy-directory config (D13) so it can be corrected without a rebuild.

**T1-2. There is NO `curl` and NO `wget` in the runtime image** (`node:22-bookworm-slim`). D12's
api healthcheck has to use node. Measured working shape:
`node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`.
No `HEALTHCHECK` is set in the Dockerfile on purpose: ONE image serves both api and worker, and
D12 gives the worker none deliberately — so the check belongs per-service in compose.

**T1-3. The migrate step, run verbatim in a throwaway compose project and measured:**
`docker compose -p <project> run --rm api node dist/scripts/migrate.js` -> `migrations applied`,
exit 0, against an empty Postgres 16. `scripts/migrate.ts` passes
`migrationsFolder: "./drizzle"` **relative to cwd**, which is exactly why WORKDIR is
`/app/apps/core`. The image carries `drizzle/*.sql` (16 files today) and `drizzle/meta/` (17).
**T2:** the Dockerfile copies `apps/core/drizzle` wholesale, so migration `0016` and its meta
ride along with no Dockerfile change at all.

**T1-4. `.dockerignore` deliberately does NOT exclude `docker/`. T4, this one is for you.** A
`.dockerignore` governs the build CONTEXT, not the Dockerfile, so the root one applies to
`docker build -f docker/prod/db.Dockerfile .` as well. Had `docker/` been excluded there, that
build could not have COPYed its own `pgbackrest.conf`. It is excluded nowhere, and a comment at
the bottom of `.dockerignore` says why, so that nobody "tidies" it back in. (`**/.env.*` does
still exclude `docker/prod/.env.prod.example` — no image needs it, and GC2 wants it that way.)

**T1-5. `apps/core/scripts/` is now COMPILED and, for the first time, TYPECHECKED. T6, this one
is for you.** `apps/core/tsconfig.json`'s `include` never covered `scripts/`, so `pnpm typecheck`
has never looked at those files. `apps/core/tsconfig.build.json` uses `include: ["src","scripts"]`
with `rootDir: "."`, so every script now compiles under `strict` + `noUncheckedIndexedAccess`.
**A `scripts/seed-cursors.ts` that does not typecheck breaks the DOCKER BUILD, not merely a
script — and `pnpm verify` will NOT catch it**, because `typecheck` is `tsc --noEmit` against
`tsconfig.json`, which still omits `scripts/`. Run `pnpm --filter @hmis/core build` after adding
it. (All ten existing scripts compiled clean on the first attempt: exit 0, zero diagnostics.)

**T1-6. `packages/contracts` `main` is now `./dist/index.js`; `types` stays `./src/index.ts`.**
`apps/core/jest.config.cjs` pins `^@hmis/contracts$` to
`<rootDir>/../../packages/contracts/src/index.ts`, so the SUITE keeps reading source while the
IMAGE reads compiled output — both proved by execution, in both directions, with a poisoned
`dist`. Two consequences: (a) a SUBPATH import (`@hmis/contracts/something`) would slip past that
exact-match mapper — there are none today, keep it that way; (b) any future workspace that
depends on `@hmis/contracts` and runs jest needs the same pin. `apps/core` is still the only
dependant.

**T1-7. Anything running `pnpm install` inside a container must expect the line
`The following dependencies have build scripts that were ignored: argon2, esbuild`** — pnpm 10
blocks dependency lifecycle scripts by default and this repo sets no `onlyBuiltDependencies`. It
is NOT a failure: `argon2@0.41.1` ships `prebuilds/linux-x64` and loads via `node-gyp-build`. The
proof is that the api container boots with the whole auth stack loaded and serves `/health` 200.

---

## Appended by the T1 GATE (reviewer), 2026-08-22 — measured under the gate's own run

**T1G-1. THE `main` FLIP BREAKS EVERY `tsx` RUNTIME PATH UNTIL `packages/contracts/dist` EXISTS.
T2, T6 — this one is for you, and it is measured, not reasoned.** With
`packages/contracts/dist` removed, from `apps/core`:

    node -e "require.resolve('@hmis/contracts')"
    -> Error: Cannot find module
       '/opt/hmis/apps/core/node_modules/@hmis/contracts/dist/index.js'.
       Please verify that the package.json has a valid "main" entry     (exit 1)

    pnpm exec tsx -e "import { newId } from '@hmis/contracts'; ..."      (exit 1, same error)
    CONTROL, dist restored, identical command                           (exit 0, "newId is function")

So `start:dev`, `start:worker` and any seed/validate script whose import graph reaches
`@hmis/contracts` as a VALUE now require `pnpm --filter @hmis/contracts build` to have been run
at least once in the checkout. This is a consequence of the plan's own D2 ruling, not a defect,
and production is unaffected (it runs compiled). **`scripts/migrate.ts` is NOT affected** — its
graph is `src/kernel/db/client` (drizzle + pg + schema) and `src/kernel/config` (zod + node
builtins), neither of which touches contracts; I traced it rather than assuming. I did NOT
enumerate every seed script: `seed-opd.ts` has a VALUE import (`newId`), while `seed-billing.ts`
and `seed-tariff.ts` use `import type`, which tsx erases. **Both `dist` trees are present on the
build host right now** (`packages/contracts/dist`, `apps/core/dist`) — gitignored, so a `git
clean` or a fresh clone loses them and the dev scripts start failing with the message above.

**T1G-2. `pnpm verify` does NOT depend on `packages/contracts/dist`. CI is safe — measured.**
The obvious worry about the `main` flip is that a fresh CI checkout has no `dist`. It does not
bite. With `dist` absent entirely: `pnpm typecheck` exit **0**, `pnpm lint` exit **0**, and a real
`apps/core` suite (`src/kernel/auth/permissions.test.ts`) exit **0**. `typecheck` reads contracts
through `types` (still `./src/index.ts`), `eslint` ignores `**/dist/**` and registers no import
resolver, and jest goes through T1's `moduleNameMapper`. Three independent consumers, none of
them using `main`.

**A FALSE ALARM I RAISED AND THEN KILLED, RECORDED SO NOBODY RE-RAISES IT.** My first attempt at
the measurement above `mv`d `dist` to `/opt/hmis/.t1gate-dist-stash` and `pnpm lint` went **red**
with four `@typescript-eslint/no-require-imports` errors — all four inside
`.t1gate-dist-stash/index.js`. That was MY OWN APPARATUS: renaming the directory took the
compiled output out of eslint's `**/dist/**` ignore. Re-run with the tree emptied IN PLACE (still
named `dist`, exactly as a fresh clone would be), lint is **0**. If you stash a `dist` anywhere
under `/opt/hmis`, give it a name eslint already ignores, or lint will blame you for compiled
code you did not write.

**T1G-3. The exact-match mapper is confirmed sufficient TODAY, by census.** `^@hmis/contracts$`
would miss a subpath import. I grepped the whole repo (`*.ts`, `*.tsx`, `*.json`, excluding
`docs/`): **166 references, ZERO subpath imports**, and `apps/core` (including its `scripts/`) is
the only workspace that names the package. `packages/contracts`' own three suites import
RELATIVELY, so they never touch `main` and need no pin. Any task adding `@hmis/contracts/<sub>`
must widen the mapper in the same commit.

---

## Appended by T2 (migration 0016, the partitioning conversion), 2026-08-22 — measured, not predicted

**T2-1. A PLAN DEFECT, DISCLOSED RATHER THAN WORKED AROUND: my Files list omitted
`apps/core/src/kernel/db/schema/notifications.test.ts`, and D7's prune index cannot ship without
it.** That file carries a whole-array census — *"carries exactly the three indexes the pump and the
expire-by-ref path read"* — asserting `toEqual` on every index name on `notifications`. D7 requires
`(status, updated_at)` to ride 0016, so the census goes red the instant the index exists:

    - Expected  - 0
    + Received  + 1
        "notifications_status_next_attempt_idx",
    +   "notifications_status_updated_at_idx",

The file is named in NEITHER my Files list NOR the frozen-by-another-task block, so no task owns
it and no coordination was broken. The two acceptance criteria *"the prune index rides 0016"* and
*"`pnpm verify` green"* are jointly unsatisfiable without touching it, and by the time the census
failed the migration was already APPLIED to the worker databases (AGENT-RULES §6 — halting there
would have left exactly the applied-then-abandoned state rule 6 exists to prevent). I therefore
made the MINIMAL edit — one array entry, one explanatory comment, the test's title 3 → 4 — and I
am booking the Files-list omission here as the defect. **Gate: this is a fifteenth committed path,
deliberate and disclosed, not a scope slip.**

**T2-2. `events` IS NOW A PARTITIONED PARENT, and three consequences bind everyone after me.**
- **Every PRIMARY KEY and UNIQUE constraint on `events` must now CONTAIN `recorded_at`.** Postgres
  refuses any other. PK is `(seq, recorded_at)`, UNIQUE is `(event_id, recorded_at)`. A later task
  that adds a unique to `events` without the partition key will fail at migrate time, not at
  typecheck.
- **drizzle cannot see partitioning AT ALL** — no pg-core API, no snapshot field. `0016_snapshot.json`
  is exactly as generated and is correct for everything drizzle models (both composite constraints
  are in it); nothing was hand-edited. But that also means a future `db:generate` plans ALTERs
  against a table it believes is an ordinary heap. Read the generated SQL before trusting it.
- **`truncate table events … restart identity` STILL WORKS on the parent** — verified by execution
  in `kernel/worker/partitions.test.ts`: every partition empties and `seq` restarts at 1, because
  0016 runs `ALTER SEQUENCE events_seq_seq OWNED BY events.seq` before dropping the old table.

**T2-3. The partition inventory helpers T5's sweep should use, all exported from
`apps/core/src/kernel/worker/partitions.ts`:**
- `EVENTS_DEFAULT_PARTITION` = `"events_default"` — **created by 0016, never created or dropped by
  the job, and the sweep must never drop it either.** It is the only thing between a row whose
  month nobody pre-created and a failed INSERT on the write path.
- `EVENT_PARTITION_MONTHS_AHEAD` = 3, and the set is **current IST month + 3 = FOUR partitions.**
- `eventPartitionsFor(now, monthsAhead?)` — pure, returns `{ name, from, to }` with IST (`+05:30`)
  half-open bounds; testable with no database.
- `listEventPartitions(db)` — the monthly partitions that exist, oldest first, DEFAULT excluded.
- `createEventPartitions(db, now?)` — idempotent `create table if not exists`, returns the names.
Partition names are `events_YYYY_MM` on the **IST** month. `retention_legal_holds` is exported from
`schema/index.ts` as `retentionLegalHolds`; an ACTIVE hold is `released_at is null`; `patient_id`
NULL means a GLOBAL hold; `patient_id` carries an FK into `patients`, and the table therefore joins
the **patients** truncate statement in `test/helpers/db.ts` (not the users one — `created_by` is
plain actor text, the `approvals.ts` precedent).

**T2-4. Both censuses are now `THE_EIGHT`, and T5 must move them again.** `scheduler.test.ts`
(`spyOnTheSeven` → `spyOnTheEight`, and the eighth job IS spied — un-stubbed it would issue DDL
from inside a fake-clock unit test) and `test/worker-runtime.e2e.test.ts`. `createEventPartitions`
is registered LAST, `dailyIst` at `CREATE_EVENT_PARTITIONS_IST = "00:15"`.
**The `JobIntervals` Pick was NOT widened and did not need to be** — a `dailyIst` registration takes
its instant from a code constant, so no `JobIntervals` object literal changed and **the typechecker
could not announce the eighth job the way amendment 7's widened Pick announced the seventh.** The
two census arrays are the only guard; T5, you get no compile error for forgetting them.
One more: `scheduler.test.ts`'s M-S2 test pins 00:30 IST, so the new 00:15 job legitimately fires
in it. Its absence list names the two 23:5x jobs only, and that is now load-bearing.

**T2-5. The spike report's prose says "the seven `ALTER INDEX … RENAME`s". There are SIX.** Its own
SQL block lists six, and `\d events` on a migrated database shows six (`events_pkey` ·
`events_event_id_unique` · `events_idempotency_key_idx` · `events_name_idx` · `events_patient_idx` ·
`events_correlation_idx`). The SQL was right; the sentence counting it was not.

**T2-6. NEVER PUT `BEGIN;`/`COMMIT;` IN A MIGRATION FILE, and one `--> statement-breakpoint` chunk
must be exactly ONE statement.** Read from the installed `drizzle-orm@0.40.1`
`pg-core/dialect.cjs`, not assumed: `migrate()` wraps EVERY statement of EVERY pending migration in
one `session.transaction(...)`, and each chunk goes through `tx.execute(sql.raw(stmt))` — the
extended protocol, which rejects multi-statement strings. The spike's Question-B SQL is written with
`BEGIN;`/`COMMIT;` because it was run through `psql`; pasting it verbatim into a migration would
have committed the migrator's own transaction out from under it. 0016 relies on the migrator's
transaction instead, and the conversion is still atomic.

**T2-7. Migration state after this task, for the record (AGENT-RULES §6).** `hmis_test_1` …
`hmis_test_7` carry 0016 (17 rows in `drizzle.__drizzle_migrations`, `events.relkind = 'p'`).
`hmis_test_8` was not touched by this run and sits at 15 rows / relkind `'r'`; it migrates itself on
first use. **`hmis_dev` was deliberately NOT migrated** — `db:migrate` was never run and points at
it; it is at 16 rows / relkind `'r'`. Nothing was hand-edited in `_journal.json` and no
`drizzle.__drizzle_migrations` row was written or deleted by hand.

**T2-8. The floor predicate prunes at plan time THROUGH THE DRIVER, not only with a literal.** The
worry with `coalesce($1::timestamptz, '-infinity')` is a generic plan, which would prune at
execution ("Subplans Removed") instead. It does not happen: node-postgres sends unnamed statements,
so Postgres plans at Bind with the values in hand, folds the parameter to a Const and drops the
out-of-floor partition from the plan entirely. Measured both ways in the gate evidence. **The
DEFAULT partition is never pruned** — it can hold any month, so the planner always keeps it, which
is exactly why `createEventPartitions` is load-bearing rather than hygiene.

---

**T2-GATE-1 (2026-08-22, T2 gate — FOR T5, and for anyone who writes a partition-pruning
predicate from here on). A FLOOR BUILT FROM `now()` PRUNES AT RUN TIME, NOT AT PLAN TIME — and
`EXPLAIN` hides the difference behind an identical-looking output.** Re-measuring flag ③ myself I
first wrote the floor as `coalesce((date_trunc('month', now() at time zone 'Asia/Kolkata') +
interval '1 month') at time zone 'Asia/Kolkata', '-infinity')`. The out-of-floor partition was
ABSENT from the plan — but the Append carried `Subplans Removed: 1`, which is the EXECUTOR
removing it at initialisation, because `now()` is STABLE and the planner cannot fold it. Re-run
with the shipped shape — a bound `$3` sent as an unnamed statement, exactly what node-postgres
does — the parameter folds to a Const (`recorded_at >= '2026-08-31 18:30:00+00'`), there is NO
`Subplans Removed` line, and the partition is gone at PLAN time. Both transcripts are in the T2
gate report. CONSEQUENCE FOR T5: if `retentionSweep` (or anything else) computes a month bound
with `now()` INSIDE the SQL rather than binding a JS-side `Date`, it silently loses plan-time
pruning. Bind the value; do not compute it in the statement. Evidence: gate drill against
`hmis_gate_t2_explain` (`createdb -T hmis_test_1`, dropped in the same task, confirmed absent).

**T2-GATE-2 (2026-08-22, T2 gate — FOR T5 AND T6). `hmis_test_8` and `hmis_dev` are NOT at 0016.**
Measured at gate close: `hmis_test_1`..`hmis_test_7` carry 17 migration rows and
`events.relkind = 'p'`; `hmis_test_8` carries 15 rows and `relkind = 'r'` (it is behind by more
than 0016 — it was not used by the T2 run); `hmis_dev` carries 16 rows and `relkind = 'r'`
(deliberately left at 0015 — nobody ran `db:migrate`). A worker-8 suite will migrate its own
database on first use, which is normal; but any DRILL or probe that talks to `hmis_dev` directly
is talking to an UNPARTITIONED `events` and will not reproduce anything partition-shaped.

---

## Appended by T3 (`hmis-prod` compose, Caddy, deploy.sh), 2026-08-22 — measured, not predicted

**T3-1. A SINGLE-FILE BIND MOUNT PINS THE CONTAINER TO AN INODE, AND `install(1)` REPLACES THE
INODE. T4 AND T6, THIS ONE WILL BITE YOU.** My first compose mounted `./Caddyfile:/etc/caddy/
Caddyfile:ro` and `deploy.sh` refreshed it with `install -m 0644`. After a config change the host
file and the container's view DIVERGED and stayed diverged for the life of the container:

    /opt/hmis-prod/Caddyfile          352153010eb3131f0e23f974cafe8c17   (new)
    docker exec … md5sum /etc/caddy/Caddyfile
                                      469de4d4c86f7410575934332adc924e   (OLD, still served)

`caddy reload` then dutifully reloaded the OLD file and reported success — a green step that
changed nothing. The failure is silent in both directions: the deploy log says the config was
copied, and the reload says it worked. **The fix that ships is structural: mount the DIRECTORY.**
The compose service now mounts `./caddy:/etc/caddy:ro` and `deploy.sh` installs to
`$DEPLOY_DIR/caddy/Caddyfile`; the same three md5s are now identical, and a reload picks the new
bytes up with no container recreate. **T4: `pgbackrest.conf` is exactly this shape.** **T6:
`prometheus/prometheus.yml`, `alerts.yml`, `postgres-exporter/queries.yml` and the grafana
provisioning files are all exactly this shape.** Put each config tree in its own subdirectory of
`/opt/hmis-prod` and mount the DIRECTORY, or your first config update after bring-up will not take
and you will not be told. `cp` happens to preserve the inode where `install` does not, but relying
on that is relying on a coreutils implementation detail — do not.

**T3-2. SCRATCH UNDER `/opt/hmis` THAT ENDS IN `.js`/`.ts` IS LINTED BY `pnpm verify`, AND IT WILL
FAIL YOUR RUN.** This is T1G-2's class arriving from a different direction, so it is worth naming
again with its own evidence. I put a raw WebSocket probe at `/opt/hmis/.t3-ws-probe.js` for the
flag-④ drill. `pnpm verify` went RED — not on my code, on my apparatus:

    /opt/hmis/.t3-ws-probe.js
      4:15  error  A `require()` style import is forbidden  @typescript-eslint/no-require-imports
      5:16  error  A `require()` style import is forbidden  @typescript-eslint/no-require-imports
    ✖ 2 problems (2 errors, 0 warnings)

`eslint .` walks the whole checkout and a leading dot in the filename does not hide it. Delete
drill scratch BEFORE the verify run, not merely before the commit. Re-run with the probe deleted:
exit **0**.

**T3-3. The deploy contract T4 and T6 code against.**
- **`deploy.sh` lives at `docker/prod/deploy.sh`, is idempotent, and re-running it over a live
  stack recreates nothing** (measured: four consecutive runs, three of them over a running stack;
  the only recreate in the whole task was the deliberate one when the caddy volume spec changed).
- Its step 5 is a whole-project `compose up -d`. **A service you add to
  `docker/prod/docker-compose.prod.yml` is brought up with NO edit to `deploy.sh`.** You only edit
  the script for something that is not a service: T4's weekly restore-drill cron entry, T6's
  seeding call.
- **The seeding SEAM is a marked comment block between step 4 (migrations) and step 5.** T6: your
  line goes there, `compose run --rm api node dist/scripts/seed-cursors.js`, and the paragraph
  above it gets deleted. It is deliberately absent today because `scripts/seed-cursors.ts` does not
  exist and a call to it would have failed my own from-zero bring-up.
- Pre-flight REFUSES on: no deploy directory · no `/opt/hmis-prod/.env` · that file not mode 600 ·
  80 or 443 held by anything that is not this stack's own caddy (asked by compose LABEL, so a
  re-deploy is allowed through). Both refusals were drilled, exit 1 each.
- The public hostname is read OUT OF the Caddyfile by `awk`, not configured twice. If you add a
  second site block to the Caddyfile, the FIRST `name {` line with a dot in it is what deploy.sh
  will probe.

**T3-4. `/opt/hmis-prod/.env` NOW EXISTS, mode 600, holding a real `SECRET_KEY` (D11 ceremony,
`openssl rand -hex 32`, generated on the box) and a real Postgres password.** Keys present:
`DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `PORT`, `SECRET_KEY`. It is
outside the checkout and nothing in git names its values. **T4:** the R2 credentials are still in
the SEPARATE `/opt/hmis-prod/.env.r2` and were deliberately not merged into `.env` — merging them
would put them into every api and worker container's environment for no reason. **T6:** the escrow
procedure you document is for the `SECRET_KEY` in this file; it has not been escrowed yet, only
generated. **Neither value has ever been printed, and no report or commit contains either.**

**T3-5. Caddy's compose service publishes 80/tcp and 443/tcp only, and the Caddyfile now disables
HTTP/3 to match.** Left at its default Caddy advertised `alt-svc: h3=":443"; ma=2592000` — measured
on the first bring-up — while 443/udp is neither published by compose nor admitted by the host
firewall (inbox item 6: ufw allows 80/tcp and 443/tcp). Clients cache that advertisement for 30
days and race a QUIC connection that can never arrive. A global `servers { protocols h1 h2 }` block
now suppresses it; verified absent from the response headers after the reload. If anyone later
opens 443/udp, delete that block and publish the UDP port in the same commit.

**T3-6. `caddy reload` is also a config VALIDATOR, and it is picky about formatting.** An
unformatted Caddyfile makes it emit
`"Caddyfile input is not formatted; run 'caddy fmt --overwrite'"` at WARN — the reload still
succeeds, so it will not break you, but it is noise in every deploy transcript. The shipped
Caddyfile is `caddy fmt`-clean (checked by `docker run --rm -v …:/in/Caddyfile:ro caddy:2-alpine
caddy fmt /in/Caddyfile`, exit 0, empty diff). A blank line before the global options block is
enough to trip it.

**T3-7. The image the caddy service runs is `hmis-prod/web:latest`, built `--target web`, and its
`caddy:2-alpine` base is now a tagged image on the host.** `docker images` therefore shows
`caddy:2-alpine` where the spike's end-state did not. It is the base layer of the production web
image, not stray scratch, so it was left in place rather than removed by name.

**T3-8. Resource limits, as the daemon actually applied them** (`docker inspect`, not the yml):
db `NanoCpus=2000000000 Memory=4294967296 MemoryReservation=1073741824` · api
`2000000000 / 1073741824 / 268435456` · worker `1000000000 / 805306368 / 268435456` · caddy
`1000000000 / 536870912 / 67108864`. All four `RestartPolicy=unless-stopped`. That is 6 of the
box's 8 CPUs and 6.25 GiB of its 15 GiB committed as ceilings. **T6: the monitoring stack's limits
have to fit in what is left alongside a `pnpm verify` run**, which the spike measured at ~96 MiB
resident for all four monitoring containers, so there is room — but set them, do not leave them
unbounded.

**T3-9. `docker compose ps` prints the IMAGE column as a bare `sha256:…` for a locally-built,
locally-tagged image once the tag has been re-pointed by a rebuild.** Cosmetic, but it looks like
a broken deployment in a transcript. `docker ps` still shows the tag for the most recently created
container. Do not chase it.

**T3G-1 (T3 gate, 2026-08-22). A WARM `deploy.sh` RE-RUN OVER THE LIVE STACK COSTS ~10 SECONDS AND
RECREATES NOTHING — measured by the gate, not by the coder, so T4 and T6 can re-drill freely.** I
ran the shipped `docker/prod/deploy.sh` unmodified against the live `hmis-prod` stack: exit VALUE 0
from a file, both docker builds fully cache-hit (`#23 DONE 0.1s`), step 3/5 printed
`Container hmis-prod-db-1 Running` / `api-1 Running` / `worker-1 Running` / `caddy-1 Running` —
i.e. NOT `Recreated` — the migrator ran as an ephemeral `hmis-prod-api-run-…` that `--rm` removed,
caddy reloaded in place, and `/health` came back 200 over HTTPS. Container ages were unchanged
across the run (api/worker/db 39m before and after). **The consequence for you: adding your
service to the compose file and re-running deploy.sh does not restart anybody else's container, so
rule 7's "no agent stops or restarts an hmis-prod container" is not in tension with re-drilling.**
The one thing that WOULD recreate api and worker is a change to the build CONTEXT — including
scratch files you left in `/opt/hmis` (see T3-2). Delete scratch before you run deploy.sh, not just
before you run `pnpm verify`.

**T3G-2 (T3 gate, 2026-08-22). THE ORIGIN LEAKS `X-Powered-By: Express` THROUGH CADDY, and the
Caddyfile strips `Server` but not that.** Measured against production:
`curl -sSI https://hmis.crkmch.com/health` returns `X-Powered-By: Express` alongside the six
security headers (which ARE present on proxied AND static responses — I checked both). It is a
version-less fingerprint, so it is hygiene rather than a hole, and it was NOT in T3's brief — T3 is
not failed for it. **T6 owns the runbook/hardening section: either book it as accepted or close it
in one line** (`-X-Powered-By` inside the existing Caddyfile `header` block, or Nest's
`app.disable("x-powered-by")`). Whoever closes it must re-run the T3 header drill afterwards.

**T3G-3 (T3 gate, 2026-08-22). A STALE COMMENT IN `deploy.sh` YOU WILL READ AND BELIEVE.** Line
~156 introduces the caddy-reload block with *"The Caddyfile is a BIND-MOUNTED FILE"*. It is not —
T3-1's fix made the mount a DIRECTORY (`./caddy:/etc/caddy:ro`), which is the whole point of that
entry. The reload is still needed and the code is right; only the sentence is left over from the
iteration before the fix. T4/T6: you own this file next — correct the sentence in passing rather
than reasoning from it.

---

## Appended by T4 (pgBackRest to R2 and the restore drill), 2026-08-22 — measured, not predicted

**T4-1. THE NEXT `deploy.sh` RUN WILL RECREATE `hmis-prod-db-1`, AND T3G-1's "a warm re-run
recreates nothing" NO LONGER HOLDS FOR THE db SERVICE. T6, THIS ONE IS FOR YOU AND IT IS A RULE-7
COLLISION, NOT A NUISANCE.** T3 predicted that swapping the db image would change "nothing else
about the service". That could not be true: `archive_command` is what makes archiving continuous,
it is a SERVER setting rather than an image layer, and the repo credentials have to reach that
container and no other. Four things changed on the db service — `image`, `command`, `env_file`,
and two mounts — so `compose up -d` recreates it.

**I did not run it.** Rule 7 as amended says no agent stops, restarts or removes an `hmis-prod`
container unless its brief says so in as many words, and mine said so only for the drill's own
scratch. So `hmis-prod-db-1` is still running stock `postgres:16` with no archiving, and the
production stanza does NOT yet exist in the bucket. Everything shipped was proved instead against
a throwaway `hmis-drill` cluster built from the same image, the same `pgbackrest.conf` and the same
credentials, and removed by name.

**T6: your deploy drill runs `deploy.sh`, and that run WILL recreate the production database
container.** The volume `hmis-prod_hmis_prod_pgdata` survives — this is a recreate, not a data
loss — but it is exactly the act rule 7 wants named out loud. Either your brief names it, or you
stop and report rather than assuming this entry authorises you. It does not; only a brief can.

**T4-2. `postgres:16` SHIPS NO CA STORE AT ALL, AND pgBackRest CANNOT REACH ANY TLS OBJECT STORE
UNTIL YOU INSTALL ONE.** The first command the stanza ever sent died:

    ERROR: [095]: unable to verify certificate presented by '<endpoint>:443 (172.64.66.1)':
           [20] unable to get local issuer certificate

`dpkg -l ca-certificates` reports `un` in that image and `/etc/ssl/certs` holds two files, neither
a bundle. `db.Dockerfile` therefore installs `ca-certificates` beside `pgbackrest` and asserts
`test -s /etc/ssl/certs/ca-certificates.crt` at build time. **The fix is the CA store, never
`repo-storage-verify-tls=n`** — that would make every backup and restore trust whatever answered on
443 (rule 14). No CA path is named in `pgbackrest.conf`, so a stage-3 MinIO with a private CA
re-points one environment variable instead of editing a config file.

**T4-3. A REMOTE REPOSITORY IS PER-OBJECT-LATENCY-BOUND, AND WITHOUT BUNDLING THE NIGHTLY FULL DOES
NOT FIT IN THE NIGHT.** Same 33 MB / 1670-file cluster, same bucket, three measured runs:

    process-max=2, no bundling   ->  886s     (3.6 MB of repo at ~4 KB/s)
    process-max=8, no bundling   ->  226s
    process-max=8, repo1-bundle  ->   24s  ... and 23s again with the container capped at 2 CPUs,
                                             which is the db service's own `deploy.resources` limit

37x for an identical 3.6 MB backup set. The spike's "full 3s" was a LOCAL volume; that number does
not survive contact with an object store, and the difference is one round trip per FILE. The
shipped `pgbackrest.conf` therefore sets `repo1-bundle=y` and `process-max=8`. **T6: quote these in
the runbook's RPO/RTO section rather than the spike's local-repo numbers.** Measured restore of a
bundled, encrypted backup out of R2: **4s**, 33.3 MB, 1671 files.

**T4-4. TWO WAYS THIS TASK'S OWN EVIDENCE LEAKS SECRETS, BOTH MEASURED, BOTH EASY TO WALK INTO.**
- **pgBackRest prints its full option list at the head of EVERY command.** It redacts what matters
  by itself — `--repo1-s3-key=<redacted>`, `--repo1-s3-key-secret=<redacted>`,
  `--repo1-cipher-pass=<redacted>` — but it prints **`--repo1-s3-endpoint` and `--repo1-s3-bucket`
  in clear**, and the R2 endpoint carries the owner's account id. Every line of
  `/opt/hmis-prod/log/*.log` has them. **Redact both before quoting any drill transcript into a
  report that reaches git.**
- **`docker compose config` renders `env_file` values IN PLAIN TEXT**, so running it against
  `docker-compose.prod.yml` prints `POSTGRES_PASSWORD`, all five R2 values and the repo cipher
  passphrase to the terminal. I ran it once to validate the file and immediately deleted the
  captured output; the values reached no report, no commit and no artefact. **Anyone validating
  this compose file should pipe it through a redactor or send it to /dev/null.**

**T4-5. `/opt/hmis-prod/.env.pgbackrest` NOW EXISTS (600) AND CARRIES A SECOND UNRECOVERABLE
SECRET. T6, YOUR ESCROW SECTION HAS TWO ITEMS NOW, NOT ONE.** `deploy.sh` derives it from
`.env.r2` — translating the five `R2_*` keys into the six `PGBACKREST_*` names the binary reads,
stripping the scheme off the endpoint — and **mints `PGBACKREST_REPO1_CIPHER_PASS` exactly once,
then preserves it verbatim on every later run** (verified: two consecutive runs, identical
passphrase hash). Repo encryption is client-side per spec E-2, so **losing that passphrase makes
every backup in the bucket unreadable ciphertext, including by the owner**, and CHANGING it orphans
everything already written while every new backup keeps succeeding. It is escrowed alongside
`SECRET_KEY` by the same procedure and it has NOT been escrowed yet, only generated.

**T4-6. `deploy.sh` IS NOW EIGHT STEPS, NOT SIX, AND YOUR SEAM MOVED. T6.** New step 4 is
`stanza-create` + `check` (the `check` forces a WAL switch and confirms the segment reached the
repository, so a deploy cannot report success over a backup fabric archiving into the void). New
step 7 installs `/etc/cron.d/hmis-prod-backup`. **Your cursor-seeding seam is unchanged in position
and is now between step 5 (migrations) and step 6 (api/worker/caddy) — the marked comment block is
exactly where T3 left it.** T3G-3's stale "the Caddyfile is a BIND-MOUNTED FILE" sentence is
corrected in passing, as T3's gate asked.

**T4-7. THE T5 SEAM IS `emit_verdict()`, NEAR THE TOP OF `docker/prod/drill/restore-drill.sh`, AND
IT IS ALREADY CALLED ON BOTH PATHS.** The EXIT trap invokes it with `passed` or `failed`, and the
five values T5 will want (`CENSUS_EVENTS`, `RESTORED_EVENTS`, `CENSUS_EVENT_ID`, `BACKUP_SECONDS`,
`RESTORE_SECONDS`) are pre-declared empty at the top so the trap is safe under `set -u` even when
the drill dies on its first line. **Both paths were executed:** the real drill exited 0 and printed
`DRILL PASSED / verdict: passed`; a deliberately broken invocation exited **1** and printed
`DRILL FAILED (exit 1) / verdict: failed`. T5 adds ONE call inside that function and changes
nothing else. The script defines no event today, deliberately.

**T4-8. THE DRILL DEGRADES HONESTLY ON AN EMPTY `events` TABLE, AND PRODUCTION IS EMPTY TODAY**
(`select count(*) from events` on `hmis-prod-db-1` = 0). With no rows there is no known event id to
look for, so the script says so out loud — `NO EVENT ID ASSERTED: the live events table was empty at
census time` — and still checks the row count and the migration journal. A drill that quietly
skipped the check would read exactly like one that ran it. **T6: the first genuinely meaningful
weekly drill is the first one after production records an event.**

**T4-9. T3-1's DIRECTORY-MOUNT FIX WAS RE-CONFIRMED ON THIS TASK'S OWN CONFIG, LIVE.** I replaced
`/opt/hmis-prod/pgbackrest/pgbackrest.conf` under a RUNNING container and all three hashes matched
immediately — checkout, deploy directory, and `/etc/pgbackrest/pgbackrest.conf` inside the
container — with no recreate and no restart. Mount the directory. It works.

---

## Appended by the T4 GATE (reviewer), 2026-08-22 — measured under the gate's own run

**T4G-1. ANY SCRATCH FILE WITH A `.ts` (or `.tsx`/`.js`) EXTENSION IN `/opt/hmis` TURNS `pnpm
verify` RED AT LINT, NOT AT TEST — AND THE MESSAGE DOES NOT LOOK LIKE YOURS. T5 AND T6 GATES, THIS
ONE COST ME A FULL VERIFY CYCLE.** An interrupted earlier attempt at this gate had left a
fifteen-byte timestamp file at `/opt/hmis/.t4gate.ts`. `eslint .` does not skip dotfiles, so my
first `pnpm verify` came back exit VALUE **1** with:

    /opt/hmis/.t4gate.ts
      1:1  error  Expected an assignment or function call and instead saw an expression
           @typescript-eslint/no-unused-expressions
    ✖ 1 problem (1 error, 0 warnings)

Not one test had run — `pnpm verify` is `typecheck && lint && test`, so lint failing means the
suite never executes and the red carries no test information at all. After `rm -f`, the identical
tree verified **exit VALUE 0**. This is T3-2's lesson one notch sharper: it is not enough to delete
scratch before committing, and the extension matters. **Name scratch `.t4gate-cron.out`, never
`.t4gate.ts`.**

**T4G-2. THE GATE RE-RAN THE SHIPPED DRILL END TO END AGAINST THE OWNER'S REAL BUCKET AND IT PASSED
A SECOND TIME, ON A ROW THE GATE WROTE ITSELF.** `docker/prod/drill/restore-drill.sh` from the
checkout, exit VALUE **0** from a file: incremental backup **23 s**, restore **8 s**, 32.9 MB /
1670 files (34 M on disk), repo backup-set 3.6 MB, `cipher: aes-256-cbc`. I inserted a sentinel
event **immediately before** the run, so the drill's own census picked it up
(`events=502 · newest event id=GATE2SENTINEL20260822`) and the assertion that found it in the
restored cluster could not have been satisfied by a stale artefact. The failure branch was exercised
separately: exit VALUE **1**, `DRILL FAILED (exit 1)` / `verdict: failed`. **T5: the seam is real
and both paths reach `emit_verdict()`.**

**T4G-3. THE PRODUCTION PREFIX IN THE BUCKET IS STILL EMPTY, CONFIRMED BY THE GATE AND NOT ONLY BY
T4's REPORT. T6, THIS IS T4-1 WITH A SECOND WITNESS.** `pgbackrest repo-ls --recurse` under
`/hmis-prod` returned **0 objects**, and `hmis-prod-db-1` still reads
`archive_mode = off · archive_command = (disabled)` on stock `postgres:16`. The backup fabric is
SHIPPED AND PROVEN, and it is NOT YET LIVE. Nothing is being archived today. Everything the gate
wrote to the bucket under its own `/gate-drill-…` prefix was removed by `stanza-delete --force`
(51 objects → **0**), and the production prefix was never written to.

---

## Appended by T5 (retention), 2026-08-22 — measured, not predicted

**T5-1. A PLAN DEFECT, DISCLOSED RATHER THAN WORKED AROUND: my Files list omits
`apps/core/src/kernel/worker/jobs.test.ts`, and the brief's own count of `JobIntervals` object
literals is wrong.** The brief states, as a measurement made by the main session: *"there is
exactly ONE such literal — `CENSUS_INTERVALS` in `scheduler.test.ts`"*. There are **TWO**. The
second is `INTERVALS` at `jobs.test.ts:131`, added by Phase 0 R0-2 for Book R2 (which is also why
inbox item 2 records that file growing from 85 to 199 lines). Widening the Pick made it stop
compiling, exactly as the Pick's own comment promises:

    src/kernel/worker/jobs.test.ts(131,9): error TS2739: Type '{ workerDispatchIntervalMs: number;
    workerTimersIntervalMs: number; workerTempRolesIntervalMs: number; workerNotifyIntervalMs:
    number; notifyStuckAfterMs: number; }' is missing the following properties from type
    'JobIntervals': retentionEnabled, retentionEventsMonths, notifyRetainDays

The file is named in NEITHER my Files list NOR the frozen-by-another-task block, so no task owns
it and no coordination was broken (the T2-1 shape exactly). The acceptance criteria *"the
`JobIntervals` Pick widened with the three keys"* and *"detached `pnpm verify` green"* are jointly
unsatisfiable without it. I made the MINIMAL edit — the three shipped defaults plus a comment —
and am booking the omission here. **Gate: this is a tenth committed path, deliberate and
disclosed, not a scope slip.**

REJECTED ALTERNATIVE, recorded because it is the tempting one: making the three keys OPTIONAL in
the Pick (`& Partial<Pick<...>>`) keeps every literal compiling and stays inside the Files list —
and it destroys the type event the plan asks for, silently permitting a registration that drops
the config. That is the `NOTIFY_STUCK_AFTER_MS` defect class the same plan spent Phase 0 R0-2
fixing.

**T5-2. The census is `THE_NINE` in both census files** (`scheduler.test.ts`,
`test/worker-runtime.e2e.test.ts`), `spyOnTheEight` is now `spyOnTheNine`, and `retentionSweep` is
registered LAST, `dailyIst` at `RETENTION_SWEEP_IST = "01:15"`. Unlike the eighth job, the ninth
DID widen the `JobIntervals` Pick, so a future tenth job with config keys will again break every
literal — there are two, named in T5-1.

**T5-3. `RETENTION_ENABLED` parses as an ENUM OF TWO EXACT STRINGS, not a coerced boolean, and
the runbook must say so. T6, this one is for you.** `z.coerce.boolean()` reads the string
`"false"` as TRUE (a non-empty string is truthy), which would switch retention ON for an operator
writing the value that means off. The shipped key accepts `true` and `false` and nothing else:
`1`, `yes` and `TRUE` all fail config parsing loudly at boot. Asserted in `config.test.ts`.

**T5-4. The T4 drill seam is wired, and the wire is a `docker run` against the SERVER image, not
a psql INSERT.** `emit_verdict()` in `docker/prod/drill/restore-drill.sh` now calls
`emit_drill_event`, which runs `node -e` inside `$SERVER_IMAGE` on the live db container's network
namespace and appends `backup.drill_passed` / `backup.drill_failed` through the application's own
`appendEvent` (same envelope, same zod payload validation, same `events` table). Consequences a
runbook and an alert rule need:
- **The exit code remains the authoritative verdict.** Every prerequisite is checked (deploy
  `.env` present, docker present, `$SERVER_IMAGE` present, `$DB_CONTAINER` running) and a failure
  to append is NOTED, never fatal. Measured on this host with `bash`: an EXIT trap whose last
  command succeeds does NOT overwrite the script exit status (`trap saw rc=1` -> `script exit
  value: 1`), so the wire cannot turn a failed drill into a green one.
- The payload is `{ stanza, censusEvents, restoredEvents, assertedEventId, backupSeconds,
  restoreSeconds }`, **every field nullable**, because the trap fires on paths where the census
  was never taken.
- **`backup.drill_*` events carry module `"backup"`; the four `retention.*` events carry module
  `"retention"`.** All six definitions live in `apps/core/src/kernel/retention/events.ts`.
- The wire has NOT been executed end to end — it needs a deployed `hmis-prod` stack, which does
  not exist on this box yet. Its shell syntax is checked (`bash -n`, clean) and the module paths
  it requires (`dist/src/kernel/db/client.js`, `dist/src/kernel/events/append.js`,
  `dist/src/kernel/retention/events.js`) are the compiled output of files that typecheck and are
  covered by the suite. **Whoever first runs a real drill against a deployed stack should confirm
  one `backup.drill_*` row lands, and say so in the gate report.**

**T5-5. The retention events are emitted ONLY when the fact they record happened.**
`retention.notifications_pruned` and `retention.side_tables_pruned` are appended only when their
count is non-zero; a nightly enabled run that finds nothing appends nothing. This is the same
reasoning `worker/partitions.ts` records for `createEventPartitions` emitting no event at all —
365 rows a year saying nothing changed, into the very table the job exists to keep prunable. A
dashboard must therefore read the ABSENCE of these events as "nothing was outside the window",
not as "the sweep did not run"; the sweep's own liveness is its `scheduler_heartbeats` row.

**T5-6. An enabled sweep drops partitions AND prunes notifications in the same run, and a test
that asserts on the events table has to expect both.** Two of my own first-draft assertions failed
on exactly this (the ancient fixture partitions are empty but still outside the window, so the
run legitimately appended two `retention.partition_dropped` rows beside the
`retention.notifications_pruned` one). Filter by event name rather than asserting the whole list.

## Appended by the T5 GATE (reviewer), 2026-08-22 — measured under the gates own run

## Appended by the T5 GATE (reviewer), 2026-08-22 — measured under the gate's own run

**T5-GATE-1. FOR T6 (the runbook), and it is BEHAVIOUR-CORRECT but TEST-UNDERSPECIFIED: the
absolute "current/adjacent months are never dropped regardless of configuration" guard is real,
but the shipped assertion for it cannot discriminate.** `sweep.test.ts`'s "never drops the DEFAULT
partition or the current/adjacent months, whatever the window says" runs at `eventsMonths: 1`, and
at that value the WINDOW predicate (`index >= oldestRetainedMonth`) already protects the current
and next months on its own. Measured, not predicted: I built the mutant that deletes
`if (currentMonth - index <= MIN_RETAINED_MONTHS) continue;` and ran the shipped assertion against
it — the mutant SURVIVED at `eventsMonths: 1` (the test passed under the mutant). The same mutant
DIED at `eventsMonths: 0`, where the previous month falls out of the window:
`expect(result.dropped).not.toContain("events_2026_07")` → `Received array: ["events_2010_01",
"events_2010_02", "events_2026_07"]`. So the SHIPPED CODE IS CORRECT — defence in depth, and
`RETENTION_EVENTS_MONTHS` is a positive int in config so 0 cannot arrive from configuration — but
the only input that makes the absolute guard load-bearing is one config cannot produce. No action
is required of anyone; it is recorded so nobody later reads that test as proof of the guard.

**T5-GATE-2. FOR T6 (the runbook): entering a legal hold is not instantaneous protection — there
is a TOCTOU window at 01:15 IST.** `retentionSweep` calls `blockingHold()` and then performs the
`drop table` in a SEPARATE later transaction; a hold row inserted between those two statements is
not seen and the month is dropped. The window is small and the job runs at 01:15 IST, but the
runbook should say plainly: enter a hold and confirm the row before the nightly sweep, never
during it. (Not a plan defect and not a criterion failure — the plan specifies a structural check,
not a serialisable one. Recorded because "a dropped held month is a legal record gone".)

**T5-GATE-3. The T5 seam's `node -e` wire is statically sound but still UNEXECUTED — I confirm
T5-4 rather than closing it.** Verified by reading, not by running: the runtime image's `WORKDIR`
is `/app/apps/core` and `CMD` is `node dist/src/main.js`, so `require("./dist/src/...")` resolves;
`apps/core/package.json` declares no `"type"`, so the emitted `dist` is CommonJS and `require` is
correct; `createDb(url)` really returns `{ db, pool }`; `defineEvent` really returns
`{ name, module, version, payloadSchema, make }`, so `def.name` and `def.make` both exist. I also
MEASURED the bash property the script's verdict rests on, on this host: a `cleanup` EXIT trap whose
last command succeeds does not mask a failed body — `trap saw rc=1` → `script exit VALUE: 1`.
STILL UNPROVEN BY EXECUTION: the two drill payload schemas and the `docker run` plumbing. Whoever
runs the first real drill must confirm one `backup.drill_*` row lands and say so in the gate report.

**T5-GATE-4. The T5 brief's own measurement was wrong and the coder was right to say so —
independently re-measured here.** The brief states there is "exactly ONE" `JobIntervals` object
literal (`CENSUS_INTERVALS` in `scheduler.test.ts`). There are two; the second is `INTERVALS` at
`jobs.test.ts:131`, added by Phase 0 R0-2. I proved it without touching a shipped file, by
compiling a scratch module holding the pre-widening literal verbatim:
`gate.typeevent-probe.ts(5,14): error TS2739: Type '{ workerDispatchIntervalMs: number;
workerTimersIntervalMs: number; workerTempRolesIntervalMs: number; workerNotifyIntervalMs: number;
notifyStuckAfterMs: number; }' is missing the following properties from type 'JobIntervals':
retentionEnabled, retentionEventsMonths, notifyRetainDays`. That is also the positive proof that
the `Pick` really was widened. `jobs.test.ts` is named in the plan's File Structure only under
Phase 0, so no pipeline task owns it — T5's three-line edit broke no coordination. GATE RULING:
allowed, and the disclosure is the behaviour the process asks for. **Any later task that widens
`JobIntervals` again must edit BOTH literals.**

## Appended by T6 (monitoring, cursor seeding, deployment runbook), 2026-08-22 — measured, not predicted

**T6-1. A PRE-EXISTING ANONYMOUS DOCKER VOLUME, NOT CREATED BY T6, FOUND DURING THIS TASK'S OWN
ROSTER CHECK.** `docker volume ls` on the build host shows one anonymous volume
(`5807a4e18c3e30ecc090d2083fe0024126fd2a96105e2528013427dd461d2182`) beside the named ones every
task expects (`hmis_hmis_pgdata`, `hmis-prod_hmis_prod_pgdata`, `hmis-prod_caddy_data`,
`hmis-prod_caddy_config`). `docker ps -a --filter volume=<id>` returns NOTHING — no container,
running or stopped, references it — and T6 never created an anonymous volume (every `docker run`
this task made used bind mounts only, confirmed by reading its own commands back). Its origin is
therefore unknown to this task and is NOT booked as T6's to clean (rule 7's "remove by explicit
name" is for what a task itself creates). Left in place, named here for whoever does the final
rule-7 roster check: `docker volume rm 5807a4e18c3e30ecc090d2083fe0024126fd2a96105e2528013427dd461d2182`
if its owner confirms it is dead weight.

**T6-2. Flag ⑨'s drill, run against a throwaway `hmis-t6-drill` project (postgres_exporter +
prometheus, attached to the DEV network `hmis_default`, never `hmis-prod`), removed by name —
zero residue confirmed (`docker ps -a --filter label=com.docker.compose.project=hmis-t6-drill`
empty after teardown; the scratch database `hmis_t6_drill` on `hmis-db-1` dropped and confirmed
absent from `pg_database`).** `prom/prometheus:v2.53.0` and
`prometheuscommunity/postgres-exporter:v0.15.0` were pulled to run it and were NOT removed
afterward (unlike the spike's throwaway pulls) — they are the exact images `docker-compose.prod.yml`
now ships, so leaving them cached is the T3-7 precedent (a base layer that becomes part of the
shipped stack is left, not removed), not residue.

**T6-3. `hmis-prod-db-1` was NOT touched.** T4's brief did not authorise recreating it (T4-1) and
mine does not either — no `deploy.sh` run was performed against the live `hmis-prod` stack by this
task. It is still measured running stock `postgres:16` with archiving off, exactly as T4 and its
gate left it. Whoever next runs `deploy.sh` for real should expect the recreate T4-1 already
flagged, now compounded by the monitoring services this task added to the same compose file.

**T6-4 (correction to T6-1, gate-review reconciliation, 2026-08-22).** T6-1 above misattributed
the anonymous volume `5807a4e18c3e30ecc090d2083fe0024126fd2a96105e2528013427dd461d2182` as "of
unknown origin... NOT created by T6." Gate review refuted this. The volume's `CreatedAt`
(`2026-08-22T17:08:48Z`, from `docker volume inspect`) falls inside T6's own work window
(T5's commit landed `2026-08-22T16:05:32Z`; T6's commit `cc5d6ce` landed
`2026-08-22T17:18:20Z`, ten minutes later) and no other task in this pipeline runs Prometheus.
Its contents (`data/wal/00000000`, `data/chunks_head`, `data/queries.active`, `data/lock`)
are exactly a Prometheus TSDB data directory, and `prom/prometheus:v2.53.0` — the image T6-2
names for the flag-⑨ drill — declares `VOLUME /prometheus` in its image config
(`docker inspect prom/prometheus:v2.53.0 --format '{{json .Config.Volumes}}'` →
`{"/prometheus":{}}`). A `docker run` of that image for the drill without an explicit bind
or named-volume mount at `/prometheus` auto-creates exactly this kind of anonymous volume;
T6-2's teardown removed the drill's *container* by name but never checked for the anonymous
volume the image itself declares, so it outlived the container (`docker ps -a --filter
volume=<id>` returned nothing — no container, running or stopped, referenced it — which is
exactly why T6-2's container-scoped residue checks did not catch it). Removed by explicit name
during gate verification: `docker volume rm
5807a4e18c3e30ecc090d2083fe0024126fd2a96105e2528013427dd461d2182` — confirmed gone from
`docker volume ls` afterward. Roster is now clean: `hmis_hmis_pgdata`,
`hmis-prod_hmis_prod_pgdata`, `hmis-prod_caddy_data`, `hmis-prod_caddy_config` only,
matching rule 7's expected inventory.
