# Prompt — brainstorm and plan the next phase after Plan 11a (NO EXECUTION)

Brainstorm with me and then WRITE A PLAN for whatever comes after Plan 11a. **You are not
executing anything this session** — no pipeline, no agents shipping code, no commits to `apps/` or
`packages/`. Your deliverable is a decision and a document.

Invoke `superpowers:brainstorming` before you propose anything. Do not enter plan mode or write a
line of the plan until we have actually talked.

## Where things stand

Indian hospital platform, greenfield, built solo by me directing AI agents. Evidence comes only
from the build host `root@62.238.106.231:/opt/hmis`. My checkout is `C:\Users\ankit\hmis` — docs
only, never run git there from a spawned agent.

**Plan 11a shipped 2026-08-23 and its four MAJOR residuals are closed.** Production is LIVE:
`https://hmis.crkmch.com`, auto-HTTPS, api + worker + Caddy + Postgres + Prometheus + Grafana +
two exporters under the `hmis-prod` compose project, sharing the build host with the dev stack by
owner ruling. The database archives WAL continuously to Cloudflare R2 with nightly fulls and a
weekly restore drill on host cron; a real restore has been performed and verified. `pnpm verify`
is green: `apps/core` 138 suites / 961 tests, `apps/web` 31/152, `packages/contracts` 3/7.

**Read these before you form an opinion, in this order:**

1. `docs/superpowers/plans/reports/plan-11a-gate-report.md` — **including its ADDENDUM.** Read it
   cold. It is deliberately unflattering and it is the most useful thing in the repo right now.
2. `docs/superpowers/plans/2026-08-11-phase1-plan-series.md` — the roadmap. **§"Sequencing notes"
   at the end**, the Plan 09 / 11c / 12a / 13 entries, and **§"Deferred design notes" (notes 1–17)**,
   which are mine and which nothing has scheduled yet.
3. `docs/superpowers/specs/2026-08-10-hmis-architecture-design.md` — the spec (v4.7).
4. `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` — skim §3 (plan-authoring defects). §2 is
   about running pipelines and matters less to you this session, but **§2.68 does**: count the
   Assertion Book's required-DIED rows before you promise a token number, and for an
   infrastructure-shaped plan count the DRILLS instead — 11a was set on mutant count and came in
   1.39× over.
5. `docs/superpowers/AGENT-RULES.md` and `docs/superpowers/EXECUTE-METHOD.md` — you are writing a
   document a later session will compile against these. Rules 3 and 7 were amended for 11a and
   `hmis-prod` is now production data.

## The actual question, and it is genuinely open

The roadmap's stated order is `… → 11a → 09 → 11c → 12a → 13 → stage 2`, but that order predates
11a shipping and predates notes 9–17. **I want you to argue for what should be next, not to
execute the roadmap's default.** The candidates, with what I already think:

- **Plan 11c — operating modes and the downtime kit.** Split out of 11a as hospital-operations
  concerns. Blocks nothing technically but is a **go-live gate**: operating modes, the
  `interface.down/.restored` heartbeat framework, the downtime-kit generator, D-17's
  config-validation gate, E-10's commissioning flag.
- **Plan 09 — memberships, coupons, the accrual ledger.** Real revenue surface. Its slot depends
  on an open question I have not answered: whether memberships must carry over at cutover.
- **Plan 12a — the agent runtime plus two proofs.** Notes 13, 14 and 17 (untrusted-content
  boundary, abstention/action budgets/tiered halts, calibration-gated progressive autonomy) are
  the substance of it and are currently only notes. It needs DPIA / inference-locus decisions I
  have not made.
- **The un-planned gaps** at the end of the roadmap — the dues / credit-bill lifecycle (zero hits
  anywhere in spec or plans), patient advance as a ledger instrument distinct from deposit policy,
  and refund guard rules. These are counter-level interlocks from my previous system.
- **A pre-pilot hardening pass** — the PRE-PILOT gates are DPDP posture for real patient data on a
  cloud host outside India, and E-11's transition-operations boundary map for running two systems
  at once.

Press me on this. I would rather change my mind in the brainstorm than in the pipeline.

## Things that are true and will bite you if you assume otherwise

- **Retention ships INERT.** `RETENTION_ENABLED=false`, and it stays false until counsel signs the
  window. Anything you plan that assumes deletion happens is wrong today.
- **Escrow has not happened.** `deploy.sh` minted a pgBackRest repo cipher passphrase into
  `/opt/hmis-prod/.env.pgbackrest`. **Without it every backup in R2 is unreadable ciphertext,
  including by me.** If your plan touches DR, say so again.
- **Still open from 11a, none of it MAJOR:** no Alertmanager, so `severity: critical` alerts reach
  nobody; an `X-Powered-By: Express` leak; and `scheduler.test.ts`'s L14 census, a measured CI
  flake at ~16% of runs that **fails twice consecutively**, with a runtime/flake trade written up
  in gate report §7.9. If a plan of yours touches that file, read that section first.
- **E-1 (DMZ vs cloud relay) is still open** and blocks only the relay.
- **The repo is PUBLIC** for Actions minutes. A CI "failure" lasting seconds is billing, not code.
- **No new npm dependency** has entered this repo in several plans. Treat a `pnpm-lock.yaml` diff
  as something to justify loudly, not slip in.

## What I want out of the session

1. **A recommendation with reasons**, after we have argued about it — what is next, and what is
   deliberately not next and why.
2. **A written plan** at `docs/superpowers/plans/<date>-phase1-<nn>-<slug>.md` in the house style:
   owner rulings encoded, numbered design decisions, consumed shipped surfaces transcribed **from
   source with line references**, global constraints, a locked File Structure with per-task Files
   lists, an Assertion Book with a killing mutant and a discriminating input per row, risk tier
   per task, verify-by-execution flags, an exact commit message per task, Pipeline Notes, and a
   self-review section that says what your own passes caught.
3. **A spike brief if the plan needs one** — and say plainly whether it does. 11a's spike cost
   ~197k against a ~50k target and resolved four forks by measurement; it was the best-value phase
   of the whole plan. If your plan has a fork nobody has executed, it needs one.
4. **An execute prompt** for a later, separate session — because the writer must never compile its
   own plan. That separation has paid three times in this project.

## Boundaries

- **Do not execute.** No pipeline, no Workflow tool, no agents writing code, nothing under `apps/`
  or `packages/` touched. Committing the plan document, a spike brief and an execute prompt is the
  only writing you do.
- **Do not re-litigate 11a's shipped design** — the staged-deployment ruling, the shared box, R2,
  the partitioning shape. Build on them.
- Ask me for rulings rather than inventing them. Where I have to decide something, say so
  explicitly and list what stalls without it.
- If you find something in the gate report or the roadmap that is wrong, say so — I would rather
  fix a bad premise now than plan on top of it.
