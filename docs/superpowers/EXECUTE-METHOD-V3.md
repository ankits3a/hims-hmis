# Execute method v3 — the shell shrinks to fit the phase

Adopted 2026-08-23 after the second method review
([`plans/reports/METHOD-REVIEW-2026-08-23.md`](plans/reports/METHOD-REVIEW-2026-08-23.md)),
which classified all 125 ledger entries and found **55% process-induced against 26% product
bugs caught**, with the largest single class being hand-maintained copies of facts drifting
across ~12 documents per phase. The evidence lives there and is not restated here.

**Transition rule: Plan 11d runs to completion under v2** ([`EXECUTE-METHOD.md`](EXECUTE-METHOD.md)).
It was compiled under v2, and a method never changes under a running pipeline — the same rule
that lands template fixes between pipelines, generalised. v3 governs from the first post-11d
phase, as a measured pilot (§7).

---

## 0. The principle

**Move every claim from prose to execution, and keep every fact in exactly one place.**

What v3 does not touch, at any tier: rules 14–21 of [`AGENT-RULES.md`](AGENT-RULES.md) —
security, pushed history, exit-value discipline, isolation proof, build-the-mutant-never-
predict-it; executed mutants on CRITICAL seams; the spike; disclose-don't-work-around;
independent eyes on every phase before it closes; owner-authorised deploys; evidence produced
on the build host and nowhere else.

## 1. One document per phase

The **phase document** is the only phase-specific artifact. It holds, in order:

1. **Why this phase** — the brainstorm's outcome, three paragraphs, not a separate prompt file.
2. **Spike** — the questions written before, the measured answers appended after, in place.
   Run each question in the cheapest honest way: a read-only production query from the main
   session where that suffices (11d's Question B precedent), one throwaway-branch agent where
   something must be built to be known.
3. **Design decisions** — the D-sections, unchanged in kind.
4. **Tasks** — tier, Files list, acceptance criteria, commit message. CRITICAL tasks carry
   their Assertion Book rows **inline in the task** (assertion · mutant · discriminating
   input — the proven format). ROUTINE tasks carry none.
5. **CLOSE** — appended as the phase runs and at its end: findings as they arrive, the
   mechanical-verification evidence, the actuals row (§6), and the lessons bound for the
   ledger. This section *is* the findings inbox and the gate report.

Retired as separate artifacts: the brainstorm prompt, the spike brief, the spike report, the
execute prompt, the findings inbox, the gate report. The seed for a fresh executing session is
three lines: *read the phase document, `AGENT-RULES.md`, and the ledger's §5 — then execute.*

**The fact rule:** a fact — a SHA, a role key, a budget, a measurement — appears **once**, in
the section that owns it. Every other mention is a pointer. A second full statement of a fact
in the same phase's document is a defect, ledgerable under §2.78's class.

## 2. Phases get tiers, the way v2 gave them to tasks

The plan author rules the lane at write time, in one recorded sentence.

- **LIGHT — the default.** The phase is executed in-session (§3). Presumed for any phase a
  single session's context can hold: hardening passes, ops work, config, small feature slices —
  as a guide, ≤8 tasks and no full-module build.
- **HEAVY.** The v2 pipeline, invoked by pointer to [`EXECUTE-METHOD.md`](EXECUTE-METHOD.md),
  which remains in force as the HEAVY-lane manual. Reserved for phases whose breadth genuinely
  exceeds one context — many-task module builds of the plan-05/07/08 shape. Task tiering,
  model routing, the ladder and the compile sweep apply there unchanged.

The lane sets who codes and how work is dispatched. **It does not set verification depth** —
money, locking, permissions and immutability seams get executed mutants in either lane.

## 3. The LIGHT lane

1. **The main session codes, task by task, sequentially**, under AGENT-RULES in full — evidence
   from the build host, detached runs with exit files, narrow suites while iterating, the
   finish block per task. No compiled pipeline, no briefs, no waves, no per-task gates.
2. **Mutants** for every inline CRITICAL row, built by the session, rule 21 unchanged.
3. **CI is watched, not assumed**: `ci-watch.sh` in the background for the duration, and
   CI-green-by-full-SHA before the phase closes (§2.55/§2.59 discipline).
4. **One independent reviewer, then close.** After the final task: a single fresh-context
   reviewer agent (restricted tool set, no MCP roster) reads every commit of the phase
   together — the discovery review, the instrument this project's own data grades best-value,
   now also carrying the independence that per-task gates used to provide, since the session
   that wrote the code must not be the only judge of it. Its findings land in CLOSE; CRITICAL
   findings block close.
5. **Mechanical close by the session**: detached `pnpm verify` with the exit value read from a
   file, per-commit `git show --stat` against Files lists, frozen-path audit, clean tree —
   v2 §5's list, unchanged.
6. **Deploy steps remain owner-authorised, in as many words**, exactly as before.

What this lane deletes, by construction: the brief-compilation defect class (11 ledger
entries), the subagent-coordination class (6 entries, §2.40 included), the transcription class
between documents (13 entries), and the zero-rejection gate spend. What it keeps: every
instrument with a receipt.

## 4. Checks are scripts, or they are not method

The prose checklists stop growing. A recurring check enters the method **only as an executable
script** beside `ci-watch.sh` in [`pipelines/`](pipelines/) — run it and read its verdict, the
pattern that cannot drift and costs nothing to obey. Existing prose checks are converted lazily:
the first phase that needs one converts it and deletes the prose. No speculative tooling — a
script is written when a check recurs, not before; building apparatus ahead of need is how the
ratchet started.

## 5. The ledger stops ratcheting

- **Additions**: unchanged — a defect with a specimen earns an entry.
- **Archive rule, run at every phase close, no ruling required:** any entry whose enabling
  mechanism no longer exists (the machinery it describes was removed, the topology changed,
  a stronger entry absorbed it) moves to an `ARCHIVE` section at the ledger's foot, struck in
  place with one line saying why — the rule-6 pattern. The 2026-08-19 consolidation rule
  stands. An entry nobody can attach to a live mechanism is weight, not memory.

## 6. Actuals and a stop-loss, not predictive budgets

No phase carries a predicted token budget, and no trim-lever negotiation happens against one.
Instead:

- **The actuals table** (per phase: tokens, agents, wall clock, catches) continues in CLOSE —
  it is the half of the budgeting apparatus that was ever true.
- **One stop-loss per phase**, set at kickoff **from the last comparable phase's PER-TASK RATE times
  THIS phase's task count** (e.g. 1.5× that product): crossing it halts the phase for an owner
  decision. A stop-loss is a tripwire, not a target, and it is the only forward-looking number a
  phase carries.

  > **AMENDED 2026-08-26 (ledger §2.95) — the arithmetic IS the amendment.** Plan 09 took 1.5× a
  > FIVE-task phase's TOTAL and applied it to an EIGHT-task phase: a ceiling arithmetically incapable
  > of covering the work before a single agent ran. It fired mid-phase and halted for an owner
  > decision that was not about waste — the measured per-task rate agreed with the comparable phase
  > to **1.2%**. Normalise the comparable, then scale it. The phase document had even predicted the
  > failure mode in prose and then not done the multiplication: **a caveat is not a calculation.**

  > **AMENDED AGAIN 2026-08-26 (ledger §2.107, Plan 09a's audit) — THE STOP-LOSS NEEDS A SECOND TERM,
  > AND IT IS THE REVIEW BUDGET.** The formula above scales with TASKS. The review-and-remediate
  > cycle does not: it scales with what the tasks got wrong, which is unknowable at kickoff. Plan 09a
  > set 340k from four tasks and spent **474,771 on two reviewer passes** — 40% over — and those two
  > passes are the only reason the phase is correct. Its four tasks produced five dead mutants, five
  > green verifies and four green CI runs over a tree carrying a MAJOR.
  >
  > **The formula is therefore:**
  > `stop-loss = 1.5 × (per-task rate × task count) + one full reviewer pass per remediation cycle`,
  > the second term taken from actuals — **16a: 181k for one pass. 09a: 475k for two.** Budget one
  > cycle by default and say so; a phase whose reviewer finds nothing simply comes in under.
  >
  > **And the rule the number exists to protect:** when a reviewer's findings force a fix, that fix
  > is UNREVIEWED CODE ON THE SAME PATH. Send the reviewer back. On 09a the second pass cost more
  > than the first and found a race test sitting nine seconds inside a fifteen-second budget — green
  > on an idle host, red on a busy runner, i.e. §2.99 about to repeat. **A stop-loss that halts the
  > second pass is a stop-loss that ships the defect the first pass created.**

## 7. The pilot, and what refutes it

**The first post-11d phase runs under v3.** Its lane is ruled by §2 honestly — if the
brainstorm selects a HEAVY-shaped phase, v3 is still the method (one document, scripts,
actuals) and the LIGHT lane waits for the next eligible phase.

Measured at close, against the last three phases' actuals (2.64M / 2.49M / 3.34M):

- **total tokens, all sessions counted** — not subagents only;
- **defects found by the independent reviewer, and any reaching production**;
- **transcription-class incidents — target zero**, since the class is structurally impossible
  with one document; any occurrence is a v3 defect and gets a ledger entry.

**Reversal conditions, recorded in advance:**

- If the reviewer or production surfaces a defect of a class v2's per-task apparatus has a
  named prior catch for, the next phase re-tiers HEAVY and the ledger records the specimen.
- If a LIGHT phase's total cost lands inside or above the v2 band for comparable scope, v3's
  cost claim is refuted — record it, do not re-argue it.
- One quiet run retires nothing of v2's; one bad run retires nothing of v3's. Specimens decide,
  as they always have (§2.68's caution, applied in both directions).

## 8. The topology — RULED

**The two-host topology.** A third of AGENT-RULES (rules 1–3, 13, 18, 22(a)–(g)), the SSH tax,
the mirror protocol and §2.40's entire class exist only because authoring happens on Windows
while evidence lives on the build host.

**RULED, 2026-08-23 — the owner moved authoring onto the build host.** Effective with the
pilot phase; nothing moves under running 11d. From the pilot on, the working session runs ON
the host, in the checkout — Claude Code 2.1.241 is installed there (2026-08-23,
`/usr/local/bin/claude`), tmux is present for session persistence, and the one remaining setup
step is the owner authenticating it once (`ssh -t root@62.238.106.231 claude`). The Windows
checkout becomes the owner's read-only copy, and ~~keeps exactly one duty: running
`pipelines/ci-watch.sh`, which stays off-host until the owner separately decides whether a
read-only CI credential belongs on an SSH-probed box.~~

> **AMENDED 2026-08-24 (ledger §2.91, Plan 11f T4) — the struck clause was true of `gh` and false
> of CI.** `ci-watch.sh` needs `gh`, and `gh` needs a credential this box does not have; but the
> repository is PUBLIC, so the unauthenticated GitHub API answers `/actions/runs?head_sha=` and
> `/commits/{sha}/check-runs` over plain `curl` from the build host. §3.3's "CI is watched, not
> assumed" therefore no longer depends on which machine the session runs on:
> [`pipelines/ci-watch-host.sh`](pipelines/ci-watch-host.sh) gives green/red **per full sha** with
> no credential at all, and distinguishes §2.59's third state — did-not-run — by exit value. Job
> LOGS remain 403 without a credential; that is diagnosis rather than verdict, and it is the one
> thing still delegated to a machine with `gh`. **The rule this bought, and it is why the clause is
> struck rather than deleted: when a method records that a host cannot do something, record WHICH
> TOOL was tried.** A capability ruling stated against a tool expires the moment another route to
> the question exists.

**What the post-11d session strikes from AGENT-RULES when v3 activates** — in place, the
rule-6 pattern, citing this section:

- **Rule 13 and all of rule 22(a)–(g)**: no mirror, no `scp` sync, no md5 confirmation — the
  reading surface and the evidence host are the same machine, and §2.40's class becomes
  structurally impossible.
- **The §2.79 CRLF class**: authoring happens on Linux.
- **Rule 18 narrows**: the dropped-SSH-channel failure mode is gone; detached-with-exit-file
  stays for genuinely long runs, and rules 16–17 are host-agnostic and unchanged.
- **Rules 1–3 restate to one sentence**: you are on the build host; `/opt/hmis` and
  `/opt/hmis-prod` are the only writable paths; the owner's Windows checkout is not reachable
  from any session and stays out of scope.

**What the ruling does not change:** privileges — agents already ran arbitrary root commands
over SSH, so the move removes round-trips, not boundaries; rules 7 and 14–21; the evidence
standard, whose sentence merely shortens: evidence still comes only from this host — it is
simply no longer remote. One vigilance note, recorded so it is watched rather than
discovered: production paths are now reachable by native file tools instead of visible SSH
calls, so rule 3/7 discipline carries the weight the SSH boundary used to make conspicuous —
if the pilot's reviewer ever finds a stray write near `/opt/hmis-prod`, that is a ledger entry
and grounds to add user-level deny rules to the host's Claude settings.

---

## 9. The context budget — added 2026-08-26, and it is the most expensive lesson this method has bought

**Agent cost is `turns × context`.** An agent pays for its entire context on every tool call, so the
two terms multiply. Until Plan 09 this method measured neither: the stop-loss watched a *total*, the
Assertion Book watched *rigour*, and nothing watched the thing that actually sets the bill.

Plan 09, measured from its own journals (ledger §2.97): **output 2.08M, context re-read 871M — 420× —
at 374,461 tokens carried into every one of 2,327 tool calls.** The pipeline's own rendered prompt
blocks were 3,695 tokens and were *not* the problem. What the briefs **told agents to read** was
~152k each — the ledger 81k, the phase document 37k, a relay that grew to 34k — of which any one
agent needed perhaps 15k, re-billed on every call.

### 9.1 Three rules that bind every compiled brief

1. **Cite ledger entries BY NUMBER. Never point a brief at the ledger file.** `§2.54` in a brief
   causes a targeted read; `EXECUTION-LESSONS.md` causes an 81k one, on every turn.
2. **Point at a task's OWN section, not the whole phase document.** §1's one-document rule governs
   where facts LIVE, not how much of the document a brief makes an agent carry.
3. **Address relay entries to the task that needs them.** A relay is append-only and compounds; an
   agent in the last wave should not pay for the first wave's findings.

### 9.4 A LIGHT phase's saving is not a saving until its reviewer has run — added 2026-08-26

Measured, Plan 16a: nine tasks in-session, zero subagents, **eleven green `pnpm verify` runs and
eight green CI runs**, fourteen mutants built and fourteen dead. The tree looked finished. **One
reviewer, 181,605 tokens, found three CRITICAL patient-safety defects in it** (ledger §2.102), all
three in the seam between the pure functions the phase tested hardest and the pipeline that feeds
them.

**The amendment: a phase document may not record an actuals row, and a session may not report a
phase as cheap, before §3.4's review has returned.** Until then the number is an estimate of the
work that happened, not of the work required. The three CRITICALs cost a full remediation pass —
schema migration included — after the phase had already been written up as done.

**And the fixture rule §2.102 leaves behind, because it is the half a reviewer should not have to
supply:** for every fixture a phase builds, name the field whose value is identical to another
field's, and write one leg where they differ. Text-equal-to-brand hid two of the three; a
fully-active formulary hid the third.

### 9.3 Two amendments Plan 16a's audit bought — added 2026-08-26

**(a) A "this host cannot" claim is checked, never quoted.** §8's topology ruling and ledger §2.91
both record that `gh` cannot authenticate on the build host. **That is no longer true** — `gh auth
status` reports an authenticated PAT there, and `gh run view <id> --log-failed` names a failing test
in one call. 16a reported a CI red as un-diagnosable on the strength of the stale claim before
checking, and nearly left a real flake on `main` behind it (ledger §2.100).
**The amendment: before any session repeats a capability ruling stated against a TOOL, it runs the
tool.** One line, and it retires the ruling or confirms it:
```
gh auth status && gh run view <run-id> --log-failed
```
`pipelines/ci-watch-host.sh` stays the default for a VERDICT — it needs no credential and costs one
`curl` — but the *diagnosis* half of §8's ruling is dead, and a session that cannot name a red test
should say which command it ran, not which entry it read.

**(b) The ledger's own size is a line item in every audit.** `EXECUTION-LESSONS.md` measured
**329,574 bytes ≈ 82k tokens** at 16a's close, and every HEAVY phase re-bills that per agent per
call. The ARCHIVE pass §5 created has retired three entries in two runs while the file gained two in
one session — accretion is winning about 10:1 (ledger §2.101). **The audit now reports the number
beside the phase's spend**, so the trend is visible while it is still cheap to act on. §9.1's
cite-by-number rule is what acts on it; this is the measurement that says what obeying it is worth.

### 9.5 A RESUMED agent starts full — added 2026-08-26 (ledger §2.108)

**§9's metric is what an agent CARRIES, never what its brief POINTS AT**, and a resumed agent
carries everything its previous pass read.

Measured on Plan 09a's reviewer: same agent, same pointers, a SMALLER diff — **pass 1 ~2,480 tokens
per call, pass 2 ~8,950**, nearly four times, over 36% of the calls. Nothing about the brief changed;
the agent had simply already read four source files, run a dozen probes and written a report, and it
paid for all of that on each of its 30 remaining calls.

**Two consequences for compiling:**

- **Budget a resumed agent at its predecessor's high-water mark**, not as a cheap follow-up. The
  pointer-trimming rules in §9.1 govern a FRESH agent and are close to irrelevant to a resumed one.
- **Resume for CONTINUITY, not for economy.** It is often the right call — 09a's second pass knew
  exactly what it had already proven and re-verified none of it, which a fresh reviewer would have
  had to redo — but choose it for that reason and price it honestly.

**AMENDED 2026-08-27 after Plan 13 (ledger §2.115) — the cost does not merely stay high, IT
CLIMBS, and the per-call figure explodes as the workload shrinks.** One reviewer, three
invocations:

| invocation | workload | tokens | calls | per call |
|---|---|---|---|---|
| pass 1, fresh | 8 commits, 40 files, +38,779 | 175,209 | 38 | 4,611 |
| pass 2, resumed | one 7-file diff, +163/−27 | 205,365 | 5 | **41,073** |
| pass 3, resumed | four yes/no questions, 6 files, +92/−6 | 224,081 | 2 | **112,041** |

**604,655 total — 92% of that phase's entire stop-loss, on the reviewer alone.** The mechanism is
monotonic rather than noisy: **a resume re-bills the transcript, and the transcript grew by the
agent's OWN previous report.** With few calls the context ramp IS the cost and nothing amortises it.

**THE DECISION RULE — resume for MEMORY, spawn FRESH for SCOPE.** Before resuming, ask whether the
question needs what that agent *remembers*:
- **Needs memory:** *"is the fix for the defect YOU found correct?"* Resume. Plan 13's pass 2
  qualified and earned it — it found TWO MAJOR defects in the remediation for its own first
  finding, one of which re-introduced a defect class the plan itself cites as a cautionary tale.
- **Does NOT need memory:** *"confirm these four properties of this 92-line diff."* **Spawn fresh.**
  A fresh agent carrying `AGENT-RULES.md` plus the diff plus the questions opens at roughly 7k of
  context; the resumed one opened at its whole transcript. Measured saving on that invocation:
  **4–7×, with nothing verified less.**

**And the budget term in §6 is amended with it:** price a resume at **~1.3× the previous
invocation**, not at the fresh rate and not at parity. A two-resume phase costs about 3.4× its
first pass, which is what Plan 13's 450,230 review term underestimated by a third.

### 9.6 A HANDOFF SPENDS ITS LAST BUDGET ON RUNNING, NOT ON WRITING — added 2026-08-27 (Plan 14 close, ledger §2.120/§2.121)

A session that hits its context limit mid-remediation faces one choice, and Plan 14 made it the
wrong way round. It wrote **eight files of fixes** — the CRITICAL among them — **typechecked none of
them, ran none of them**, and spent its remaining budget writing an excellent 200-line handoff
document that described the fixes as done. The handoff was honest: it said in bold that the work was
*"written, NOT typechecked, NOT tested."* It was still wrong about the code.

**Measured on the successor session.** `pnpm typecheck` on the handed-off tree: **12 seconds**, and
it passed — so a reader had every reason to believe the fixes were sound. The narrow suites did not:

- the **C1** fix, the one the whole close was blocked on, **failed 13 tests** on the first run
  (5 ledger, 8 consumer), all on one CHECK constraint. Time to discover: **~90 seconds.** The fix's
  SQL was correct and its VALUES clause was not (§2.120) — a fact no amount of re-reading the diff
  produces, because it is a claim about when Postgres evaluates constraints;
- the **M2** fix was reachable and still broken for a second, independent reason (§2.121), found by
  reading the newly-live code rather than by running it — but only because running C1 had already
  established that the handed-off fixes could not be trusted.

**Two of the eight files were wrong, and one of the two was the CRITICAL.** Both were found in the
first four minutes of the successor session. The handoff prose could not have found either.

**The rule.** When a session must hand off mid-work, its remaining budget goes, in this order:
**(1) typecheck, (2) run the narrowest suite that covers what you changed, (3) write the handoff.**
A handoff that says *"green as of <suite>, exit value read from a file"* is worth several pages of
prose about intent. If there is budget for only one, run the suite — the successor can re-derive
your reasoning from the diff, and cannot re-derive a test result you never took.

**And the corollary for the reader of a handoff: uncompiled, unrun code is UNKNOWN code, however
well it is described and however confident the description.** Treat a handoff's "what is already
fixed — verify by reading, then move on" as "what is already WRITTEN". Run it first.

### 9.2 The measurement, before compiling and after closing

**Before:** `wc -c` every file the briefs point at, divide by four, and write the total into the
phase document beside the stop-loss. A phase that cannot state its per-agent context budget has not
been compiled, it has been assembled.

**After, at every close and every deploy, no ruling required** — the same standing as §5's ARCHIVE
pass: run [`pipelines/token-audit.js`](pipelines/token-audit.js) and follow the `token-audit` skill.
It measures both terms at zero model cost, weighs what the spend BOUGHT against the phase's CLOSE,
and appends the phase to [`pipelines/token-baselines.json`](pipelines/token-baselines.json) so the
next audit is a comparison rather than an anecdote. A **PostToolUse hook fires it automatically**,
because this is precisely the step a session skips when the phase is finally green.

### 9.3 The lever order, and why agent count is LAST

Attack **context per call** first: it is the largest term, and cutting it verifies nothing less.
Then **turns** — a mix that is 90%+ Bash means agents reading files through `cat`/`sed`/`grep`, one
billed turn each. Take **agent count** last, and therefore the LANE last, because it is the only
lever that can cost verification depth. §2's rule stands unchanged: **the lane sets who codes and how
work is dispatched; it does not set verification depth.**

### 9.4 The honesty rule this section cannot enforce and the owner must

**A LIGHT phase's subagent tokens are not comparable to a HEAVY phase's.** LIGHT moves cost into the
main session, which no session can measure from inside — runbook **O3**, open since Plan 11e. Plan 09
spent **13× Plan 11h's subagent tokens for a comparable task count**, and that comparison is
suggestive rather than settled until an owner reads `/cost`. Report it that way, in as many words.

