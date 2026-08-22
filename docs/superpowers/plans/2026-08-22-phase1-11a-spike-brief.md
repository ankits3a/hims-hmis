# Plan 11a — SPIKE BRIEF: build the riskiest 10% for real, then throw the code away

**One agent. Target ~50k tokens. Throwaway branch. Nothing here is committed to `main`.**

You are the spike for Plan 11a ([`2026-08-22-phase1-11a-deployment.md`](2026-08-22-phase1-11a-deployment.md)).
Your job is **not** to build the plan. It is to answer five questions **by execution** — four that
close forks A–D from measurement instead of taste, plus one (E, added 2026-08-22) that discharges
the plan's verify-flag ④ early — so the plan's tasks are written against behaviour somebody has
actually observed.

**Read first, in full:** [`../AGENT-RULES.md`](../AGENT-RULES.md) — the binding contract. Then
[`../EXECUTE-METHOD.md`](../EXECUTE-METHOD.md) §1 (why this phase exists), then the plan above.
Where this brief and AGENT-RULES disagree about PROCESS, AGENT-RULES wins.

**Why you exist, in one number:** the last time a plan asserted something about a database that
nobody had executed, execution cost **934k tokens and delivered nothing**. A spike would have found
it for 50k. Every question below is a claim Plan 11a would otherwise have to write down untested.

---

## Ground rules specific to this spike

- **Work on a throwaway branch on the build host** (`root@62.238.106.231:/opt/hmis`), never on
  `main`. Nothing you write is committed to `main`; the *report* is the deliverable.
- **AGENT-RULES §6 is the live risk here.** Question B applies a schema change. **Do it against a
  COPY of the dev database, never against `hmis_dev` itself and never against any
  `hmis_test_<N>`** — the per-worker test databases belong to the suite. Create your copy with
  `createdb -T`, drop it when done, and if you cannot drop it, **say so** rather than leaving it
  silently.
- **Rule 3: `/opt/hmis` is the only writable path. No writes to `/tmp`, ever** — not even a
  throwaway. *(Rule 6 was RETIRED 2026-08-22 — the InsForge co-tenant was removed and the host is
  dedicated to this project. The owner-owned archive at `/opt/insforge-archive-2026-08-22/` is not
  yours: do not read it, list it, diff it, or include it in anything.)*
- **Rule 7 (as amended 2026-08-22) covers you:** you MAY create containers, but only under a
  clearly-temporary compose project of your own (e.g. `hmis-spike`) that you remove before you
  report. **`hmis-db-1` and the `hmis_hmis_pgdata` volume are the dev database — never stop,
  remove, rebuild or prune them, and never run a blanket `docker system prune` /
  `docker volume prune` / `docker rmi -a`; remove by explicit name, always.**
- **Ports 80 and 443 are TAKEN on this host** (verified 2026-08-22): a host-level nginx — enabled
  and active — still carries the removed InsForge stack's site (`cc.elar.club` → dead
  `127.0.0.1:7130`). It is the owner's residue to clean, not yours: do not touch nginx, do not
  bind 80 or 443 anywhere in your throwaway compose. Every probe in this brief works on high ports.
- **Rules 16–18:** long commands run DETACHED with the exit VALUE read from a file. Never a pipe's
  status, never a wrapper's.
- **Rule 20:** before anything that measures, confirm nothing else is running — and **read the
  matched COMMAND LINES, never the count.** `pgrep -af jest` matches its own shell. Note also that
  two orphaned self-matching wait-loop shells (PIDs 3501080, 3502071) may still be present; they are
  not test runs.
- **§2.66, newly learned and aimed straight at you:** `pkill -f <pattern>` matches its own invoking
  shell exactly as `pgrep -af` does — and unlike `pgrep`, it **acts**. It killed a session
  mid-demonstration two days ago. **Kill by PID.**
- **Report measured behaviour, including behaviour that refutes the plan's recommendation.** A
  spike that confirms everything the plan hoped is the least useful possible outcome. 08.5's spike
  earned its cost by killing pg-boss, which the roadmap had treated as settled.

---

## Question A — does COMPILED output boot? *(resolves FORK-A; the highest-value question here)*

**Context, measured 2026-08-22:** `apps/core` has **no `build` script**. There is no compiled output
anywhere, ever. Both processes run through `tsx`. `apps/core/tsconfig.json` sets
`experimentalDecorators: true` and **`emitDecoratorMetadata: true`**; `tsconfig.base.json` sets
`module: NodeNext`, `target: ES2022`, `declaration: true`, `sourceMap: true`.

**Ledger §2.58 is the reason this matters more than it looks.** `pnpm --filter @hmis/core start:dev`
has been broken since Plan 07: `tsx` transforms with esbuild, **esbuild does not emit
`design:paramtypes`**, so Nest injects `undefined` into `OpdRealtimeRegistrar`'s class-typed
constructor and `onModuleInit` throws `Cannot read properties of undefined (reading
'registerTopicSpace')`. ts-jest *does* emit the metadata, so all 908 tests pass and the documented
way to run the application does not work. `worker.ts` boots only because every provider in
`WorkerModule` is token-injected — a fact recorded in a comment and enforced by nothing.

**`tsc` with `emitDecoratorMetadata: true` SHOULD emit `design:paramtypes`, which would mean the
compiled production build works where the dev command does not. That is a prediction. Measure it.**

Do:
1. Add a `build` script (`tsc -p tsconfig.json --outDir dist` or whatever actually works) and run it.
   **Do NOT run bare `tsc` in a way that emits into the source tree** — rule 5: jest resolves `.js`
   before `.ts`, and stale emit silently shadows sources. Emit to `dist/` and confirm afterwards
   that `git status --porcelain` shows no stray `.js` beside any `.ts`.
2. Run `node dist/main.js` against the dev database. Does `/health` answer?
3. Run `node dist/worker.js`. Does it log seven job names?
4. **The §2.58 question, explicitly:** does `OpdRealtimeRegistrar` inject correctly, or does it throw
   the same `registerTopicSpace` error? Try to make it fail as well as succeed — an absence
   observed without a control is not evidence (§3.14).
5. Record what `NodeNext` output actually needs. Extensionless relative imports, `__dirname`,
   `import.meta`, CJS/ESM interop with `@nestjs/*`, `drizzle-orm`, `pg`: which of these fought you,
   and how big was the fix?
6. Measure boot time for both processes, compiled vs `tsx`.

**Decision rule.** Compiled boots + `/health` answers + worker registers seven + registrar injects,
and the total fix was small → **FORK-A = COMPILED**, and the §2.58 fix is a measured by-product that
changes the README. Output does not run cleanly under `NodeNext` and the fix is not small →
**FORK-A = `tsx` in production**, with the obstacle named precisely and §2.58 recorded as still open.

**Do not smooth this over.** "It mostly worked after I changed the module system" is a different
answer from "it worked" and Plan 11a's T1 needs to know which one it is getting.

---

## Question B — does the partitioned recreate actually work? *(resolves FORK-B; the irreversible one)*

**Context, transcribed from `kernel/db/schema/events.ts`:** `seq bigserial PRIMARY KEY` ·
`event_id text NOT NULL UNIQUE` · `recorded_at timestamptz NOT NULL DEFAULT now()` · four plain
indexes. Postgres requires every unique constraint on a partitioned table to contain the partition
key, so PK must become `(seq, recorded_at)` and the `event_id` unique must become
`(event_id, recorded_at)`.

**Against a COPY of `hmis_dev`, never the original:**
1. `createdb -T hmis_dev hmis_spike_part` (stop the dev worker first if it holds connections — **by
   PID**).
2. Attempt the conversion. Branch (i): rename-and-recreate in one migration
   (`ALTER TABLE events RENAME TO events_old`; create the partitioned `events`; `INSERT … SELECT`;
   drop the old). Branch (ii): create-empty-and-cut-over, if (i) cannot be expressed.
3. **Does `bigserial` survive?** A partitioned table's identity/sequence behaviour is the thing most
   likely to bite: confirm that `seq` still allocates monotonically after the conversion and that
   `appendEvent`'s `RETURNING seq` still returns what the dispatcher needs.
4. **Can drizzle express this at all?** `db:generate` produces the migration from a schema diff.
   Report honestly whether the partitioned shape is expressible in `drizzle/` or whether T2 must
   hand-write SQL inside a generated migration file — that changes T2's task body.
5. Create a DEFAULT partition plus two months. Insert rows dated into each. Confirm they land in the
   right partition (`tableoid::regclass`).
6. **Run the dispatcher against it.** `runDispatchCycle` must still deliver. Then add the floor
   predicate and confirm with `EXPLAIN (ANALYZE, BUFFERS)` that **partition pruning actually
   happens** — a floor predicate that prunes nothing is the whole feature failing silently.
7. Try dropping a partition and confirm what happens to `event_idempotency` rows that reference
   events in it (they are in a separate, non-partitioned table by design — verify that design holds).
8. `dropdb hmis_spike_part`.

**Decision rule:** the branch that completes with the dispatcher green and pruning demonstrated.
Report the SQL that worked, verbatim — T2 will start from it.

---

## Question C — where does pgBackRest run, and does a restore complete? *(resolves FORK-C)*

Postgres runs as `postgres:16` in Docker. pgBackRest has never run against this database.

1. Stand up a **throwaway** compose project (`hmis-spike`) with its own Postgres and its own volume.
   Do not touch `hmis-db-1`.
2. Try the three placements: (i) pgBackRest inside the Postgres image, (ii) a sidecar container
   sharing PGDATA, (iii) on the host. Report which is least coupled to the Postgres image — because
   in stage 3 that image may change.
3. Configure a repo over **SFTP** if you can reach one; if no destination is available to you, use a
   local repo path and **say clearly that the SFTP leg is untested** rather than implying it works.
4. Take a full backup. Write some rows. Take another. **Then restore into a scratch database and
   verify the rows are there.** A backup that has not been restored is not evidence.
5. Time it, and measure the repo size against the database size.

**Decision rule:** the placement that produces a completed restore with the least coupling.
**If no restore completes, that is the finding**, and it is more valuable than three that do.

---

## Question D — what does the monitoring stack cost on one box? *(resolves FORK-D)*

Spec §5 wants Grafana + Prometheus + Loki. The stage-1 VM also runs Postgres, the API, the worker
and Caddy.

1. Stand up Prometheus + Grafana + node_exporter + postgres_exporter in the throwaway project.
2. **Measure resident memory and steady-state CPU.** Report absolute numbers and the fraction of a
   CX43-class VM (8 vCPU / 16 GB).
3. Confirm `postgres_exporter` can read what the heartbeat-staleness rule needs — the worker already
   writes `scheduler_heartbeats` (Plan 08.5), so the rule should read shipped data rather than
   needing new instrumentation. Verify that.
4. Do **not** stand up Loki. The plan defers it; your job is to say whether even the reduced stack
   fits.

**Decision rule:** if the reduced stack costs more than ~15% of the VM, FORK-D branches to putting
Prometheus/Grafana on the existing build host and scraping over the private network.

---

## Question E — does a WebSocket upgrade survive Caddy? *(added 2026-08-22; discharges plan flag ④ early — not a fork)*

Nothing in this repository has ever run behind Caddy, and the realtime gateway lives inside the API
process (plan D1), so an untested proxy config is a dead bell. The plan's T3 carries this as
verify-by-execution flag ④; you can convert it from a flag into a measured fact for the cost of one
container, inside the same throwaway project you already have up.

1. Add a `caddy:2` container to `hmis-spike`, listening on a **HIGH port** (nginx owns 80/443 —
   ground rules above), reverse-proxying to the API you booted for Question A (compiled or `tsx`,
   whichever runs).
2. Prove `/health` answers THROUGH Caddy.
3. Open a WebSocket **through Caddy** to the realtime gateway and confirm the upgrade completes
   (HTTP 101). Report what the gateway then does with the connection — an auth-rejection close is
   still a completed upgrade; say which you observed, and quote it.
4. If the upgrade needs anything beyond a bare `reverse_proxy` directive in the Caddyfile, that is
   the finding — name it precisely. Report the exact Caddyfile that worked, verbatim: T3 starts
   from it.

**Decision rule: none — this is not a fork.** Its output is flag ④ converted from "an admission we
could not check" (EXECUTE-METHOD §1) into measured behaviour, plus the Caddyfile T3 inherits.

---

## What to report

A markdown report at `docs/superpowers/plans/reports/plan-11a-spike-report.md`, committed to `main`
as a **docs-only commit** (the report is the deliverable; the spike code is not). For each question:
**the verdict, the command that produced it, the output quoted, and the fork resolved.** Then:

- **Anything you found that the plan does not know about.** This is the highest-value section of a
  spike report and 08.5's is the precedent: its question D was routine housekeeping and returned the
  finding that reshaped the plan.
- **Every claim you are making from reading rather than running**, labelled as such (§2.60). A spike
  that blurs the two is worse than no spike, because the plan will trust it.
- **Host state at the end:** `git status --porcelain` on the server, your throwaway containers gone,
  your scratch databases dropped, no `*.mutant.*`/`.log`/`.exit` residue, and your local mirror left
  in place (rule 22(f) — you do not delete it and `rm -rf` is denied on this host anyway).
- If you applied a schema change anywhere and could not undo it, **AGENT-RULES §6: stop and report
  which migrations are applied to which databases. Never clean up by hand.**
