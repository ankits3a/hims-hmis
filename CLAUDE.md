# HMIS — how a session works here

Indian hospital OS. pnpm monorepo: `apps/core` (NestJS + drizzle + Postgres, jest), `apps/web`
(Vite + React 19, vitest), `packages/contracts` (zod schemas both sides share). Node 22.
Production runs from `/opt/hmis-prod` on this same box; never touch `hmis-prod-*` containers.

## One lane per session — never edit /opt/hmis directly

`/opt/hmis` is the integration checkout and stays on `main`. Work happens in a lane:

```
tools/lane.sh new <name>        # worktree /opt/hmis-lanes/<name>/hmis, branch lane/<name>, own test DBs
cd /opt/hmis-lanes/<name>/hmis && claude
tools/lane.sh status            # who else is running tests, free memory, every lane's drift
```

- Commit on the lane branch, by pathspec: `git commit -m "…" -- <paths>`. Never `git add -A`.
- Rebase on `origin/main` before opening the PR. `gh pr create`; CI is the gate; squash-merge.
- A red `main` freezes merges. Whoever pushed the red fixes it, immediately, before anything else.
- Close the session when the lane closes: `tools/lane.sh drop <name>`. Idle sessions hold the
  box's memory and that is what OOM-kills jest.
- **Each lane has a handoff, `/opt/hmis-lanes/<name>/HANDOFF.md`** (outside git; `lane.sh new` writes the
  template, `drop` archives it). Read it first when you start in a lane; overwrite it (≤40 lines) before
  you stop or when the context grows long. It is what lets the next session resume without re-reading.
- **One task per session.** Start a new task with `/clear` or a fresh session in its lane, and name the
  module in the first message. Every turn re-sends the whole conversation; a long mixed session pays
  for all of it on every turn.
- **Spec before build (owner 2026-10-07).** For any feature or behaviour change the owner asks for:
  ask only what the rulings and the code cannot answer (at most five questions), then write a spec of
  about ten lines — what it does, who uses it, money rules, edge cases, and **"done means"** checks the
  owner can try on staging — and build only after the owner says yes. The same checks become the
  tests and the staging checklist. A bug fix with an obvious correct behaviour skips this.
- **Briefing a subagent:** use `docs/agents/BRIEF.md`. A brief that hands over what is known and asks
  for a fixed report saves the subagent its re-reading.

## Verify

**Take the lock around every pool — jest and vitest, targeted runs as well as full ones:**

```
L=/opt/hmis-lanes/.orchestrator/bin/test-lock.sh          # the arbiter; `$L status` says who holds it
pnpm typecheck && pnpm lint                               # fast, always — no lock, not a pool
$L run <lane> pnpm --filter @hmis/core exec jest -w 2 <path…>   # the suites you touched
$L run <lane> pnpm --filter @hmis/core exec jest -w 2           # full core (~15 min)
$L run <lane> pnpm --filter @hmis/web exec vitest run           # full web
```

Two jest pools plus vitest OOM a 15 GB host. `maxWorkers: 2` in `apps/core/jest.config.cjs` is an
owner ruling for that reason, and the full suite belongs to CI.

**`tools/lane.sh status` is not a substitute, and believing it was cost a peer a full-suite run
(2026-09-14).** It is a SNAPSHOT: it can be honest at the moment you read it and wrong by the time
you run, because a peer starts in between. The lock is the only thing that closes that window —
`$L run` blocks until the box is free instead of asking you to have looked. A suite killed for
memory looks nothing like a suite that failed, so the lane that skips the lock spends somebody
else's afternoon on a red nobody can reproduce.

## Show the owner on staging — https://stagehmis.crkmch.com

Commit on the lane, then `/opt/hmis/tools/stage.sh <lane>` (~5 min; user `uat`). Staging holds that
lane until its PR merges or closes, then follows main again by itself; `tools/stage.sh main`
releases it early, `--status` says what is on it. Only one lane at a time: check `--status` and
ask before replacing another lane's staging. Merged work reaches production and staging by itself
(cron `tools/auto-deploy.sh`, every 10 min, CI-green main only) — never run `deploy.sh` by hand.

**Merging to `main` is the production push, so it waits for the owner (owner rule).** Every change goes
to staging first; after the owner has looked, ask them: "Did you like it on staging? OK to push to
production?" Merge only on their yes. A change with nothing to see (docs, CI, tests only): say so, and
still ask before merging.

## Files that belong to everyone — coordinate before editing

`kernel/**`, `kernel/db/schema/index.ts`, `app.module.ts`, `worker.module.ts`,
`kernel/modules/manifests.ts`, `scripts/seed-roles.ts` + `test/seed-roles.test.ts` (pins
permission counts), `test/caddyfile-parity.test.ts` (pins route counts), `apps/web/src/router.tsx`,
`apps/web/src/locales/*.json`, `apps/core/drizzle/**` (serial numbers: take the next free one when
you rebase, not when you start). Modules `patients`, `tariff`, `billing` are imported by nearly
every other module: a signature change there breaks every lane. Leaf modules (`lab`, `radiology`,
`ot`, `materials`, `membership`, `partners`, `pcpndt`, `formulary`) are safe to own alone.
Modules import each other only through the other module's `index.ts` (lint-enforced).

## Rules that bind

- Evidence over assertion: never report a test green you did not run in that state; paste counts.
- A new test must fail first against the code it guards; a fixed review finding is done when the
  suite runs and the count is read, not when it compiles.
- Never weaken a guard, permission check or audit write to make a test pass.
- **Approved acceptance checks are locked.** A feature's owner-approved "done means" tests live under an
  `acceptance/` folder (`apps/core/test/acceptance/<feature>/`, `apps/web/src/acceptance/<feature>/`). Add
  new ones freely; never edit, delete or rename an approved one — CI fails it (`tools/ci/acceptance-guard.mjs`)
  unless the owner adds the PR label `owner-approved-checks`. Agents never add that label themselves.
- Never rewrite pushed history. Never `git checkout` over uncommitted work (a revert is a write).
- Migrations are irreversible host mutations: additive, one per PR, numbered at rebase time.
- Never emit compiled JS into `src` (`tsc` without `--noEmit` is banned outside `build`).
- Owner rulings are for money, procurement and law only. Anything else: pick the standard
  Indian-corporate-hospital answer, mark it DECIDED in the phase doc, keep going.
- Owner rulings live in `docs/decisions/` (listed in its generated `index.md`). Read the ones for your area
  before building; a new ruling is a new numbered file, an old one is only marked Superseded.
  A new decision is a new file with OKF frontmatter (shape in its README); run `node tools/arch/gen.mjs` to
  rebuild the index. Never edit `index.md` by hand.

## Reading budget

**Before exploring code, read `docs/architecture/README.md`, then the page for the module you touch
(`docs/architecture/modules/<m>.md`: dependencies, public API, routes, tables).** It is generated
from the source and CI keeps it current, so trust it over a grep crawl. After changing module
imports, an `index.ts`, routes, tables or web routes, run `node tools/arch/gen.mjs` and commit the
result; after a rebase conflict in `docs/architecture/`, regenerate instead of merging by hand.

A module may also have hand-written notes, `apps/core/src/modules/<m>/MAP.md` (flows, invariants,
traps, callers); its architecture page links it. Read it before changing that module, and update it in
the same PR when you change a flow or a trap. Cite a file and a symbol, never a line number: `--check`
fails on a line number or on a file that no longer exists.

**Serena (optional, on demand).** For cross-module reading or a rename, a language-server MCP is
installed (`serena`, read-only, memory off). Measured 2026-10-07: about a third fewer tokens read,
sharper citations, but ~2 GB RAM while running and ~4 GB while indexing, so one lane at a time and
never during someone's jest run. Index and use it in YOUR lane only:
`cd <lane> && serena project create --language typescript --index`, then start the session with
`--mcp-config` pointing at `serena start-mcp-server --context claude-code --project <lane>`.
Its `.serena/` cache is git-ignored; never create it in `/opt/hmis`.

Read the phase doc for your lane and this file. Do not read `EXECUTION-LESSONS.md` (468 KB), the
plan series index, or the project brief unless a task names a section. Method for closing a
phase: `docs/superpowers/EXECUTE-METHOD-V3.md` §5A only. Context is re-sent every turn; a big read
at turn three is paid for on every turn after it.
