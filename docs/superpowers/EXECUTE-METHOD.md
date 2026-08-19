# Execute method v2 — how a plan becomes shipped code

Adopted 2026-08-19 after the method review
([`plans/reports/METHOD-REVIEW-2026-08-19.md`](plans/reports/METHOD-REVIEW-2026-08-19.md)),
which measured cost per agent tripling from 75k (Plan 04) to 204k (Plan 08) with no
corresponding rise in task complexity.

**What v2 changes:** where agents read and type, how much verification each task gets, and who
does the reviewing. **What v2 does not change:** where evidence comes from. Every test, every
migration, every commit still runs on the build host. No quality bar is lowered.

---

## 0. The five phases

```
  SPIKE  →  PLAN  →  COMPILE  →  RUN  →  VERIFY
  ~50k      main      main       pipeline   main session,
  1 agent   session   session    agents     independent
```

---

## 1. SPIKE — before the plan exists  *(new in v2)*

**Send one agent, ~50k, to build the riskiest 10% for real on a throwaway branch.** Then throw
the code away and write the plan against measured behaviour.

What goes in a spike: the schema and one migration; the trickiest query or lock; any framework
interaction nobody has executed before; every claim you are about to write into the plan as
fact about a database, a generator, or a test harness.

**Why this is the highest-value 50k in the process.** Plan 08's Task 1 Step 5 asserted that
Postgres `TRUNCATE` cares about statement order. It does not. That one sentence made the plan
self-contradictory, and nothing but execution could reveal it — execution cost **934k tokens
and delivered nothing**. A spike would have found it for 50k.

**The rule that generalises:** every "verify-by-execution flag" a plan carries is an admission
that we wrote something we could not check. The spike checks the top three or four before they
become 700 lines of prose that everything downstream depends on.

## 2. PLAN — what the document must now carry

Unchanged: the design decisions, the consumed surfaces transcribed from source, the global
constraints, the file structure, the per-task Files lists, the Assertion Book, the
verify-by-execution flags, the self-review passes.

**Added in v2 — a risk tier on every task:**

- **CRITICAL** — money arithmetic, concurrency and locking, immutability, approvals and
  permissions, anything that can silently produce a wrong number. Gets: mutants, measured
  races, fail-first, an opus coder, and a per-task opus gate.
- **ROUTINE** — config loaders, event catalogs, seed scripts, wiring, docs, screens with no
  money maths. Gets: tests that pass, and the mechanical check. No mutants, no fail-first, no
  per-task gate.

**Removed in v2 — per-task test-count targets.** They cost four gate findings in Plan 08
pipeline A alone, reconciling stale numbers against a corrected ladder, and a count proves
nothing about correctness. Replaced by the rule in AGENT-RULES §4: the workspace total must not
decrease and no test may be deleted.

**Also removed:** the inlined rules block. Briefs now point at
[`AGENT-RULES.md`](AGENT-RULES.md). One copy of every rule, in the repo, versioned with it.

## 3. COMPILE — building the pipeline

A brief now contains: the pointer to AGENT-RULES.md, the pointer to the committed plan, the
measured baseline with its timestamp, the task body, its **risk tier**, its Files list, its
acceptance criteria, the frozen-path list, the halt conditions, and the finish block.

**Model routing — by the KIND of judgement, not by task size.** The review measured sonnet at a
15% rejection rate against opus's 11% across 62 tasks, and the single worst task in the series
was opus — so sonnet stays. But all five sonnet rejections were the same failure: *the test did
not discriminate*. So:

> **Opus wherever correctness rests on proving an assertion has teeth** — fixture design,
> mutants, races, absence assertions, anything CRITICAL. **Sonnet for everything else**,
> including most implementation.

Plan 07 broke this by putting two fixture-discrimination tasks (T14, T16) on sonnet and paid
for both.

**Agent tools:** pipeline agents get a restricted tool set. Plan 08 pipeline A carried ~11k
tokens of MCP roster — 248 tool names across six servers — into every agent and made **zero**
MCP calls, ~132k per pipeline of listing nobody read. claude-mem is not wired into agents
either: it stores main-session narrative, not task context.

**Pre-flight, unchanged and still mandatory** — every probe ships with a negative control that
must be observed to fail in the same run:
1. Module-parse probe (the `return`-rewritten copy parsed as ESM) — catches duplicate
   declarations and real syntax errors.
2. Dry run with stubbed `agent`/`parallel`/`phase`/`log` — catches dropped constants and wiring,
   and asserts every block's marker text in the RENDERED brief.
3. `node --check` on the `.js` is a smoke test only — it is **inert** for this script shape
   (a top-level `return` makes it exit 0 on genuine syntax errors).

## 4. RUN — the ladder, and the new review split

**The ladder is unchanged** and it earns its keep: a rung advances only on a real gate
rejection; infrastructure failures retry the same rung and never promote the tier; a dead gate
re-judges the same coder report. Plus the wave-stall break: in a sequential pipeline, stop the
run when a wave does not complete rather than letting later tasks discover it.

**What changes is review.** The per-task opus gate has not rejected a task in 22 consecutive
tasks across Plans 07–08, while costing a third of every pipeline. It had quietly stopped being
a rejector and become a discoverer — 54 findings in Plan 08 pipeline A, including the lock-mode
discovery. Those are different jobs at very different prices. So:

| | who | when | cost |
|---|---|---|---|
| **Mechanical check** | main session | every task | ~5k |
| **Per-task gate** | opus | CRITICAL tasks only | ~130k each |
| **Discovery review** | opus | once per PIPELINE | ~150k |

The **mechanical check** is what actually catches "did it really pass": `pnpm verify` detached
with the exit value read from a file, `git show --stat` against the Files list, a frozen-path
grep, CI by SHA, clean tree. The main session already does this after every pipeline and does
it better, because it is genuinely independent of the agent that wrote the code.

The **discovery reviewer** reads all of a pipeline's commits together. This is not a downgrade:
the findings that mattered most — a defect shipped dormant by one task and armed by another, a
convention six tasks honour that no test protects — are *cross-task* findings that a per-task
gate structurally cannot see.

## 5. VERIFY — unchanged, and non-negotiable

The main session verifies every pipeline itself and never trusts an agent's self-report:
detached `pnpm verify` with the exit value read from a file · per-commit `git show --stat`
against Files lists · frozen-path audit over the whole range · CI green by SHA · server tree
clean. Then the lessons go into the ledger the same session.

---

## 6. What v2 explicitly does not touch

- **Rule 21** — build the mutant, never predict it. Plan 06.1's audit found the Assertion Book
  wrong in *both* directions; only executed mutants found it.
- **Rule 19** — prove isolation from output. Five "clean" race runs were five full-suite runs.
- **Rules 16–18** — never trust a pipeline's or a wrapper's exit status; detached runs with exit
  files.
- **Rules 14–15** — never weaken security code, never rewrite pushed history.
- **Independent main-session verification** after every pipeline.
- **Agents reporting plan defects instead of working around them.** Both `settlement.ts`
  disclosures in Plan 08 pipeline A were exactly right and cost nothing.

## 7. Expected effect

| lever | per 6-task pipeline |
|---|---|
| local-mirror navigation instead of SSH round-trips | 15–25% of coder cost |
| review split (mechanical + CRITICAL-only gates + one discovery pass) | ~0.55M |
| mutants only on CRITICAL tasks | ~0.15M |
| restricted agent tool set | ~0.13M |
| no per-task count reconciliation | small, plus fewer findings spent on it |

**~2.45M → ~1.3–1.5M**, with CRITICAL-path verification untouched.

**The honest risk** is a task mis-labelled ROUTINE shipping a weaker test. Two mitigations: the
label is set by the plan author before any code exists, and the per-pipeline discovery reviewer
reads every commit regardless of label. If a ROUTINE task is ever found to have shipped a
non-discriminating assertion, that is a signal to re-tier — record it in the ledger.

---

## 8. Calibration note (2026-08-19)

§7's "~2.45M → ~1.3–1.5M" assumes a workload with a meaningful ROUTINE fraction. **Check that
assumption against the plan in front of you before quoting it.** Plan 08's remaining twelve
tasks turned out to be ten CRITICAL and two ROUTINE — a money module earns its verification —
so its honest saving is **~25–35%**, from the mirror, the review split and the restricted tool
set rather than from the tiering dial. See METHOD-REVIEW §13.

**The general rule:** the tiering dial pays in proportion to how much genuinely routine work a
plan contains. Count the required-DIED mutants in the Assertion Book before promising a number
— that count *is* the plan's own risk assessment, written before any code existed.
