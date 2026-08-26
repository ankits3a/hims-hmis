---
name: token-audit
description: Audit where a phase's tokens went and whether they bought anything, then amend the method so the next phase spends less for the same result. Use when a plan/phase is closed, committed or deployed, when asked "where did the tokens go", "was that worth it", "why did that cost so much", or after any expensive pipeline run.
---

# Token audit — was that spend an investment, or just an expense?

**The pain this exists for.** Plan 09 cost about 7M tokens for eight tasks. Nobody could see where
they went until after the money was spent, and the answer was not what anyone assumed: **output —
every line of code, every mutant, every test — was 2.08M. Context re-read was 871M.** An agent pays
for its entire context on every tool call, so cost is `turns × context`, and neither term was ever
measured while the phase ran.

**Run the script. Read the verdict. Never read the journals** — reading 900MB of transcript to
discover that reading is expensive is the defect this skill exists to catch.

---

## 1. Measure (zero model tokens)

```
node docs/superpowers/pipelines/token-audit.js --since <the phase's first commit date>
```

~40 lines. It gives you: agents, turns, output, context re-read, **context-per-call**, the turn
mix, and every prior phase's per-task rate from `token-baselines.json`.

If it reports no transcripts, the phase ran in-session (the LIGHT lane) and its cost is
main-session tokens. **Say that.** Do not present a LIGHT phase's subagent number next to a HEAVY
one as though they were the same measurement — see §5.

## 2. Ask what the spend BOUGHT, and be specific

Cost alone is not a verdict. Open the phase document's CLOSE and count what the money produced:

| instrument | the question that decides it |
|---|---|
| the spike | did it REFUTE anything? A spike that confirms the plan bought insurance; one that refutes it bought the phase. |
| per-task gates | how many REJECTIONS? how many findings that survived to CLOSE? A gate that rejects nothing and finds nothing is a receipt, not a check. |
| mutants | how many DIED vs were BUILT? All-died with no survivors means either good code or fixtures that cannot reach the bug — §2.93. |
| the independent reviewer | findings, by severity, that no gate caught. This is usually the best value per token in the whole phase. |
| coders | the only agents that produce shippable output. Their share of total spend is the honest "how much went to the work". |

Write the verdict as a sentence a person would say out loud: *"the spike and the reviewer earned
their cost; seven gates found two MAJORs between them and cost a third of the run."*

## 3. Ask where it could have been saved — the three levers, in order of measured leverage

**Lever 1 — context per call. Nearly always the biggest, and it costs nothing to fix.**
Measure what each agent was TOLD to read:
```
wc -c docs/superpowers/plans/reports/EXECUTION-LESSONS.md docs/superpowers/AGENT-RULES.md <the phase doc> <any relay>
```
Divide by 4 for tokens. In Plan 09 that was ~152k of documentation per agent — the ledger alone was
81k, of which each agent needed about five entries — **re-billed on every one of 2,327 calls.**
The fix is not "read less carefully". It is: **cite ledger entries by number in the brief; point at
a task's own section, not the whole phase document; address relay entries to the task that needs
them.** Verification depth is untouched.

**Lever 2 — turns.** A turn mix that is 90%+ Bash means agents are reading files through
`cat`/`sed`/`grep`, one billed turn each. Grep/Read return more per call. Also count re-reads of the
same file across a run — those are pure loss.

**Lever 3 — agents.** Each one multiplies both terms and pays its own context ramp. This is the lane
decision, and it is the one to take LAST, because it is the only lever that can cost verification.

Then state the counterfactual **in numbers**: *"at 150k context instead of 374k, the same 2,327
turns cost 349M instead of 871M — a 60% cut with nothing verified less."*

## 4. Write the lessons down, or the audit was itself an expense

Two files, and both are required:

1. **`docs/superpowers/plans/reports/EXECUTION-LESSONS.md`** — a numbered §2 entry per durable
   lesson, in the house style: a NAMED RULE as the heading, the specimen with real numbers, and
   **the mechanical form** — the command or check that would have caught it. A lesson without a
   mechanical form is a wish.
2. **`docs/superpowers/EXECUTE-METHOD-V3.md`** — amend the method itself so the NEXT phase spends
   less by construction. A ledger entry records; a method amendment prevents.

Then append this phase to **`docs/superpowers/pipelines/token-baselines.json`** — phase, lane, tasks,
agents, subagent tokens, and a one-line note. That file is what makes the next audit a comparison
instead of an anecdote.

## 5. Three honesty rules, because each was violated once already

- **A stop-loss is set from the last comparable phase's PER-TASK rate × THIS phase's task count,
  never from its total.** Plan 09 took 1.5× a five-task phase's total and applied it to eight tasks;
  the tripwire fired on scope, not waste (ledger §2.95).
- **Never compare a LIGHT phase's subagent tokens to a HEAVY phase's and call it a saving.** LIGHT
  moves cost into the main session, which no session can measure from inside. Until the owner runs
  `/cost`, that comparison is suggestive, never settled — say so in as many words.
- **A cheap phase that shipped a defect is not a saving.** Weigh cost against what the phase's
  reviewer and production found. Report a cost cut only alongside what it did or did not cost in
  defects caught.

## 6. Report to the owner in four lines

1. Where it went — turns × context, and the ratio.
2. What it bought — the instruments that earned their keep, named.
3. What it could have cost — the counterfactual, in numbers.
4. What changed so it does not recur — the ledger entry and the method amendment, by name.
