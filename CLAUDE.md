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
- Never rewrite pushed history. Never `git checkout` over uncommitted work (a revert is a write).
- Migrations are irreversible host mutations: additive, one per PR, numbered at rebase time.
- Never emit compiled JS into `src` (`tsc` without `--noEmit` is banned outside `build`).
- Owner rulings are for money, procurement and law only. Anything else: pick the standard
  Indian-corporate-hospital answer, mark it DECIDED in the phase doc, keep going.

## Reading budget

Read the phase doc for your lane and this file. Do not read `EXECUTION-LESSONS.md` (468 KB), the
plan series index, or the project brief unless a task names a section. Method for closing a
phase: `docs/superpowers/EXECUTE-METHOD-V3.md` §5A only. Context is re-sent every turn; a big read
at turn three is paid for on every turn after it.
