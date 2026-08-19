# Method review — why the pipeline got 3× more expensive, and what to change

**Owner call, 2026-08-19:** stop Plan 08 execution after pipeline A, analyse where the tokens
went across Plans 02–08, redesign the method, then resume with B and C.

This is the analysis and the proposed method. Nothing here changes how the code works; it
changes how we produce it.

---

## 1. The numbers

Per-plan, from each plan's own gate report:

| plan | tasks | agents | subagent tokens | tokens/task | tokens/agent |
|---|---|---|---|---|---|
| 02 | 12 | 45 | 2.77M | 231k | 62k |
| 03 | 10 | 24 | 1.65M | 165k | 69k |
| 04 | 8 | 17 | 1.28M | 160k | **75k** |
| 05 | 16 | 40 | 3.98M | 249k | 100k |
| 06 (+6.1, 6.2) | — | 56+ | 5.75M | — | ~103k |
| 07 | 16 | 51 | 7.59M | 474k | 149k |
| 08 pipeline A | 6 | 12 | 2.45M | 408k | **204k** |

Plus, not in the table: Plan 06's two post-ship audits (613k + 493k), Plan 08's failed first
run (934k), and ~365–460k of scouts per plan.

**Agents per task barely moved** — 2.1 in Plan 04, 3.0 in Plan 07, 2.0 in Plan 08. The cost
per *agent* is what tripled: **75k → 204k.** We are not running more agents. Each agent is
doing about three times as much work.

## 2. Where the money goes inside one pipeline

Measured from Plan 08 pipeline A's own transcripts (12 agents, 2.45M, 920 tool calls):

| | share | tool calls |
|---|---|---|
| coders | **67%** (~1.65M) | 647 (108 each) |
| gates | **33%** (~0.80M) | 273 (45 each) |

The briefs — the thing that *looks* expensive at 26–38k characters each — are about **4.6%**
of the run. Shrinking them is not the lever. *(I said earlier that the gate makes us pay for
every task twice; that was wrong. It is a third, not a half.)*

The lever is coder iteration: 108 tool calls per coder, dominated by running test suites,
reading their output, and running them again.

## 3. Two findings that matter

### 3.1 The verification ratchet

Every lesson we have ever learned was added to every future brief, and nothing was ever
removed. Between Plan 04 (75k/agent) and Plan 08 (204k/agent) we added, cumulatively:

- tripwires: 9 → **21**, pasted verbatim at the top of every brief
- EXECUTION-LESSONS: → **500+ lines**, cited throughout
- **mandatory mutation testing** (tripwire 21, from Plan 06.1's §3.24)
- **Assertion Books** — Plan 06.1 had 27 rows, Plan 08 has **47**
- fail-first staging rules, isolation proofs, detached-run-with-exit-file discipline,
  measured race budgets, negative controls

Each one was individually justified by a real defect. Together they are why an agent now
spends 204k where it used to spend 75k. **No mechanism in this process ever removes a rule.**

### 3.2 The gate has stopped rejecting

| plan | gate outcome |
|---|---|
| 02 | 12 retry cycles — only 2 were genuine code defects |
| 05 | 13 of 16 tasks passed first attempt |
| 07 | **16/16 first pass** |
| 08 pipeline A | **6/6 first rung** |

**Twenty-two consecutive tasks with zero gate rejections**, at 33% of pipeline cost.

But the gate is not worthless — it produced **54 findings** this run, including the §3.39
lock-mode discovery, the confirmed K4 correction, and two plan defects. It has quietly
changed jobs: it is no longer a *rejector*, it is a *discoverer*. We are paying rejector
prices for discovery work.

Those two jobs have very different costs. Re-running every suite and re-checking every
criterion is the expensive half, and it is the half with no yield.

## 4. What is actually wrong

1. **The plan is unverified prose that costs a pipeline to test.** Plan 08's Step 5 contained
   one false sentence about Postgres `TRUNCATE`. Nothing could catch it but execution, and
   execution cost 934k. A 700-line document of hand-derived arithmetic and database claims,
   written and reviewed by the same author, is a fragile thing to spend millions executing.
2. **Rigour is uniform where risk is not.** The same mutation discipline was applied to
   `fyOf()` — a date helper — as to the concurrent-allocation race on a money ledger.
3. **The gate is priced as a rejector and used as a discoverer.**
4. **Counting ceremony.** Every task enumerates its tests, predicts a total, and reconciles it.
   Four gates this run spent findings reconciling stale counts. The count proves nothing about
   correctness — it exists to catch padded or deleted tests, which one grep would also catch.
5. **The ledger only grows.** Four separate entries (§3.21, §3.25, §3.28, §3.39) say one thing
   about lock-observation tests, and all four ride in every brief forever.

## 5. The proposed method

### 5.1 Spike before planning  *(biggest single win)*

Before writing a plan, spend **~50k** having one agent build the riskiest 10% for real on a
throwaway branch: the schema, one migration, the trickiest query, the one framework
interaction nobody is sure about. Then throw it away and write the plan against *measured*
behaviour.

Plan 08's TRUNCATE defect would have cost 50k instead of 934k. Every "verify-by-execution
flag" in a plan is an admission that we wrote something we could not check — the spike checks
the top few before they become 700 lines of dependent prose.

### 5.2 Risk tiers, declared in the plan

Each task is labelled by the plan author:

- **CRITICAL** — money arithmetic, concurrency and locking, immutability, approvals and
  permissions, anything that can silently produce a wrong number. Full current discipline:
  mutants, measured races, negative controls, opus gate.
- **ROUTINE** — config loaders, event catalogs, seed scripts, doc tasks, wiring, screens with
  no money maths. Tests required, **mutants not required**, mechanical verification only.

Of Plan 08's 16 tasks, roughly 6 are CRITICAL (T1, T2, T5, T6, T7, T8) and 10 are ROUTINE.

### 5.3 Split the gate into the two jobs it is really doing

- **Mechanical check, every task, ~5k tokens:** `pnpm verify` detached with the exit value read
  from a file, `git show --stat` against the Files list, frozen-path grep, CI by SHA, clean
  tree. This is what actually catches "did it really pass", and it does not need an opus agent
  — the main session already does it, and does it better because it is independent.
- **One discovery reviewer per PIPELINE, not per task**, opus, reading all the commits
  together and hunting for exactly the §3.39-class findings. Cross-task findings are the ones
  that matter and the ones a per-task gate structurally cannot see.
- **Keep a real per-task gate only on CRITICAL tasks.**

Estimated: 0.80M → ~0.25M per pipeline.

### 5.4 Cut coder iteration — the 67%

- Run the **narrow suite** while iterating; the full suite **once**, at the end.
- **Drop per-task test-count targets.** Replace with: the workspace total must not decrease,
  and the diff must not delete a test. One grep, no reconciliation.
- **Fail-first only on CRITICAL tasks.** On ROUTINE work the red run proves TDD order and
  nothing downstream consumes it.

### 5.5 Stop inlining the boilerplate

Move tripwires, mutant discipline, frozen paths, evidence rules into
`docs/superpowers/AGENT-RULES.md` in the repo. Briefs point at it the way they already point
at the plan. Saves little in tokens; saves a lot in drift, because there stops being two
copies of every rule.

### 5.6 Prune the ledger, on a rule

Retire an entry when the mechanism that made it necessary is gone **or when it has been
merged into a stronger general entry.** Immediate merges: §3.21 + §3.25 + §3.28 + §3.39 → one
entry on lock-observation tests. §3.14 + §3.14b + §3.14c + §3.33 → one entry on fixtures that
cannot separate. Target: 39 §3 entries → ~20.

## 6. What we do NOT change

The protections that have actually caught things stay, unconditionally:

- **Tripwire 21** — build the mutant, never predict it. Plan 06.1's audit found the Assertion
  Book wrong in *both* directions; only executed mutants found it.
- **Tripwire 19** — prove test isolation from output. Five "clean" race runs were five
  full-suite runs.
- **Tripwires 16/17/18** — never trust a pipeline's or wrapper's exit status; detached runs
  with exit files.
- **Independent main-session verification** after every pipeline.
- **Agents reporting plan defects instead of working around them.** Both settlement.ts
  disclosures this run were exactly right, and cost nothing.
- **The security tripwires (14, 15)** — non-negotiable regardless of cost.

## 7. Expected effect

| | now | proposed |
|---|---|---|
| gate/review | 0.80M | ~0.25M |
| coder iteration | 1.65M | ~1.20M |
| **per 6-task pipeline** | **2.45M** | **~1.45M** |

Roughly **40% off**, with the CRITICAL-path verification untouched. Plan 08's remaining ten
tasks land near **2.6M** instead of ~4.4M.

The honest risk: a task mis-labelled ROUTINE ships a weaker test. The mitigation is that the
label is set by the plan author before any code exists, and the per-pipeline discovery
reviewer reads every commit regardless of label.
