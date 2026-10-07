# HMIS — the rules that bind every session

Indian hospital OS. pnpm monorepo: `apps/core` (NestJS + drizzle + Postgres, jest), `apps/web` (Vite + React 19,
vitest), `apps/mobile` (Expo, not in the workspace), `packages/contracts` (zod schemas both sides share). Node 22.
**Production runs on its own server, `2.28.235.10`.** This box is staging + development; it keeps the old production
stack stopped as a rollback — never start it, never touch `hmis-prod-*` containers.
How-to detail lives in skills (`.claude/skills/`): lane-workflow, run-tests, staging-and-deploy, module-knowledge,
brief-subagent, serena, token-audit.

## Working
- **One lane per session; never edit `/opt/hmis` directly** (it stays on `main`; a stray file there blocks deploys).
  `tools/lane.sh new <name>`. Commit by pathspec, never `git add -A`. Read the lane's `HANDOFF.md` first and overwrite it
  before you stop. `tools/lane.sh drop <name>` when the lane closes. → skill `lane-workflow`
- **One task per session**: start a new task with `/clear` or a fresh session, naming the module.
- **A red `main` freezes merges.** Whoever pushed the red fixes it first, before anything else.
- **Spec before build** (owner 2026-10-07): for a feature or behaviour change, ask at most five questions the rulings and
  code cannot answer, write a ~10-line spec with **"done means"** checks, build only after the owner's yes. Obvious bug
  fixes skip this.
- **Take the test lock around every jest/vitest run**, targeted or full; the full core suite belongs to CI. → skill `run-tests`
- **Staging first; merging to `main` IS the production push.** Stage the lane, ask the owner "OK for production?", merge
  only on their yes (docs/CI-only changes: say so, still ask). Never run `deploy.sh` by hand. → skill `staging-and-deploy`
- **Brief subagents from `docs/agents/BRIEF.md`.** → skill `brief-subagent`

## Read before you change
- `docs/architecture/modules/<m>.md` (generated) and `apps/core/src/modules/<m>/MAP.md` (hand-written) before exploring
  code; trust them over a grep crawl. `docs/decisions/` (generated `index.md`) for the owner's rulings in your area.
  Regenerate with `node tools/arch/gen.mjs` after structural changes; never hand-edit generated files. → skill `module-knowledge`
- Read the phase doc for your lane; for closing a phase, `docs/superpowers/EXECUTE-METHOD-V3.md` §5A only.
- Do not read `EXECUTION-LESSONS.md` (468 KB), the plan series index or the project brief unless a task names a section.
  Context is re-sent every turn; a big early read is paid for on every turn after it.

## Files that belong to everyone — coordinate before editing
`kernel/**`, `kernel/db/schema/index.ts`, `app.module.ts`, `worker.module.ts`, `kernel/modules/manifests.ts`,
`scripts/seed-roles.ts` + `test/seed-roles.test.ts` (pins permission counts), `test/caddyfile-parity.test.ts` (pins route
counts), `apps/web/src/router.tsx`, `apps/web/src/locales/*.json`, `apps/core/drizzle/**` (take the next free migration
number when you merge `main`, not when you start). `patients`, `tariff`, `billing` are imported by nearly every module: a
signature change there breaks every lane. Leaf modules (`lab`, `radiology`, `ot`, `materials`, `membership`, `partners`,
`pcpndt`, `formulary`) are safe to own alone. Modules import each other only through the other's `index.ts` (lint-enforced).

## Rules that bind
- Evidence over assertion: never report a test green you did not run in that state; paste counts.
- A new test must fail first against the code it guards; a fixed finding is done when the suite runs, not when it compiles.
- Never weaken a guard, permission check or audit write to make a test pass.
- **Approved acceptance checks are locked**: owner-approved "done means" tests live under `acceptance/` folders. Add new
  ones freely; never edit, delete or rename an approved one — CI fails it unless the owner adds the PR label
  `owner-approved-checks`. Agents never add that label.
- Never rewrite pushed history. Never `git checkout` over uncommitted work (a revert is a write).
- Migrations are irreversible host mutations: additive, one per PR, numbered at merge time.
- Never emit compiled JS into `src` (`tsc` without `--noEmit` is banned outside `build`).
- Tests must not pin dates that the code under test reads from the real clock.
- Owner rulings are for money, procurement and law only. Anything else: pick the standard Indian-corporate-hospital
  answer, mark it DECIDED, keep going. A new ruling is a new numbered file in `docs/decisions/`; old ones are only
  marked superseded.
