# Prompt — execute Plan 11a (Phase 0 → compile → run → verify), forks already resolved

> **For a fresh session.** The plan is OWNER-APPROVED (2026-08-22, in-conversation — the eight
> rulings are recorded in the plan's own rulings block; this prompt is the record of the
> handoff). You have full authority through all five phases below, ending at the committed gate
> report. Written 2026-08-22 by the session that brainstormed with the owner, fired the spike,
> resolved the forks from its report, and wrote the plan — which is exactly why it must not
> compile it: the writer is the worst possible judge of whether its own Files lists resolve,
> three times paid.

> **Written 2026-08-22, after the spike.** The finalized plan, this prompt, and the roadmap flip
> land in **one commit — HEAD at handoff is that commit**; the spike report is **`ca14f46`**
> (`reports/plan-11a-spike-report.md`). The two rule amendments this plan needed are already on
> `main` (`f16aff1` rule 7 · `df8af0b` rule 3).

---

## 0. What you are doing — five phases, strictly in order

1. **VERIFY GROUND TRUTH** — §2 below, before anything else.
2. **PHASE 0 — the remediation** (plan section "Phase 0"): three commits, in order, each
   verified on the build host and CI-checked by full SHA before the next. R0-1 + R0-2 are one
   opus agent (mutant/fixture work); R0-3 you do yourself and validate against the repo's own
   CI history. **The pipeline is not compiled until R0-3's fixed watcher exists, because the
   pipeline depends on it.**
3. **COMPILE** — per the plan's Pipeline Notes, which are binding. **There is no spike phase
   and there are no open forks**: the spike ran (report:
   `reports/plan-11a-spike-report.md`), and every FORK block in the plan carries its
   resolution in place. EXECUTE-METHOD §3's sweep must find **zero `SPIKE-SLOT` markers** in
   the plan — one remaining is a defect in the plan, halt and report it.
4. **RUN** — six tasks, **six strictly sequential waves** W1[T1] → W2[T2] → W3[T3] → W4[T4] →
   W5[T5] → W6[T6]. No parallel waves anywhere (§2.62 stays closed; every wave after W1 runs
   drills against shared host state).
5. **VERIFY & CLOSE** — independent verification, the drill transcripts, the gate report, the
   ledger, the roadmap flip. **Your job ends there. Do NOT write Plan 11c, Plan 09, or the
   relay plan.**

## 1. Read first, in this order

| # | file | what to take |
|---|---|---|
| 1 | `docs/superpowers/AGENT-RULES.md` | the binding contract, in full. **Rules 3 and 7 were amended for THIS plan** (2026-08-22: `/opt/hmis-prod`; the `hmis-prod` compose project) — read both before any container or path decision |
| 2 | `docs/superpowers/EXECUTE-METHOD.md` | v2 in full; §3's sweep runs before a single brief is written |
| 3 | `docs/superpowers/plans/2026-08-22-phase1-11a-deployment.md` | **the plan, whole.** Rulings + D1–D15 are owner-approved design law; Phase 0, Global Constraints, File Structure, Assertion Book, commit-messages table, Pipeline Notes and Execute-prerequisites are the compile contract |
| 4 | `docs/superpowers/plans/reports/plan-11a-spike-report.md` | what was measured vs what is still owed (its "claims from reading, labelled" section especially — §2.60) |
| 5 | `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` | §2.46–§2.69 are all live for this pipeline; §2.54 (plan Files lists vs script `files` arrays) and §2.65 (the census files) are the two that have actually halted deliverables |
| 6 | `docs/superpowers/plans/reports/plan-10-gate-report.md` | the last run's honest shape: the two MAJORs Phase 0 clears, §3's CI states, §8's budget lesson |
| 7 | the pipeline template — **stat it before you grep it (§2.51)**: `~/.claude/routing.parked/skills/execute/SKILL.md` unless routing has been re-enabled, in which case `~/.claude/skills/execute/SKILL.md`. Verify in the TEXT that `mechanicalPrompt` carries the rules pointer and the pre-flight covers every spawned agent (§2.32) |

## 2. Ground truth — verify it, do not trust it

- **HEAD at handoff: the commit that carries this prompt** (one commit with the finalized plan
  and the roadmap flip, on top of `ca14f46`). Local `C:\Users\ankit\hmis`, build host
  `root@62.238.106.231:/opt/hmis`, and `origin/main` were in sync at handoff. **Re-verify all
  three; `git pull --rebase` anything stale.** SSH to the host is intermittently flaky — retry;
  a 255 is transport, not a verdict.
- **Execute-prerequisites (plan §, owner actions) — CHECK, do not assume:**
  (1) nginx residue gone and **80/443 free** (`ss -tlnp`) — discharged 2026-08-22 (nginx
  stopped+disabled), **T3's bring-up halts if it has returned**; (2) the two orphan shells
  (`3501080`/`3502071`) — killed 2026-08-22; note whatever a fresh rule-20 probe shows; (3)
  **`hmis.crkmch.com`** resolving **unproxied** to `62.238.106.231` — verified 2026-08-22; T3's
  Caddyfile uses this name, and a Cloudflare-proxied flip would break auto-HTTPS; (4) **the
  verified R2 credentials at `/opt/hmis-prod/.env.r2`** (chmod 600; a signed bucket list
  succeeded 2026-08-22) — **T4 HALTS if they are absent or no longer valid**; the plan forbids
  shipping an untested remote leg.
- Baseline (2026-08-22, gate report, exit VALUE from a file): core **132 / 908** · web
  **31 / 152** · contracts **3 / 7**. **Re-measure per-workspace immediately before compiling**
  and paste the measurement, never these numbers, into the briefs.
- **Next migration: `0016`** (latest `0015_previous_shiver_man.sql`). T2 is the only migration;
  its rollback statement is in the task body BEFORE the generator runs, and the recreate's
  abort path is STOP-AND-REPORT (AGENT-RULES §6), never cleanup.
- **The repo is PUBLIC.** A CI `failure` lasting seconds is the billing block (§2.59), not
  code. `ci-watch.sh` is trustworthy only AFTER your own R0-3 lands — until then check by full
  SHA yourself.
- **The dev database (`hmis-db-1`, `hmis_hmis_pgdata`) and — once created — every `hmis-prod`
  container and volume are untouchable outside brief-named actions** (rule 7). A blanket prune
  is forbidden outright, always.

## 3. Phase 2 — compile

The plan's Pipeline Notes are the contract. The items history says get skipped, plus this
plan's own:

- **§3's sweep first**: `test -e` every File Structure row (the plan's paths were verified at
  writing; the tree may have moved — re-verify, §2.46) · forward references (§2.47) · **zero
  `SPIKE-SLOT` markers** (§2.48's mechanical form here) · vacuous assertions (§2.49) · script
  `files` arrays ≡ plan File Structure, both directions (§2.54) · a commit message per task
  (the plan's table) · **§2.65 explicitly: the census files (`scheduler.test.ts`,
  `test/worker-runtime.e2e.test.ts`) and `jobs.ts` are MULTI-OWNER SEQUENTIAL (R0-2 → T2 →
  T5) — every brief that touches them carries the carried-forward note, and the script's
  `files` arrays list them for every owning task.**
- **The frozen block is generated from the Files lists** (§2.25); any mid-run amendment lands
  in the plan AND the script's arrays in one commit (§2.54).
- `docker-compose.prod.yml` is TWO-OWNER SEQUENTIAL (T3 → T4): T4's brief carries the
  carried-forward note; a T4 brief whose frozen block forbids the compose file is a compile
  defect.
- **Drill acceptance is transcript-shaped** (GC12): T1 ①②, T2 ③, T3 ④⑧, T4 ⑤, T6 ⑦ all name
  transcripts the gate report must carry. A brief that reduces a drill to "the script exits 0"
  is a compile defect (rules 16–17 in drill clothing).
- Tiers exactly as Pipeline Notes: T1–T5 opus coder + opus gate; T6 sonnet + mechanical check.
- Briefs point at AGENT-RULES and the plan, never paste; restricted tool set; no MCP roster.

## 4. Phase 3 — run

Workflow tool, six sequential waves, wave-stall break on. After every task: the mechanical
check (detached `pnpm verify`, exit VALUE from a file · `git show --stat` vs Files list ·
frozen-path grep · CI by full SHA · server tree clean — including **no stray container or
volume**: `docker ps -a` + `docker volume ls` read and compared against rule 7's roster).

A surviving required-DIED mutant follows AGENT-RULES §3's two branches — never silently fixed,
never silently accepted. V1 and V8 are pre-declared **P** rows: "both survive on the stated
input" routes to the task adjusting the input and recording it in the Book, not to accepting
the mutant.

**Halt to the owner ONLY if a finding would:** add a second migration or ANY dependency
(`pnpm-lock.yaml` diff = halt) · touch `dispatcher.ts` beyond the floor predicate + lookup
(GC4 — window/claim/cursor/backoff are byte-frozen) · flip `RETENTION_ENABLED`'s default or
weaken the hold check (GC5) or the `queued`/`sending` immunity (GC6) · put any secret in git
(GC2) · require a `.github/workflows` edit (stop and report — the deploy key cannot push it) ·
stop/remove/prune anything on rule 7's protected roster · write anywhere but `/opt/hmis` and
brief-named `/opt/hmis-prod` paths (rule 3) · or leave an applied-then-abandoned migration
(§6: stop and report, never clean up). Everything else is delegated to you.

## 5. Phase 4 — verify & close

1. Independent main-session verification over the whole range: detached `pnpm verify` (exit
   value from file) · per-commit `--stat` vs Files lists · frozen-path audit · CI by full SHA
   per commit (watch R0-3's watcher, but confirm its verdicts yourself at least once) · server
   tree clean · **container/volume roster clean**.
2. **The coexistence drill re-run by YOU** (flag ⑧): `hmis-prod` fully up via `deploy.sh`,
   `/health` through Caddy over HTTPS, a WS frame through Caddy, dev `pnpm verify` green
   beside it — transcripts in the gate report. This is ruling 2's acceptance and nobody else
   may certify it.
3. Commit the gate report to `docs/superpowers/plans/reports/plan-11a-gate-report.md`: per-task
   shipped state, every Book row's verdict with expected-vs-received, every drill transcript
   (build/boot, pruning EXPLAIN, restore timings + repo size, seeding), CI SHAs, cost actuals
   vs target, honest residuals, a Lessons section.
4. Append the Lessons to `EXECUTION-LESSONS.md` the same session.
5. Roadmap: Plan 11a flips to SHIPPED with the gate-report pointer; 11c's entry notes it is
   now unblocked. **Then stop.** Plans 09, 11c, and the relay belong to a session that reads
   your gate report cold.

## 6. Hard constraints

- AGENT-RULES.md binds you and every agent you spawn; where this prompt and that file disagree
  about process, that file wins. The plan is owner-approved design law; you re-litigate
  nothing in the rulings or D1–D15.
- **Budget: ≤ 2.4M subagent tokens for the pipeline** (12 required-DIED mutants; the §2.68
  arithmetic is the plan's Pipeline Notes). Phase 0 sits outside it — expect roughly 150–250k
  more for the R0-1/R0-2 agent. Report actuals against the target either way, and if your
  compiled Book's mutant count differs from 12, re-derive the target BEFORE the run and say so
  in the gate report.
- Nothing lands on `main` except: Phase 0's three commits, the pipeline's six task commits
  (subjects exactly from the plan's table), the gate report, ledger/roadmap updates, and any
  §2.24-disciplined amendment (visible commit naming the contradiction, full-document grep,
  script arrays updated in the same commit).
- The owner is not watching in real time. Proceed without asking except at §4's halt list and
  the execute-prerequisite gates (§2) — a missing prerequisite is a REPORT to the owner, not a
  workaround.
- **This plan is the one that makes the hospital's data survivable.** The restore drill (⑤)
  and the held-month refusal (V5/⑥) are the rows where a polite pass is the worst outcome:
  a backup nobody restored is a belief, and a dropped held month is a legal record gone. Weight
  your skepticism accordingly.
