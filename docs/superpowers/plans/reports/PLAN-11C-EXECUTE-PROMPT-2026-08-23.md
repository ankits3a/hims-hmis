# Prompt — execute Plan 11c (spike → Phase 0 → compile → run → verify)

> **For a fresh session.** The plan is OWNER-APPROVED (2026-08-23, in-conversation — the three
> rulings are in the plan's rulings block; this prompt is the record of the handoff). You have
> full authority through all six phases below, ending at the committed gate report. Written
> 2026-08-23 by the session that brainstormed with the owner and wrote the plan — which is
> exactly why it must not compile it: the writer is the worst judge of whether its own Files
> lists resolve, three times paid.
>
> **UNLIKE 11a, THE SPIKE HAS NOT RUN.** This plan hands you one open fork (D12, the L14 census
> shape) and one environment question (SMTP egress). **Phase 1 below runs the spike and writes
> its resolutions into the plan document IN PLACE before anything compiles.** A compile with
> D12 still open is a defect in your process, not the plan's.

---

## 0. What you are doing — six phases, strictly in order

1. **VERIFY GROUND TRUTH** — §2 below, before anything else.
2. **SPIKE** — one agent, per
   [`PLAN-11C-SPIKE-BRIEF-2026-08-23.md`](PLAN-11C-SPIKE-BRIEF-2026-08-23.md): questions A
   (census shape, ≥30 isolated runs), B (587/465 egress), C (alertmanager smoke). Commit its
   report as `plan-11c-spike-report.md`, then **edit the plan's D12 (and T6's SMTP shape if B
   demands) in place, marking superseded text dead where it stands (§2.48), in one visible
   docs commit.** If A's measurement refutes the stepwise shape, re-author R0-2 against the
   measurement (the plan names the fallback direction) — that is an amendment, not a
   re-litigation.
3. **PHASE 0** — two commits, in order, each verified on the build host and CI-checked by full
   SHA before the next, one push each (§2.62). One opus agent for both (R0-1 is a one-liner
   plus a header-absent assertion; R0-2 ships the spike's measured census shape).
4. **COMPILE** — per the plan's Pipeline Notes, which are binding. EXECUTE-METHOD §3's sweep
   first, plus the plan's own compile-time additions (Pipeline Notes bullet 5 — the
   post-Phase-0 literal re-grep, the `:317` ownership check, the e2e fixture confirmation, the
   alerts-parity second-file check).
5. **RUN** — six tasks, **six strictly sequential waves** W1[T1] → … → W6[T6]. Wave-stall break
   on. T6 mutates production and is the ONLY task authorized to (its brief carries the
   authorization in as many words — deploy.sh run, api/worker recreated onto the plan's HEAD,
   the three config-at-startup services restarted; nothing touches the `hmis-prod` db service
   or the dev stack).
6. **VERIFY & CLOSE** — independent verification, the drill transcripts, the gate report, the
   ledger, the roadmap updates (§5). **Your job ends there. Do NOT write Plan 09, 12a, or the
   relay plan.**

## 1. Read first, in this order

| # | file | what to take |
|---|---|---|
| 1 | `docs/superpowers/AGENT-RULES.md` | the binding contract, in full — rules 3 and 7 as amended 2026-08-22 govern every container and path decision; rule 21 governs every mutant claim |
| 2 | `docs/superpowers/EXECUTE-METHOD.md` | v2 in full; §3's sweep before a single brief exists |
| 3 | `docs/superpowers/plans/2026-08-23-phase1-11c-operating-modes-downtime-kit.md` | **the plan, whole.** Rulings + D1-D13 are owner-approved design law; Phase 0, Global Constraints, File Structure, Assertion Book, commit-message table, Pipeline Notes, Execute-prerequisites are the compile contract |
| 4 | `docs/superpowers/plans/reports/PLAN-11C-SPIKE-BRIEF-2026-08-23.md` | what your spike must measure and how its resolutions land |
| 5 | `docs/superpowers/plans/reports/plan-11a-gate-report.md` **including its ADDENDUM** | the live production shape you are building beside; §3a/§7.9 is the flake R0-2 kills; §7.8 is why the mechanical check is not cut |
| 6 | `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` | §2.46-§2.77 all live; §2.54, §2.65, §2.72, §2.73 and §2.77 are the five this plan was authored against |
| 7 | the pipeline template — **stat it before you grep it (§2.51)**: `~/.claude/routing.parked/skills/execute/SKILL.md` unless routing is re-enabled, then `~/.claude/skills/execute/SKILL.md` |

## 2. Ground truth — verify it, do not trust it

- **HEAD at handoff: the commit carrying this prompt, the plan, and the spike brief** (one
  docs commit on top of `8ec862f`). Local `C:\Users\ankit\hmis`, build host
  `root@62.238.106.231:/opt/hmis`, and `origin/main` in sync at handoff — **re-verify all
  three; `git pull --rebase` anything stale.** A 255 on SSH is transport, not a verdict.
- **Production is LIVE beside you**: `hmis-prod`, eight services, `https://hmis.crkmch.com`,
  WAL archiving to R2, cron backups + weekly restore drill. You do not stop, restart, or
  remove any of it outside T6's brief-named deploy. The dev stack (`hmis-db-1`,
  `hmis_hmis_pgdata`) is equally untouchable. Blanket prunes are forbidden outright.
- **Execute-prerequisites (plan section) — CHECK, do not assume:** (1)
  **`/opt/hmis-prod/.env.smtp`** exists, chmod 600, six keys non-empty — **required before W6;
  T6's deploy dies without it by design. If it is missing when you reach W6, HALT and report
  to the owner; do not fabricate a credential and do not stub the derivation.** (2) The spike
  ran and D12 is resolved in the plan (your own Phase 1). (3) Nothing else — no DNS, no R2
  work, no new hostname.
- Baseline (2026-08-23 addendum, exit VALUE from a file): core **138 / 961** · web **31 / 152**
  · contracts **3 / 7**. **Re-measure per-workspace immediately before compiling**; paste the
  measurement, never these numbers, into the briefs (§2.6: sequential briefs state the
  baseline as "the previous task's commit").
- **Next migration: `0017`** (latest `0016_bright_thor.sql`). T1 is the only migration; its
  rollback statement is in the task body before the generator runs; an applied-then-abandoned
  migration is STOP-AND-REPORT (AGENT-RULES §6), never cleanup.
- **The repo is PUBLIC.** A CI `failure` lasting seconds is billing (§2.59), not code — and
  nothing in any commit may carry an owner email address, an SMTP host, or any credential
  shape beyond placeholders (plan GC2).
- **After R0-2 lands, the L14 census is expected FIXED: a red on it is a REGRESSION SIGNAL,
  not a flake to re-run past** (Pipeline Notes; the §2.76 control discipline in reverse —
  investigate before re-running).

## 3. Compile — the items history says get skipped, plus this plan's own

- **§3's sweep first**: `test -e` every File Structure row (verified at writing against
  `8ec862f`; the tree has since gained your spike/Phase-0 commits — re-verify, §2.46) ·
  forward references (§2.47) · fork-loser grep (§2.48 — after your Phase 1, the plan must
  contain ZERO open fork language in D12; the losing census shape and any losing SMTP port
  appear only as marked-dead history) · vacuous assertions (§2.49) · script `files` arrays ≡
  plan File Structure, both directions (§2.54) · a commit message per task (the plan's table) ·
  CI per commit by full SHA with `ci-watch.sh` running.
- **§2.65/§2.73 explicitly, re-run AFTER Phase 0:** the `JobIntervals` literal census
  (expected: 3, at your post-Phase-0 SHA — state count WITH the SHA) and the multi-owner
  sequential files: `kernel/ops/events.ts` (T1→T2→T3→T4), `ops.controller.ts` (T2→T3→T4),
  `worker-runtime.e2e.test.ts` (T1 `:317` → T3 census), `scheduler.test.ts` (R0-2 → T3).
  Every owning brief ENUMERATES its additions; **no brief may say "change nothing else"**
  (§2.72 — that sentence cost 11a its monitoring stack).
- **Drill acceptance is transcript-shaped** (plan GC12): flags ①-⑦ name what the gate report
  must carry. A brief that reduces a drill to "the script exits 0" is a compile defect
  (rules 16-17 in drill clothing).
- Tiers exactly as Pipeline Notes: T1-T4, T6 opus coder + per-task opus gate; T5 sonnet +
  mechanical check; one discovery reviewer for the pipeline.
- Briefs point at AGENT-RULES and the plan, never paste (§2.40); restricted tool set; no MCP
  roster.

## 4. Run

Workflow tool, six sequential waves, wave-stall break on. After every task: the mechanical
check (detached `pnpm verify`, exit VALUE from a file · `git show --stat` vs Files list ·
frozen-path grep · CI by full SHA · server tree clean · **container/volume roster read and
compared against rule 7's roster** — after W6 that roster includes alertmanager, and nothing
else new).

A surviving required-DIED mutant follows AGENT-RULES §3's two branches — never silently fixed,
never silently accepted. V5, V8, V12, V13 are pre-declared **P** rows: "the mutant survives on
the stated input" routes to adjusting the input and recording it in the Book, not to accepting
the mutant.

**Halt to the owner ONLY if a finding would:** add a second migration or ANY dependency
(`pnpm-lock.yaml` diff = halt, plan GC1) · touch retention semantics, the dispatcher, the
notify pump/gauntlet, or anything on GC13's frozen list · put any secret or owner address in
git (GC2) · require a `.github/workflows` edit (the deploy key cannot push it — stop and
report) · act on `hmis-prod` outside T6's brief-named deploy, or on the dev stack at all ·
leave an applied-then-abandoned migration. Everything else is delegated to you.

## 5. Verify & close

1. Independent main-session verification over the whole range: detached `pnpm verify` (exit
   value from a file) · per-commit `--stat` vs Files lists · frozen-path audit · CI by full
   SHA per commit · server tree clean · container/volume roster clean.
2. **The production drills re-run or directly observed by YOU** (nobody else may certify
   them): flag ④'s 9/9-services deploy transcript · flag ⑤'s synthetic-alert-to-inbox drill
   (the owner's receipt ack recorded, or the flag booked UNDISCHARGED in so many words) ·
   flag ⑥'s `promtool` output · and a dev-suite-green-beside-prod re-check (the ruling-2
   coexistence acceptance, inherited from 11a — one run, transcript kept).
3. Commit the gate report to `docs/superpowers/plans/reports/plan-11c-gate-report.md`: per-task
   shipped state, every Book row's verdict with expected-vs-received, every drill transcript,
   CI SHAs, cost actuals vs the ≤3.0M target (and the spike's actual vs its ~80k), honest
   residuals, a Lessons section.
4. Append the Lessons to `EXECUTION-LESSONS.md` the same session.
5. **Roadmap maintenance, in the gate-report commit:** 11c flips to SHIPPED with the
   gate-report pointer · **fix the two STALE status lines the plan's self-review names — Plan
   07 (no STATUS; shipped, `reports/plan-07-gate-report.md`) and Plan 08 ("awaiting pipeline
   execution"; shipped 2026-08-21, pipeline notes A/B/C, "Plan 08 ends here")** · note Plan
   09's ruled slot (after 11c; no live memberships in the pilot) and that 12a's mode-gate seam
   now exists. **Then stop.** Plans 09 and 12a belong to a session that reads your gate report
   cold.

## 6. Hard constraints

- AGENT-RULES.md binds you and every agent you spawn; where this prompt and that file disagree
  about process, that file wins. The plan is owner-approved design law; you re-litigate
  nothing in the rulings or D1-D13 (D12's spike resolution is an amendment path the plan
  itself defines, not a re-litigation).
- **Budget: ≤ 3.0M subagent tokens for the pipeline** (16 required-DIED mutants + 1 measured
  race + 3 drills — the §2.68 arithmetic is in the plan's Pipeline Notes). The spike
  (~80-200k) and Phase 0 (~150-250k, one agent) sit outside it. If your compiled Book's
  count differs, re-derive the target BEFORE the run and say so in the gate report.
- Nothing lands on `main` except: the spike-report + plan-amendment docs commit, Phase 0's two
  commits, the six task commits (subjects exactly from the plan's table), the gate report +
  ledger/roadmap commit, and any §2.24-disciplined amendment (visible commit naming the
  contradiction, full-document grep, script arrays updated in the same commit).
- The owner is not watching in real time. Proceed without asking except at §4's halt list and
  the prerequisite gates — a missing prerequisite is a REPORT, not a workaround. The owner
  owes one mid-run action (`.env.smtp` before W6) and one post-run ack (flag ⑤'s inbox
  receipt); sequence your waves so neither surprises them.
- **This plan is the one that decides whether anyone finds out when production breaks at
  03:00, and whether a hospital can keep working when the system cannot.** Flag ⑤ (the alert
  actually arriving) and V13 (serial ranges that cannot collide on paper) are the rows where a
  polite pass is the worst outcome. Weight your skepticism accordingly.
