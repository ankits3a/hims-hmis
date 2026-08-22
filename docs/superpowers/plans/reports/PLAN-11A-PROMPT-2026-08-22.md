# Prompt — brainstorm Plan 11a with the owner, then write the final plan

> **For a FRESH session (Fable recommended for the brainstorm + writing).** Written 2026-08-22 at
> `28bf8db` by the session that shipped Plan 10, amended the spec to v4.7, and wrote 11a's
> fork-open draft. **You brainstorm and you write. YOU DO NOT COMPILE AND YOU DO NOT EXECUTE** —
> that separation has been paid for three times in this project, and it is the reason this file
> exists instead of that session just carrying on.

---

## 0. What you are doing

The owner wants to **brainstorm Plan 11a more deeply and then write the execution plan.** A draft
already exists and is deliberately fork-open; treat it as a strong starting position, not as
settled. Your output is a finished plan document (and any amended spike brief), committed. A
different, fresh session compiles and runs it afterwards.

**Recommended order, and the reasoning matters:**

1. **Skim the spike brief with the owner (~5 minutes), then FIRE THE SPIKE** before the deep
   brainstorm. Its four answers are *facts the brainstorm needs* — whether compiled output boots,
   whether the partitioned recreate works, where pgBackRest can run, whether the monitoring stack
   fits the box. Brainstorming scope while those are unknown produces opinions where measurements
   were available. If the brainstorm would obviously change what the spike asks, amend the brief
   first and then fire.
2. **Brainstorm with the owner while the spike runs.**
3. **Resolve the four forks from the spike's measurements**, marking each dead branch dead **in
   place** (ledger §2.48 — do not merely record the verdict in a "spike verdicts" block; a
   fork-open plan seeds the losing branch everywhere, and 08.5's FORK-B had live consequences in
   nine separate places).
4. **Write the final plan.** Then stop and hand off.

---

## 1. Read first, in this order

| # | file | what to take |
|---|---|---|
| 1 | `docs/superpowers/AGENT-RULES.md` | the binding contract, in full. **Rules 6, 7 and 9 are about to become stale — see §5 below** |
| 2 | `docs/superpowers/EXECUTE-METHOD.md` | v2 in full. §1 (why a spike), §2 (what a plan must carry), §3 (the compile-time sweep the NEXT session runs — write the plan so it passes), §8 (the calibration note; read it before promising a token number) |
| 3 | `docs/superpowers/plans/2026-08-22-phase1-11a-deployment.md` | **the draft you are refining.** Fork-open, D1–D13, four forks, six tasks, a self-review section |
| 4 | `docs/superpowers/plans/2026-08-22-phase1-11a-spike-brief.md` | the spike you are about to fire |
| 5 | `docs/superpowers/plans/2026-08-11-phase1-plan-series.md` | the roadmap. The "Open architectural decisions" block and the Plan 11a / 11b / 11c entries |
| 6 | `docs/superpowers/specs/2026-08-10-hmis-architecture-design.md` | **spec v4.7** — design law. §1 (the staged-deployment ruling), §2, §5, §12, §13, §19. Never re-litigate the spec in a planning session; open questions go to the owner |
| 7 | `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` | the ledger, §2.1–§2.68 and §3.x. §2.62–§2.68 are three days old and every one is live for this plan |
| 8 | `docs/superpowers/plans/reports/plan-10-gate-report.md` | the most recent shipped plan, and **read it cold**: it books two MAJOR gaps and one undischarged CI criterion. §8 (what the run cost and why) is the calibration input for 11a's budget |
| 9 | `docs/superpowers/plans/2026-08-21-phase1-10-notifications.md` | the current best-in-series plan document. **Copy its SHAPE**: owner rulings block, D-numbered decisions, Global Constraints, File Structure with a forward-reference audit, per-task Files lists, an Assertion Book with a P column, verify-by-execution flags, a commit-messages table, a self-review section, Pipeline Notes, Decisions-for-the-owner |
| 10 | `docs/superpowers/plans/reports/PLAN-10-PROMPT-2026-08-21.md` | the precedent for a prompt of this kind, if you want the shape |

---

## 2. Ground truth — verify it, do not trust it

- **HEAD `28bf8db` on `main`.** Local `C:\Users\ankit\hmis`, build host
  `root@62.238.106.231:/opt/hmis`, and `origin/main` were all in sync at handoff. **Re-verify all
  three and `git pull --rebase` anything stale** — the build host has been found stale before.
- **Test baseline, measured 2026-08-22 detached with the exit VALUE read from a file:** `apps/core`
  **132 suites / 908 tests** · `apps/web` **31 files / 152 tests** · `packages/contracts` **3 / 7**.
  Re-measure before you quote anything; measurement beats this document.
- **Next migration is `0016`.** Latest is `apps/core/drizzle/0015_previous_shiver_man.sql`.
- **The repo is PUBLIC** (for Actions minutes). If CI starts reporting `failure` on runs lasting
  **seconds**, that is the billing/spending block, not code (§2.59).
- **CI is green on everything except `0f512c3`, which has NO RUN AT ALL** and cannot be given one
  retroactively (§2.62). Do not record it as green.
- **The SSH connection to the build host is intermittently flaky** — resets and timeouts. Wrap
  remote calls in a retry; a 255 is a transport failure, not a command verdict.
- **Two orphaned shells may still be spinning on the host**, PIDs `3501080` / `3502071`, command
  line `bash -c while pgrep -f "jest-worker|jest/bin/jest.js" …`. They **match themselves** and can
  never exit. They are NOT test runs. Rule 20: read the matched COMMAND LINES, never the count.
  Nobody has killed them under rule 8; the owner may.

---

## 3. What just shipped, so you do not re-derive it

**Plan 10 — the Notifications Gateway — SHIPPED 2026-08-22**, six commits `48f118e`..`b6d5647`,
6/6 first-rung passes, 20 mutants / 20 died. Gate report is the ground truth. What now exists:

- A `notifications` **outbox** table; nothing human blocks on it (modules and consumers only INSERT).
- A **pump** — the **seventh** job on 08.5's `Scheduler` — that claims rows with
  `FOR UPDATE SKIP LOCKED` **before** any adapter call (deliberately the opposite of the
  dispatcher, because a message cannot be un-sent), applies a suppression gauntlet
  (expiry → deceased → promotional → quiet hours → channel), renders, and sends.
- A **template registry** — five templates, both languages enforced by the type system.
- A **`kernel.notify` consumer** on the dispatcher, and `workerConsumers(db)` as the one importable
  place the production consumers map exists (this closed 08.5's booked residual).
- `DispatchedEvent` gained `occurredAt` — a **three-line, zero-deletion** dispatcher edit.
- Console adapters only. **The system has not messaged a real person and cannot yet.**

**Two MAJOR gaps are BOOKED, NOT FIXED, and 11a inherits neither but should not forget them:**
(a) nothing pins the suppression gauntlet's **order** — relocate the deceased hard stop past channel
resolution and the whole suite stays green while a deceased-and-phoneless patient becomes a desk
task telling a duty manager to phone the family; the missing assertion is one row. (b)
`NOTIFY_STUCK_AFTER_MS` is a **dead config key** nothing reads. Both are small. **Recommend clearing
them in a short remediation before or beside 11a** — ask the owner.

---

## 4. The owner's rulings you are building on (do not re-litigate)

**DEPLOYMENT IS STAGED — ruled 2026-08-22, now spec v4.7 §1:**

1. **Stage 1, now:** ONE cloud (Hetzner) server, no standby. Phase-1 build and owner UAT. **11a's target.**
2. **Stage 2, after Phase-1 UAT:** live pilot in the working hospital **as a SECONDARY HMIS beside
   the incumbent**, then hybrid — on-prem primary + cloud standby/backup. **Plan 11b.**
3. **Stage 3:** fully on-prem, exactly as spec §1 line 21 says.

**Spec §1 is NOT superseded.** On-prem is still the destination; it stopped being the starting line.

**The constraint that falls out, and it is 11a's hardest:** *nothing may be built that makes stage 3
expensive.* No provider-specific primitive in the deployable — no cloud load balancer, no cloud
volume as a hard dependency, no cloud DNS, no cloud secrets manager. The stack must stand up from
**Compose + Caddy + Postgres + pgBackRest on any capable metal**. SFTP is a *protocol* and is
permitted; a managed product is not. The test any task can be failed on: *if the on-prem box were
racked tomorrow, what in this diff would have to be REWRITTEN rather than RE-POINTED? Nothing.*

**Plan 11 split three ways** (2026-08-22): **11a** deployment (this plan) · **11b** the hybrid step,
waits on stage-2 hardware · **11c** operating modes, downtime kit, interface heartbeats, D-17 gate
wiring — split out because 11a came to nine or ten tasks, past the six-task pipeline limit.

**Also settled and worth not rediscovering:** `pg-boss` is **dead** — it lost by measurement in
08.5 (ESM-only, the jest harness cannot parse it, zero tests ran), it was never a dependency, and
it must not become one. It was still live design law in the roadmap's global-rules block and the
spec's tech table until 2026-08-22; both are now struck. Jobs ride
`apps/core/src/kernel/worker/scheduler.ts`.

---

## 5. ⚠ THE SERVER IS CHANGING — InsForge is being removed

**The owner is removing the InsForge stack completely and dedicating `62.238.106.231` to this
project.** At the time of writing it had not happened yet. **VERIFY THE ACTUAL STATE BEFORE YOU
RELY ON EITHER VERSION** — `docker ps`, `ls /opt`, and check ports 5430 / 5432 / 7130 / 7133.

This invalidates standing rules and roadmap facts. **Once you have confirmed InsForge is gone,
amend these in a visible docs commit** (and if it is NOT gone yet, leave every one of them exactly
as it is — they are still binding):

| where | current text | why it changes |
|---|---|---|
| `AGENT-RULES.md` rule 6 | *"Never read, stat, list, or reference `/opt/InsForge` or any `insforge-*` container"* | obsolete once the stack is gone. **Do not silently delete it** — mark it retired with its date, so an agent reading an older brief that cites rule 6 is not confused |
| `AGENT-RULES.md` rule 7 | *"Create no docker container"* | this was partly about protecting a shared daemon. With the box dedicated, **11a's whole point is creating containers.** Rule 7 needs a carve-out for the `hmis` compose project — write it precisely, because "create no container" and "ship a production compose" cannot both be true |
| `AGENT-RULES.md` rule 9 | *"guard every `apt` with `NEEDRESTART_MODE=l` so it cannot bounce the shared docker daemon"* | the daemon is no longer shared. The guard is still good hygiene; the *reason* changes |
| roadmap line ~23 | *"The server is **shared with an unrelated InsForge stack**… off-limits to every agent"* | becomes false |
| roadmap "Brief boilerplate" (~line 25) | carries the InsForge prohibition inline | every future brief copies this block; it must be correct |
| 11a's Decision 3 + roadmap ~line 278 | *"stage 1 needs its own VM… the InsForge co-tenant's home"* | **the reasoning changes but the recommendation may still stand.** Removing InsForge frees ~3 containers and ports, but the box is still the **build host**, and production must not share a machine with a suite that hammers Postgres and truncates databases. Re-derive this with the owner rather than inheriting either answer |

**What removal buys, and it is worth quantifying in the brainstorm:** the box is a **Hetzner CX43,
8 vCPU / 16 GB / 160 GB, Helsinki `hel1`**. InsForge was three containers plus its own Postgres
holding port **5432** (this project's dev DB is on 5433). Freed RAM/CPU/disk directly affects
FORK-D (does the monitoring stack fit?) and the "does production get its own VM" question. **Measure
the box after removal and feed the number into both.**

**One caution.** Whoever removes InsForge should be certain nothing else depends on it. That is the
owner's call and the owner's action — **do not remove it yourself**, and do not touch it until the
owner confirms it is gone.

---

## 6. Plan 11a as it stands — the four forks the spike closes

The draft's decisions are **D1–D13**; the forks are:

- **FORK-A — production runs COMPILED output, or `tsx`?** No `build` script exists in `apps/core`
  and there has never been compiled output. **`emitDecoratorMetadata: true` is already set**, so a
  `tsc` build *should* emit `design:paramtypes` where esbuild does not — which would mean the
  compiled production build works where `pnpm start:dev` has been **broken since Plan 07** (§2.58,
  `OpdRealtimeRegistrar` gets `undefined` injected). That is a *prediction*; rule 21 governs
  predictions. The obstacle, if there is one, is `NodeNext` output semantics and nobody has looked.
- **FORK-B — how the irreversible `events` partitioned recreate is performed.** Against a **COPY**
  of the dev database, never the original, never a `hmis_test_<N>`. AGENT-RULES §6 is the live risk.
- **FORK-C — where pgBackRest runs** (in the Postgres image / sidecar / host), and **does a restore
  actually complete**. On a single server the restore drill is the *entire* DR story.
- **FORK-D — does Prometheus + Grafana fit the box** alongside Postgres, api, worker and Caddy.
  Loki is deferred to stage 2 in the draft, with the reason written down.

**Things the draft added that nobody had scoped, and that you should keep:**
`notifications` **retention** — Plan 10 shipped an outbox that gains a row per would-be message and
never prunes (~10⁶ rows/year at target volume). Terminal rows age out; **`queued` and `sending`
never do at any age**, because a `sending` row is the only record that a message may already be with
a patient. And **events retention ships INERT** — `RETENTION_ENABLED` defaults false, legal holds
are rows checked structurally, and the owner switches it on with a value counsel has signed. That is
Plan 10 D9's shape (the promotional refusal) reused deliberately.

---

## 7. Brainstorm agenda — the questions actually worth the owner's time

Do not spend the session confirming the draft. Spend it on these:

1. **Is the six-task scope right, and is 11c's boundary right?** 11a is "it deploys, it survives, it
   does not grow forever." Is anything in 11a really 11c's, or vice versa?
2. **Retention windows and legal holds.** Indian medical-record retention has statutory floors that
   vary by record class and by whether a matter is under litigation. **This is a counsel question,
   not a code one** — but the owner should decide *who* answers it and by when. The mechanism ships
   inert either way.
3. **A domain name and TLS.** Caddy does automatic HTTPS given a hostname. Without one, stage 1 is
   IP-only with a self-signed cert — fine for a build/UAT box, **not fine for the stage-2 pilot**.
4. **The production VM** (re-derive after the InsForge removal — see §5).
5. **The backup destination.** Draft recommends a Hetzner Storage Box over SFTP (~€3.5/mo, 1 TB),
   chosen for portability. Confirm or replace.
6. **When the stage-2 pilot starts** — it triggers the new **PRE-PILOT gate** (spec §19 v4.7): a
   DPDP posture for **real patient data on a cloud host outside India**, plus E-11's
   transition-operations boundary map for the two-system period. Weeks of lead time if counsel is
   involved. **Worth starting now, and it is easy to forget because it is not a code task.**
7. **Should Plan 10's two booked MAJORs be cleared first, beside, or later?**
8. **Budget.** Read EXECUTE-METHOD §8 *before* promising a number: count the required-DIED mutants
   in your Assertion Book first. Plan 10 came in at **2.64M against a 1.2M target** — not because
   the run overspent, but because the target was set by analogy ("smaller than 08.5, no spike")
   instead of by counting twenty mutants on a send path. That is ledger §2.68 and it is three days
   old. 11a has a spike **and** several CRITICAL tasks; do not repeat the mistake in either
   direction.

---

## 8. Hard constraints on you

- **AGENT-RULES.md binds you and every agent you spawn.** The build host is the only place evidence
  comes from. Never write or run git against the owner's Windows checkout from a spawned agent
  (rule 2); the main session commits docs from it, which is how this file got here.
- **You may fire the spike. You may NOT compile the pipeline or run the plan.** The writer never
  compiles — paid three times.
- **The spike's report is a docs-only commit**; the spike's code is thrown away.
- Nothing lands on `main` except: the spike report, the amended plan and spike brief, any
  §2.24-disciplined amendment (visible commit naming the contradiction + a full-document grep), the
  AGENT-RULES/roadmap amendments from §5 **once InsForge is confirmed gone**, and roadmap/ledger
  updates.
- **Write the plan so it passes EXECUTE-METHOD §3's compile-time sweep**, because the next session
  runs it and every defect it finds is one you could have prevented: every File Structure path must
  resolve (modify-targets exist, create-targets do not) · no task may name a file, export or symbol
  owned by a LATER task · **for every symbol a task WIDENS or census it GROWS, grep the tree for the
  other readers and put each one in somebody's Files list** (§2.65 — that is the class that nearly
  halted Plan 10's T4: a file *no task owned* that a widened `Pick` would break) · every task needs
  a commit message in the plan's own table · no assertion may be `[] === []`.
- **Run `bash docs/superpowers/pipelines/ci-watch.sh &` if you push anything** — but know that it
  **stalls permanently on the first commit that has no run** (§2.63) and reports only exceptions, so
  it is currently unreliable. Fixing it is booked. Check CI by full SHA yourself.

---

## 9. Where things live

```
docs/superpowers/
  AGENT-RULES.md                                   the binding contract (v2)
  EXECUTE-METHOD.md                                the method (v2)
  specs/2026-08-10-hmis-architecture-design.md     design law (v4.7)
  plans/2026-08-11-phase1-plan-series.md           the roadmap + open decisions
  plans/2026-08-21-phase1-10-notifications.md      Plan 10 (SHIPPED) — copy its shape
  plans/2026-08-22-phase1-11a-deployment.md        ← YOUR DRAFT
  plans/2026-08-22-phase1-11a-spike-brief.md       ← THE SPIKE
  plans/reports/EXECUTION-LESSONS.md               the ledger (§2.1–§2.68, §3.x)
  plans/reports/plan-10-gate-report.md             read cold
  plans/reports/plan-10-findings-inbox.md          what Plan 10's agents routed to each other
  pipelines/plan-10-notifications.js               the most recent compiled pipeline
  pipelines/plan-10-notifications.preflight.js     196 assertions, 5 negative controls — copy it
  pipelines/ci-watch.sh                            currently stalls; see §2.63
```

Build host `root@62.238.106.231:/opt/hmis` · owner's checkout `C:\Users\ankit\hmis` ·
out-of-git context `C:\Users\ankit\hmis-context\`.

---

## 10. When you are done

The plan is finished when: the four forks are resolved from **measurement** with each dead branch
marked dead **in place** · the File Structure resolves against the tree · every task has a Files
list, a risk tier, acceptance criteria and an exact commit message · the Assertion Book names a
killing mutant and a discriminating input per row, with `P` on any row whose input is a prediction ·
the verify-by-execution flags each name an owning task · there is a self-review section saying what
your own passes caught · and the Decisions-for-the-owner section lists what stalls without each.

**Then write an execute-handoff prompt beside it** (the shape of
`reports/PLAN-10-EXECUTE-PROMPT-2026-08-21.md`) and **stop**. A fresh session compiles and runs it.
