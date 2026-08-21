# Prompt — execute Plan 08.5 (spike → resolve forks → compile → run → verify)

> **For a fresh session.** The plan is OWNER-APPROVED (2026-08-21, in-conversation; this prompt
> is the record). You have full authority through all five phases below, ending at the committed
> gate report. Written 2026-08-21 at `2f2e265`.

---

## 0. What you are doing — five phases, strictly in order

1. **SPIKE** — dispatch one agent with the committed spike brief (~50k, throwaway branch).
2. **RESOLVE** — consume its report: pick FORK-A and FORK-B, set the look-back constant, confirm
   flag ③'s mechanism; amend the plan only as those forks and findings require.
3. **COMPILE** — build the pipeline per the plan's own Pipeline Notes, which are binding.
4. **RUN** — the six-task pipeline, sequential waves, target ≤ 1.5M subagent tokens.
5. **VERIFY & CLOSE** — independent main-session verification, the gate report, the ledger, the
   roadmap status line. **Your job ends there. Do NOT write Plan 10.**

## 1. Read first, in this order

| # | file | what to take |
|---|---|---|
| 1 | `docs/superpowers/AGENT-RULES.md` | the binding contract, in full. It is pointed at, never restated — including by you |
| 2 | `docs/superpowers/EXECUTE-METHOD.md` | v2 in full: the five phases, tiers, review split |
| 3 | `docs/superpowers/plans/2026-08-21-phase1-08.5-runtime-loop.md` | **the plan, whole.** D1–D12 are decided; the FORKs are yours to resolve from the spike, nothing else is |
| 4 | `docs/superpowers/plans/2026-08-21-phase1-08.5-spike-brief.md` | the spike agent's brief — you hand it over verbatim, you do not rewrite it |
| 5 | `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` | §1–§2 (`sed -n '1,215p'`) and §5 tail (`sed -n '598,610p'`) before compiling. Live items you must ACT on: **§2.32** (mechanicalPrompt carries the rules pointer; pre-flight covers every agent), **§2.34** (resolve cross-refs, audit rendered briefs), **§2.39** (the findings-inbox mechanism), **§2.40** (the MIRROR block residual — see §5 below) |
| 6 | `docs/superpowers/plans/reports/plan-08-pipeline-C-notes.md` | §5 only — how the last run behaved under the Workflow tool |
| 7 | `~/.claude/skills/execute/SKILL.md` | the pipeline template. **Per §2.7, verify in the template text itself** that the §2.32 fixes (rules pointer in `mechanicalPrompt`, pre-flight over all spawned agents) are actually IN it — a ledger entry describing a fix is not the fix. If absent, land them in the template BEFORE compiling |

## 2. Ground truth — verify it, do not trust it

- HEAD when written: **`2f2e265`** on `main`; local `C:\Users\ankit\hmis`, build host
  `root@62.238.106.231:/opt/hmis`, and `origin/main` were all synced and clean. Re-verify all
  three; `git pull --rebase` anything stale.
- CI green at `b6af93f` (run 32452972677) and to be confirmed at `2f2e265` **by full SHA**
  (`git rev-parse`, §2.42 — an empty `gh run list` is "not checked", never "not failing"; `gh`
  runs on the owner's machine, not the host).
- Next migration: `0014`. pg-boss: not a dependency. Pipeline 8C: closed.
- Baselines (2026-08-21): core 119/763 · web 30/144 · contracts 3/7 — **re-measure per-workspace
  on the server immediately before compiling** and paste the measurement, not these numbers,
  into the briefs (§2.9/§2.21).
- `pgrep -af jest` before anything that measures (rule 20).
- **Known clock bomb until T6 lands:** `pnpm verify` and CI are non-deterministic in the last
  ~30 minutes of every IST day (`opd-lifecycle.e2e.test.ts`, ledger §3.41). A red in that window
  is not evidence about the commit under it; never push in it.

## 3. Phase 1 — the spike

Dispatch **one** agent whose instructions are: read `docs/superpowers/AGENT-RULES.md`, then
execute `docs/superpowers/plans/2026-08-21-phase1-08.5-spike-brief.md` on the build host,
exactly as written. Remind it of the final-message protocol (§2.11 — only the final message
reaches you; one complete report, never "see above"). Budget ~50k; it is throwaway-branch work
and nothing merges.

When it returns: transcribe the report verbatim into
`docs/superpowers/plans/reports/plan-08.5-spike-report.md`, commit it, and check the report
against tripwire 21 — any verdict resting on a claim the agent did not execute is not a verdict;
send it back for the measurement rather than accepting the prediction.

## 4. Phase 2 — resolve the forks

Add a **"Spike verdicts (2026-08-2X)"** block directly under the plan's status header recording:
FORK-A pick (WorkerModule vs headless AppModule) · FORK-B pick (loop vs pg-boss — the decision
rule in D2 is verbatim and binding) · the measured look-back constant for D4 · flag ③'s verdict
(the `doNotFake` list that works, or the fallback). Flip the status line to
"READY TO COMPILE (spike report: plan-08.5-spike-report.md)". If FORK-B lands pg-boss, apply the
plan's own stated consequences (T2 → CRITICAL, opus coder + gate; its brief carries the spike's
measured pg-boss facts and the §6 rollback for the pgboss schema).

**Amendment discipline (§2.24):** for every value you change, grep the WHOLE plan for every
other occurrence before committing — the section that owns a value is never the only place it
appears. Fork resolution is not a plan amendment; anything beyond the forks is, and it must be a
visible commit naming the contradiction.

**Halt to the owner only if** a spike finding would: push the task count past six, add a second
consumer, or overturn D4's claim-on-success placement. Everything else is delegated to you.

## 5. Phase 3 — compile

The plan's **Pipeline Notes section is the compile contract** — follow it item by item. The
ones history says get skipped:

- **The MIRROR block** in every brief is RENDERED from AGENT-RULES rule 22 as amended, or
  reduced to a pointer at the rule. Never restated in the compiler's words (§2.40 — the second
  copy is what drifted and produced a false accusation last pipeline).
- Every brief's FIRST instruction is the pointer to AGENT-RULES.md; `mechanicalPrompt` and the
  discovery reviewer carry it too (§2.32).
- Pre-flight trio **with negative controls observed to fail** (§2.15/§2.18/§2.22): module-parse
  probe as `.mjs`, stubbed dry-run asserting each block's marker in the RENDERED briefs,
  `node --check` as smoke only. Every cross-reference into the plan must RESOLVE (§2.34).
- The findings-inbox (§2.39): gates append later-task findings to
  `/opt/hmis/docs/superpowers/plans/reports/plan-08.5-findings-inbox.md`; every coder's step 0
  reads it. The Workflow tool runs waves back-to-back; this file is the only injection point.
- The frozen-path block is GENERATED from the tasks' Files lists (§2.25), never hand-written.
- Tier map and models exactly as the plan's Pipeline Notes state them (as adjusted by FORK-B).
- Fail-first criteria carry the §2.13 named-commit fallback wording; T5 owes no red run and its
  brief says so.

## 6. Phase 4 — run

Run the compiled pipeline (the Workflow tool; sequential waves; the wave-stall break stays).
After every task: the mechanical check per EXECUTE-METHOD v2 §4 — detached `pnpm verify` with
the exit VALUE read from a file, `git show --stat` against the task's Files list, frozen-path
grep, CI by full SHA from the owner's machine, clean server tree. A surviving required-DIED
mutant follows AGENT-RULES §3's two branches — never silently fixed, never silently accepted.
Infra failures retry the same rung and never promote the tier (§2.1). If a wave stalls, stop the
run rather than letting later tasks discover it.

## 7. Phase 5 — verify & close

1. Independent main-session verification of the whole range: detached `pnpm verify` (exit value
   from file) · per-commit `git show --stat` vs Files lists · frozen-path audit over the range ·
   CI green by full SHA for every commit · server tree clean.
2. **The demonstration the gate report owes** (plan Global Constraint 10: it is a demonstration,
   not a test): the worker booted against the dev compose, a five-minute real-clock transcript
   showing the six sweeps firing and six heartbeat rows advancing; plus `/health` reporting
   `degraded` after the worker is stopped and stale.
3. Commit the gate report to `docs/superpowers/plans/reports/plan-08.5-gate-report.md` — what
   shipped per task, every mutant verdict with expected-vs-received, the dispatcher-skip
   reproduction and its fix evidence, the transcript, CI SHAs, and a Lessons section.
4. Append the Lessons to `EXECUTION-LESSONS.md` the same session; record the §2.35 measurement
   (any ambiguous kill?) as that entry requires.
5. Update the roadmap: Plan 08.5's entry gets its STATUS flipped to SHIPPED with the gate-report
   pointer; the "next plan to write" becomes 10. **Then stop.** Writing Plan 10 belongs to a
   session that has read 08.5's gate report cold.

## 8. Hard constraints

- AGENT-RULES.md binds you and every agent you spawn; where this prompt and that file disagree
  about process, that file wins.
- The plan is owner-approved design law. You resolve its FORKs; you do not re-litigate D1–D12.
- Budgets: spike ~50k · pipeline ≤ 1.5M subagent tokens (the plan states the basis; report
  actuals in the gate report).
- Nothing lands on `main` except: the spike report, the fork-verdict amendment, the pipeline's
  own task commits, the gate report, the ledger/roadmap updates.
- The owner is not watching in real time. Proceed without asking except at the three §4 halt
  conditions, a CHAIN HALT per the rules, or migration debris (AGENT-RULES §6 — stop and report,
  never clean up by hand).
