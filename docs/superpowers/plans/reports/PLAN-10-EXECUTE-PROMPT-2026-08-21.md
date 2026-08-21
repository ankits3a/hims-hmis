# Prompt — execute Plan 10 (compile → run → verify), no spike, no forks

> **For a fresh session.** The plan is OWNER-APPROVED (2026-08-21, in-conversation, after a
> section-by-section brainstorm review; this prompt is the record). You have full authority
> through all four phases below, ending at the committed gate report. Written 2026-08-21 at
> `ecbf47b` by the session that wrote the plan — which is exactly why it must not compile it:
> the writer is the worst possible judge of whether its Files lists resolve, three times paid.

---

## 0. What you are doing — four phases, strictly in order

1. **VERIFY GROUND TRUTH** — §2 below, before reading anything else into your plans.
2. **COMPILE** — build the pipeline per the plan's own Pipeline Notes, which are binding.
   **There is no spike phase and there are no forks**: the owner ruled no-spike (the plan's
   rulings block states the reasoning — every mechanism reuses a shipped, measured pattern),
   and D1–D14 are all decided. The one open prediction (Assertion Book N5, quiet-hours
   boundary inputs) is the OWNING TASK's to confirm by building the mutant — §7.4 discipline,
   task-level, never a session-level fork and never an owner halt.
3. **RUN** — the six-task pipeline, five sequential waves (W1 [T1] → W2 [T2, T3] → W3 [T4] →
   W4 [T5] → W5 [T6]), target ≤ 1.2M subagent tokens.
4. **VERIFY & CLOSE** — independent main-session verification, the flag-④ demonstration, the
   gate report, the ledger, the roadmap status flip. **Your job ends there. Do NOT write the
   relay plan, Plan 10.5, or Plan 11.**

## 1. Read first, in this order

| # | file | what to take |
|---|---|---|
| 1 | `docs/superpowers/AGENT-RULES.md` | the binding contract, in full. Pointed at, never restated — including by you |
| 2 | `docs/superpowers/EXECUTE-METHOD.md` | v2 in full — **§3's compile-time sweep is new since the last pipeline was compiled and it exists because of that compile.** Run it BEFORE writing a single brief |
| 3 | `docs/superpowers/plans/2026-08-21-phase1-10-notifications.md` | **the plan, whole.** D1–D14 are owner-approved design law; the Global Constraints, File Structure, Assertion Book, commit-messages table and Pipeline Notes are the compile contract |
| 4 | `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` | §2.46–§2.61 are the entries earned by 08.5's compile and run — every one is live for this pipeline. §2.53 especially: **an amendment that lands in the plan's Files list but not the pipeline script's `files` array produces a frozen block that forbids what the plan requires** (that was B2's root cause) |
| 5 | `docs/superpowers/plans/reports/plan-08.5-gate-report.md` | §9 + the ADDENDUM — how the last run failed and was remediated; the three CI states; what the booked residuals are (T5 closes booked item 1 — read what it is before compiling T5's brief) |
| 6 | `~/.claude/skills/execute/SKILL.md` | the pipeline template. Per §2.7, verify in the template TEXT that the §2.32 fixes (rules pointer in `mechanicalPrompt`, pre-flight over every spawned agent) are in it — a ledger entry describing a fix is not the fix |

## 2. Ground truth — verify it, do not trust it

- HEAD when written: **`ecbf47b`** on `main`; local `C:\Users\ankit\hmis`, build host
  `root@62.238.106.231:/opt/hmis`, and `origin/main` synced. Re-verify all three;
  `git pull --rebase` anything stale.
- **CI GREEN at `c5316f9`** (run 32496898177, a real 415-second run). `ecbf47b` and `2de3c2e`
  are docs-only commits after it — confirm their runs by full SHA from the owner's machine
  (`gh` on the build host is deliberately unauthenticated). **Start
  `bash docs/superpowers/pipelines/ci-watch.sh &` before the first task commit and leave it
  running** — it is the fix for the hole that let six commits ship CI-red, and it
  distinguishes GREEN / RED / DID-NOT-RUN.
- **The repo is PUBLIC** (for Actions minutes) and the owner intends to flip it private. If CI
  starts reporting `failure` on runs that lasted **seconds**, that is the billing/spending
  block returning (§2.59), not code. Say so; do not debug the diff.
- **Next migration: `0015`** (`apps/core/drizzle/`, latest `0014_true_dark_beast.sql`). T1 is
  the only migration; its rollback is stated in the plan BEFORE the generator runs (§6).
- Baseline (2026-08-21, build host, detached, exit VALUE 0 from a file): core **126 suites /
  811 tests** · web **31 / 147** · contracts **3 / 7**. **Re-measure per-workspace immediately
  before compiling** and paste the measurement, not these numbers, into the briefs
  (§2.9/§2.21). `pgrep -af jest` before anything that measures (rule 20).
- **The IST dated bomb is DEAD** (08.5 T6 pinned the clock). No push window to avoid.
- `pg-boss` is not a dependency and must not become one. No new dependency of any kind is in
  this plan's File Structure — a `pnpm-lock.yaml` diff in any task is a halt.

## 3. Phase 2 — compile

The plan's **Pipeline Notes are the compile contract** — follow them item by item (waves,
models, tiers, budget, the restricted tool set, briefs point at AGENT-RULES + the plan and
never paste). The ones history says get skipped, plus the ones this plan adds:

- **EXECUTE-METHOD §3's compile-time sweep runs first** — including its own `test -e` pass
  over the File Structure, independent of the plan's self-review item 1. The plan's paths were
  swept at `ecbf47b`; the tree may have moved. Note: `worker-runtime.e2e.test.ts` is at
  `apps/core/test/`, NOT `src/kernel/worker/` — the plan's own sweep caught its author filing
  it wrong, so treat every path as unverified until YOUR sweep says otherwise.
- **The frozen-path block is GENERATED from the tasks' Files lists** (§2.25), and any
  amendment during the run lands in the plan AND the pipeline script's `files` array in the
  same commit (§2.53 — B2 shipped because these diverged).
- **Forward-reference check (§2.47):** the plan's File Structure section carries its own audit
  paragraph (T4 owns `enqueue.ts` and `jobs.ts`; T5 supplies the consumer through the
  `consumers` map parameter and touches `jobs.ts` not at all). Verify the briefs preserve
  exactly that ownership — a brief that tells T5 to edit `jobs.ts` is a compile defect.
- **Two-leg tests where the plan says so:** T2's N2 (synthetic promotional template + the
  honest zero-promotional pin) and T5's N12 (whole-pairs equality + boot-error leg) are the
  §2.49 discipline; a brief that ships only the pin is a task failure, stated in the brief.
- The findings-inbox (§2.39): gates append later-task findings to
  `/opt/hmis/docs/superpowers/plans/reports/plan-10-findings-inbox.md`; every coder's step 0
  reads it. **§2.60's caution rides with it: a finding routed forward is a claim, not a fact —
  the inbox propagated a false premise last run.**
- The MIRROR block in every brief is rendered from AGENT-RULES rule 22 or reduced to a pointer
  (§2.40). Pre-flight trio with negative controls observed to fail (§2.15/§2.18/§2.22); every
  cross-reference into the plan must resolve (§2.34).
- Commit messages: the plan's table is exact, one subject per task (AGENT-RULES §5 step 1
  resolves there — 08.5 lacked the table and the instruction resolved to nothing).
- Tiers and models exactly as Pipeline Notes: T4, T5 opus coder + per-task opus gate; T1 opus
  coder no gate; T2, T3, T6 sonnet + mechanical check — T2's brief carries the §3.14 tier
  override for its mutant work, stated.

## 4. Phase 3 — run

Workflow tool, sequential waves, the wave-stall break stays. After every task: the mechanical
check per EXECUTE-METHOD v2 §4 — detached `pnpm verify` with the exit VALUE read from a file,
`git show --stat` against the task's Files list, frozen-path grep, CI by full SHA from the
owner's machine, clean server tree (no `*.mutant.*`, no `*.prefix.*`, no scratch). A surviving
required-DIED mutant follows AGENT-RULES §3's two branches — never silently fixed, never
silently accepted; **N5 is pre-declared as a §7.4 prediction**, so "both survive on the stated
input" routes to the task adjusting the input and recording the verdict in the Book, not to
accepting the mutant. Infra failures retry the same rung and never promote the tier (§2.1).

**Halt to the owner ONLY if a finding would:** push the task count past six · add a second
migration or any dependency · touch `dispatcher.ts` beyond the three envelope lines the plan's
D5/GC10 permit (the window, claim, cursor and backoff lines are byte-frozen) · overturn D2's
claim-before-send placement · weaken the D-33 deceased hard stop (N1) or the promotional
refusal (N2) · or leave migration debris (AGENT-RULES §6 — stop and report, never clean up by
hand). Everything else is delegated to you.

## 5. Phase 4 — verify & close

1. Independent main-session verification of the whole range: detached `pnpm verify` (exit
   value from a file) · per-commit `git show --stat` vs Files lists · frozen-path audit over
   the range · CI green by full SHA for every commit · server tree clean.
2. **The flag-④ demonstration the gate report owes** (a demonstration, not a test — GC9/10):
   dev compose, seed three outbox rows (one fresh, one whose template expiry has passed, one
   for a patient marked deceased), `start:worker`, transcript showing exactly one console
   send, one `expired`, one `suppressed` within two pump intervals. Include the transcript.
3. Commit the gate report to `docs/superpowers/plans/reports/plan-10-gate-report.md` — what
   shipped per task, every Assertion Book verdict with expected-vs-received (N5's confirmed
   input explicitly), the demonstration, CI SHAs, cost actuals vs the 1.2M target, and a
   Lessons section.
4. Append the Lessons to `EXECUTION-LESSONS.md` the same session.
5. Update the roadmap: Plan 10's entry flips to SHIPPED with the gate-report pointer; note
   that the relay half remains split out awaiting the E-1/topology decision. **Then stop.**
   The relay plan and Plan 11 belong to a session that reads your gate report cold.

## 6. Hard constraints

- AGENT-RULES.md binds you and every agent you spawn; where this prompt and that file disagree
  about process, that file wins. The plan is owner-approved design law: you compile and
  execute it; you re-litigate nothing in D1–D14.
- Budget: ≤ 1.2M subagent tokens (no spike, no forks — smaller than 08.5's 1.5M target;
  report actuals).
- Nothing lands on `main` except: the pipeline's six task commits (subjects from the plan's
  table), the gate report, the ledger/roadmap updates, and any §2.24-disciplined plan
  amendment (visible commit naming the contradiction, full-document grep, script `files`
  array updated in the same commit).
- The owner is not watching in real time. Proceed without asking except at §4's halt list.
- **This plan sends messages to nobody** — every adapter is a console sink — but its tests
  and demonstration are the machinery that will one day message a real patient's family.
  Weight your skepticism accordingly: the deceased-suppression mutant (N1) is the row where a
  polite pass is the worst outcome on this surface.
