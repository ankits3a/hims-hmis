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

