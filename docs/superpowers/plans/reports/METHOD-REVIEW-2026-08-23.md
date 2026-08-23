# Method review 2 — the shell became the defect generator

**Owner call, 2026-08-23:** the owner asked, as a standing architectural question, whether the
planning/brainstorming and execution methodology is heavier than it should be — and ruled that it
changes **only if the evidence is abundant**. This document is the evidence. The change it
justifies is [`../../EXECUTE-METHOD-V3.md`](../../EXECUTE-METHOD-V3.md); Plan 11d, already
executing when this was written, runs to completion under v2.

Relationship to the first review ([`METHOD-REVIEW-2026-08-19.md`](METHOD-REVIEW-2026-08-19.md)):
that review measured *cost* (75k → 204k per agent) and cut ~30% by changing who reads, who
reviews, and where agents type. This review measures something the first one did not:
**where the defects themselves come from.** Its finding is that v2 fixed the price of the shell
without asking whether the shell was load-bearing.

---

## 1. What was measured, and how

- **Every entry in [`EXECUTION-LESSONS.md`](EXECUTION-LESSONS.md)** — 125 entries (§2: 80, §3: 45
  headline / 54 specimens) — classified by a stated rule: an entry is PROCESS-INDUCED if the
  defect exists *only because of* the plan→brief→prompt→gate machinery; PRODUCT-BUG-CAUGHT if a
  real defect in shipped code/tests/deployment was caught by a process instrument;
  MODEL-CAPABILITY if the author got a technical fact wrong that compiler or execution caught
  cheaply; OTHER for measurements, positive records, and generic tooling traps.
- **Plan 11d's three planning documents, byte-accounted by section** (87,152 + 14,148 + 16,759 =
  118,059 bytes), against the code its own File Structure says it ships.
- **The size trend of every gate report, plan 01 → 11c**, and the document count per phase.
- **The output side, from git:** 13 days, 323 commits, ~32,850 lines of production TypeScript and
  ~34,170 lines of tests, system live in production.

The last line matters and is stated first: **the method ships.** Nothing below argues it does
not. What is measured below is what fraction of its weight produces that result.

## 2. Finding 1 — 55% of the ledger is the process injuring itself

| bucket | §2 | §3 | total | share |
|---|---|---|---|---|
| PROCESS-INDUCED | 55 | 14 | **69** | **55%** |
| PRODUCT-BUG-CAUGHT | 10 | 22 | **32** | **26%** |
| MODEL-CAPABILITY | 0 | 7 | 7 | 6% |
| OTHER (measurements, positives, generic traps) | 15 | 2 | 17 | 14% |

In §2 — the pipeline-template section — **69% of all entries are process-induced.** The
sub-classes of that 55, with their counts:

- **Stale hand-maintained copies of facts across documents — 13** (§2.6, §2.9, §2.21, §2.24,
  §2.34, §2.38, §2.43, §2.46, §2.48, §2.54, §2.73, §2.78, §2.5). The single largest defect
  class in the project. §2.54 alone cost Plan 08.5 its headline deliverable; §2.78 happened
  *to the session writing about §2.78*.
- **Brief/pipeline-script compilation defects — 11** (§2.15, §2.18, §2.19, §2.22, §2.25, §2.32,
  §2.47, §2.51, §2.65, §2.72, §2.79) — defects in the machinery that translates the plan into
  agent instructions, including one that quietly forbade its own deliverable (§2.72).
- **Gate/ladder/criterion ceremony mechanics — 15**, including §2.3, where an unsatisfiable
  criterion drove four agents to manufacture red states and one to strip a break-glass bypass
  on the live server.
- **Subagent coordination and context budget — 6**, including §2.40, the shared-mirror phantom
  files that produced a false, evidence-backed accusation against a compliant agent — the
  ledger's own "most serious PROCESS defect of the run" — and §2.29's 132k/pipeline of MCP
  roster nobody ever called.

Two honest qualifications. First, entry count is not token cost: many process-induced entries
were caught at compile for ~0 tokens. But the *largest single line items in §4 are also
process-induced* — the ~934k write-off, the SSH navigation tax (65% of coder shell calls), the
gate's 33% of every pipeline across **22 consecutive tasks with zero rejections**, ~267k of
scout transcription recovery. The distribution is process-heavy at both the count and the tail.
Second, the classification rule is stated above precisely so it can be re-cut by someone who
disagrees with a boundary; moving a handful of entries between buckets does not move the
conclusion.

The ledger's own recurring sentence, across six consecutive plans, says the same thing this
table says: *"the failure locus sits in what the plan **claimed** rather than in what the coders
**built**."* The plan-document layer is the least reliable artifact in the system — and the
method's response to date has been to make that layer larger.

## 3. Finding 2 — the ceremony floor is fixed while the phases shrink (Plan 11d, audited)

Plan 11d's production-behavior delta is **four lines** — one advisory-lock statement, one payload
field, one `refId`, one `eq()` term — plus two seed scripts, tests, and small config. Roughly a
quarter to a third of 11c's code volume. What carries it:

- **Twelve documents**: nine phase-specific artifacts (brainstorm prompt, plan, spike brief,
  spike report, execute prompt, compiled pipeline, preflight, findings inbox, gate report), a
  ledger append, and two standing documents re-read each phase.
- **Measured repetition across just the three planning documents**: `seed:roles` appears 18
  times; the exit-value-from-a-file rule 12 times; pointers to §B-MEASURED 11 times; the
  nine-permissions production measurement is restated **in full six times**. The repetition has
  already produced a live contradiction: the plan budgets the spike at ~100k, the spike brief at
  ~70k — two documents, two numbers, one spike. This is §2.78's mechanism, active in the newest
  plan, before execution even began.
- **The planning documents are 1.4× the byte size of the code they produce**, and ~700× the
  byte size of the behavioral delta.
- **A ≤3.4M subagent-token budget** — larger than Plan 11c's entire actual spend (2.49M) and
  Plan 10's (2.64M) — declared elastic upward at compile time. Against the four behavioral
  lines, that is ~850k subagent tokens per line of changed production behavior.
- **Phase 0 is the reductio in one row**: a dedicated opus agent, its own commit, CI-green-by-
  full-SHA, and an Assertion Book row — to add jest's third argument to one `it(...)`.

None of this says 11d's *content* is wrong. The audit found real load-bearing rows in its
Assertion Book (§5 below). It says the apparatus is sized for a 16-task money module and was
paid in full by a phase that changes four lines.

## 4. Finding 3 — v2's ratchet re-accreted within days

The first review's root-cause sentence was: *"No mechanism in this process ever removes a
rule."* v2 then removed some weight once. Since then:

- §3's pruning target was 39 → ~20 entries. It stands at **45** (54 specimens). §2 has grown to
  **80**.
- Gate reports have grown monotonically, 15.8 KB (plan 01) → 42.7 KB (plan 11c) — while the
  phases they close got smaller.
- The compile-time sweep grew from 7 to 9 items in the days after v2, each item another prose
  paragraph an author must hold.
- In the project's entire history there has been exactly **one** rule removal (§2.35), and it
  required an owner ruling plus two follow-up measurement entries to survive. Additions are
  automatic; removals need a ceremony. That asymmetry guarantees re-bloat regardless of how
  good any single review is.
- The predictive budgets that justify part of the ceremony do not predict: Plan 05 ran 42%
  over, Plan 06 56–76% over, Plan 07's pipeline C 86% over, Plan 10 **2.2× over**. The actuals
  table has been the useful half of the budgeting apparatus all along.

## 5. What earned its keep — untouched, with receipts

The verification core is measurably load-bearing and v3 does not thin it:

- **Executed mutants on CRITICAL seams.** The Assertion Book has been proven wrong *in both
  directions* (Plan 06.1); 11c's permission-repointing mutant class **survived 71 tests**; a
  hand-walked prediction has never been accepted since rule 21, and should never be.
- **Independent eyes that never trust a self-report.** §3.26 (DPCO ceiling resolution) shipped
  through a plan, two gates and an independent verification, and was caught only by the ~493k
  post-ship audit — "the highest-yield tokens spent in the project." §3.45 (every write button
  re-entrant: one payment, two receipt rows), §3.42 (PAN behind a cashier-visible permission),
  §3.17 (`bodyParser:false` silently discarded), §2.58 (`start:dev` broken four days under 807
  green tests) are the class of catch this project cannot do without.
- **The cross-task discovery review** — repeatedly the best-value agent of its run, because the
  findings that matter most are the ones a per-task gate structurally cannot see.
- **The spike** — v2's highest-value 50k, unchanged.
- **Disclose-don't-work-around** — "converted authoring defects into ledger entries at zero
  retry cost in six consecutive plans."
- **Rules 14–21** — security, history, exit-value and isolation discipline. Non-negotiable.

## 6. Root causes, named

1. **Facts are copied, not referenced.** ~12 documents per phase hand-carry the same SHAs, role
   keys, file lists and budgets. The cure is already proven inside this project: when briefs
   stopped restating the plan and started pointing at it, "no transcription drift appeared in
   twelve tasks." The pointer pattern was adopted for rules and never extended to the rest.
2. **The apparatus is calibrated for executors that stopped failing.** The gate ladder was sized
   against 15%/11% rejection rates measured on Plans 02–08; the last 22 gated tasks produced
   zero rejections. The scaffolding outlived the failure mode it was built for, and nobody
   re-based it — the first review said exactly this about the gate and split it; the same logic
   now applies to the pipeline shell as a whole for small phases.
3. **Prose checklists are the unit of process growth.** Every lesson becomes a paragraph a
   human-shaped author must remember to obey; §2.7 and §2.51 record the checklist layer itself
   rotting. A check that is a script (the `ci-watch.sh` pattern) cannot drift and costs nothing
   to obey.
4. **The two-host topology is a standing defect generator.** Rules 1–3, 13, 18 and all of
   22(a)–(g) exist only because authoring happens on Windows while evidence lives on a remote
   Linux host. It produced the SSH tax, the mirror protocol, the md5 sync ceremony, the CRLF
   trap class, and §2.40. This is an owner infrastructure decision, not a method rule — v3
   names it as a lever and leaves the ruling to the owner.
5. **Predictive budgets are ceremony.** They miss by up to 2.2×, and 11d's trim-lever protocol
   negotiates a 4.4% variance inside a budget calibrated by analogy across a ±34% spread.

## 7. The change

**[`EXECUTE-METHOD-V3.md`](../../EXECUTE-METHOD-V3.md)**, adopted 2026-08-23, piloted on the
first phase after Plan 11d. One principle — *move every claim from prose to execution, and keep
every fact in exactly one place* — carried by five changes: one document per phase; phase-level
tiering with an in-session LIGHT lane as the default; recurring checks enter the method as
scripts or not at all; actuals and a stop-loss instead of predictive budgets; a ledger archive
rule that runs at phase close without a ceremony. The v2 pipeline survives intact as the HEAVY
lane for phases that genuinely need it. The pilot's measurements and reversal conditions are
§7 of that document — including the condition under which this review is judged wrong.
