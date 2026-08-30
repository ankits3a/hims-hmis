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

  > **AMENDED 2026-08-30 (ledger §2.143, Plan 17a CLOSED) — THE THREE-TERM FORMULA WAS RIGHT IN
  > TOTAL AND WRONG IN EVERY TERM, AND IT STILL HAS NO TERM FOR REPAIRING WHAT THE REVIEW FINDS.**
  >
  > 17a is the first LIGHT phase that measured its own main session, so it is the first test of
  > §2.141's correction. Against a 1,350,000 stop-loss it closed at **~1,241,000 — 92%.** Read the
  > terms rather than the total:
  >
  > | term | budgeted | actual | |
  > |---|---|---|---|
  > | main-session (`90,000 + 3 × 330,000`) | 1,090,000 | ~794,000 | **27% under** |
  > | task subagents (`1.5 × 20,178 × 3`) | 90,801 | **0** | none was ever spawned |
  > | review (two fresh passes) | 260,000 | 447,402 | **72% over** |
  >
  > **Three errors cancelling is not a validated formula.** Two changes follow, and both are
  > mechanical:
  >
  > **(a) IN A LIGHT LANE, DELETE THE TASK-SUBAGENT TERM. Do not carry it at its old value.** 17a
  > carried 90,801 for agents its own §0 forbade it to spawn — §2.141's exact error surviving inside
  > §2.141's own correction, because a term nobody re-derives is a term nobody notices is zero.
  >
  > **(b) THE REVIEW TERM IS A MULTIPLIER, NOT A CONSTANT, BECAUSE THE REPAIR IS NOT BUDGETED
  > ANYWHERE.** The formula pays for reviewers reading. It pays nothing for reproducing each finding
  > as a red test, fixing it, and re-running — which on 17a was twelve findings across two passes and
  > roughly the weight of the review again:
  >
  > ```
  > stop-loss = main-session term
  >           + 1.5 × (per-task subagent rate × task count)     ← 0 for a LIGHT lane
  >           + review term × (1 + remediation factor)          ← ≈ 1.0 measured on 17a
  > ```
  >
  > > **AMENDED AGAIN 2026-08-30 (ledger §2.145, Plan 17b) — THE REMEDIATION FACTOR IS 2.0, NOT 1.0,
  > > AND THE REASON IS A RATE RATHER THAN AN IMPRESSION.**
  > >
  > > 1.0 pays for repairing what pass 1 finds. It pays NOTHING for repairing what pass 2 finds —
  > > and pass 2 finds a great deal, because a third of pass 1's fixes are wrong:
  > >
  > > | phase | pass 1 fixes | condemned by pass 2 | new defects the fixing commit made |
  > > |---|---|---|---|
  > > | 17a | 5 | 3 | 1 |
  > > | 17b | 13 | 4 | 2 |
  > >
  > > **17b measured: ~965,000 for the review lane against ~645,000 for all four tasks' coding.**
  > > Two fresh passes (238,225 + 245,017) plus two remediation rounds in the main session. The
  > > review lane was 1.5× the coding, and the phase closed at ~85% of a stop-loss whose review term
  > > was set with a factor of 1.0.
  > >
  > > ```
  > >           + review term × (1 + 2.0)                        ← measured across 17a and 17b
  > > ```
  > >
  > > **This is not a licence to skip the second pass — it is the arithmetic that makes the second
  > > pass affordable.** On 17b it condemned four fixes, caught two defects the remediation itself
  > > introduced, and found a race fixed on the rare twin and left on the routine one. A stop-loss
  > > that halts before it is a stop-loss that ships all of that.
  >
  > **And the reporting rule, because a caveat did not survive its own summary.** 17a reported "51%
  > of stop-loss" at its T5 boundary with the review term correctly named as unspent — and then said
  > "roughly three times what the phase needs" in prose one paragraph later. The first number was
  > true and incomparable; the second was wrong and quotable. **Report a fraction of stop-loss only
  > at CLOSE. Before that, report the absolute and name what is unspent.**
  >
  > **What the review term bought, so the multiplier is not read as waste:** 447,402 tokens found
  > **2 CRITICAL and 12 MAJOR** in code that had 32 dead mutants, green narrow suites and green CI
  > behind it — including money that silently vanished on the ordinary clinical path — and pass 2
  > found that **three of pass 1's five fixes were themselves defective**. It is the best value per
  > token in the phase, and §2.140's "send the reviewer back" is now proved twice.

  > **AMENDED 2026-08-29 (ledger §2.141, Plan 17 LIMS core) — THE FORMULA HAS A THIRD TERM, AND IT IS
  > THE LARGEST. THE TWO IT ALREADY HAD BOTH MEASURE THE REVIEWER.**
  >
  > Every LIGHT phase since 16a has taken its per-task rate from `token-baselines.json`, and **every
  > row in that file is SUBAGENT tokens** — which in a LIGHT phase means the close reviewer, an agent
  > that wrote none of the code. So `per-task rate × task count` multiplies a REVIEW rate by a TASK
  > count, and the review term then adds the same reviewer a second time. **Neither term has ever
  > contained the main session, which in this lane is where all the coding happens.**
  >
  > Plan 17 measured it: `1.5 × (20,178 × 9) = 272,403` for nine tasks, against **~482,000 actually
  > spent on TWO ROUTINE tasks with zero subagents** — 66% of the whole 730,000 stop-loss before a
  > CRITICAL task or either reviewer had run. Eight times the budgeted per-task figure, on the two
  > cheapest tasks in the phase.
  >
  > **The formula is therefore:**
  > `stop-loss = main-session term + 1.5 × (per-task subagent rate × task count) + one reviewer pass per cycle`,
  > with `main-session term ≈ 200,000 × task count` until better data exists — **one measurement, from
  > one phase, and it is to be revised at every close rather than trusted.**
  >
  > **And the obligation that makes it improvable: a session executing a phase RECORDS ITS OWN TOKEN
  > BALANCE at kickoff and at every task boundary, and writes the deltas into CLOSE.** Runbook O3 has
  > called main-session cost "unmeasurable from inside" since Plan 11e; that is no longer true — a
  > session with a token budget can read its own remaining balance and subtract. It is not `/cost`
  > and it includes harness overhead, and it is a figure where there was none.
  >
  > **THE CONSEQUENCE FOR THE LANE RULING, WHICH MATTERS MORE THAN THE CEILING.** At ~200k per task
  > of main session, a NINE-task full-module build is not one LIGHT phase, it is two. §2 calls that
  > shape LIGHT's *edge*; the arithmetic says the edge is around five tasks. **Cut at a seam the
  > CONTRACT already freezes, so the halves are independently reviewable** — Plan 17's own close
  > recommends T3–T5 (order to accession) and T6–T9 (result to report) on exactly that test.

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

### 9.9 In a LIGHT phase the expensive unit is the VERIFY RUN, not the agent — added 2026-08-28

§9's arithmetic was written for a HEAVY phase, where the bill is agents × context. **A LIGHT phase
has no agents, and the term that replaces them is the verify run.** Plan 07a/07b: twelve commits,
**nine full `pnpm verify` runs**, ~20 minutes each, and rule 12 makes every one of them mandatory —
evidence must match the state committed, so a tree edited after a run cannot cite it.

Two of the nine were pure waste and the ledger names both (§2.129): one paid for a second run to
commit the two halves of a single task that were finished at the same moment, and one launched a run
and then edited the tree while it was in flight, which converted a green result into evidence for a
state that no longer existed. The batched run — three tasks, one verify, one commit that still
separates them in its message — is the shape to copy.

**The two rules this adds to §9.1, and they bind the main session rather than a compiled brief:**

4. **Before launching a verify, read `git status --porcelain` and fold in every task that is already
   code-complete.** The run is the unit of cost; the commit is free. A phase that verifies once per
   task pays its task count in twenty-minute runs.
5. **Once a verify is launched, the tree is frozen until it returns.** Not as discipline — as
   arithmetic. An edit mid-run silently invalidates the only evidence the commit is allowed to cite,
   and the sole honest recovery is to discard the result and pay for the run again.

**AMENDED 2026-08-29 after Plan 07c — THE RUN HAS A CHEAP PREFIX, AND PAYING IT FIRST IS RULE 6.**

Plan 07c paid for **eight verify launches to produce three commits**. Five came back red. One was a
host OOM (unpreventable, correctly re-run rather than explained away) and one was a known
pre-existing flake — but **three were preventable in under two minutes**, and both mechanisms are
now rules because neither is a matter of care:

6. **Run the cheap stages before you launch the expensive one.** `pnpm verify` is
   `typecheck && lint && test`. A launch that dies on an unused variable dies in sixty seconds of
   wall clock and costs the same TURNS as one that dies in the last suite — the launch, the waiter,
   the notification, the log read, the fix, and a fresh twenty-minute run. So:
   `pnpm typecheck && pnpm lint && echo "PREFLIGHT OK"` first, exit value read (ledger §2.132).

7. **A new REGISTRATION moves censuses that a count-grep cannot find.** This repository pins its
   registries on purpose — jobs, manifests, permissions, SPA routes — so that adding one is a
   decision. But several of those pins are written as NAMED ARRAYS rather than counts, and one needs
   a spy and a fake-clock instant besides. `grep "toHaveLength(12)"` found two of the four job
   censuses and none of the extra edits. **Grep for an existing SIBLING's identifier instead** —
   `grep -rn "retentionSweep" apps/core --include=*.ts` — because a sibling's name appears in every
   place the new one must, whatever shape that place is written in (ledger §2.131).

   **AMENDED AGAIN 2026-08-29 (Plan 17 phase 0, ledger §2.138) — A SIBLING'S NAME CANNOT FIND A
   CENSUS THAT DERIVES FROM THE LIST, AND THE RULE NOW HAS TWO HALVES.** The sibling-grep was run
   exactly as written, at directory-and-glob scope, and found **two of five** censuses. The three it
   missed live in `seed-roles.test.ts`, which never writes any manifest identifier at all — it reads
   `ALL_MANIFESTS` and COUNTS. §2.131's premise is that a sibling's name appears wherever the new one
   must; **that premise is false for derived code**, so no grep for a NAME could have found them at
   any scope. They went red in the verify instead.
   **So: grep the SIBLING for the places that NAME it, and grep the LIST for the places that COUNT
   it** — `grep -rn "ALL_MANIFESTS" apps/core --include=*.ts`, which returns all five.

   **AMENDED 2026-08-29, the same day, because the rule was followed and still missed one.** The
   grep must name a **DIRECTORY and a glob**, never a file list. A session that ran
   `grep -rn 'duty_manager' <three files it already had open>` learned nothing it did not already
   know, and a fifth census — `seed-staff.test.ts`'s derived-but-hand-counted `KNOWN_ROLE_KEYS` —
   went red in the verify instead. **A search whose scope is drawn from what you already believe
   cannot correct that belief** (ledger §2.133). If you are typing the second file path, you have
   stopped searching and started confirming.

**AMENDED 2026-08-29 after Plan 17 phase 0 — RULE 8, AND IT IS THE CHEAPEST FIX IN THIS SECTION.**

8. **A LANE THAT SHARES THE CHECKOUT TAKES ITS OWN TEST DATABASES, AND SAYS WHICH ONES IT USED.**
   `test/helpers/db.ts` derives the worker database name from `TEST_DATABASE_URL`, so one env var
   ends parallel-lane contention outright:
   `TEST_DATABASE_URL="postgres://…/hmis_<lane>_scratch" pnpm …`. Measured on this phase: suites
   failing six at a time on FK violations went 154/154 on the first isolated run, and a full verify
   that returned **105 failures — 188 of them 15-second timeouts, at load average 18.70** — returned
   green at 2.35 with nothing changed but the box. The protocol's "queue behind the other session"
   is no longer the only answer, and AGENT-RULES rule 7 already sanctions the scratch database.

   **AND THE OBLIGATION THAT COMES WITH IT (ledger §2.137): NAME THE DATABASE WHERE THE EVIDENCE IS
   CLAIMED** — in the commit message and in CLOSE's mechanical verification. Rule 7 requires the
   database to be dropped in the same task, so by the time anyone audits, the proof is gone: this
   phase's second reviewer opened with a CRITICAL saying the migration had been applied nowhere and
   the evidence could not cover the fixes, on observations that were all true. One clause prevents
   it. Without it, `exit 0` is a claim about a database nobody can look at.

And one that binds the session's own turns: **arm exactly ONE blocking waiter on the exit file and
then stop asking.** Every hand-poll of a long run costs a full context re-read to learn a single
byte (§2.130). If there is nothing to do that cannot touch the frozen tree, that is rule 4 telling
you the run was launched too early.

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

### 9.7 BRIEF THE CLOSE REVIEWER AT THE OPERANDS, NOT THE BRANCHES — added 2026-08-28 (Plan 15 close, ledger §2.128)

Three phases running, the close reviewer has returned more than the phase's own instruments found,
and each time the worst finding was in **what a guard's numbers were summed from**, not in whether
the guard branched correctly. Plan 15 is the cleanest specimen: 22 mutants built, 21 killed, verify
and CI green on eight of eight commits — and one reviewer found that the §269ST cash ceiling could
not see cash taken at discharge, because the quantity it compared was summed only from deposits
*held*. The Assertion Book had a row for that guard. Its mutant died. The row asked whether the
refusal fires, which is the question the plan's author had already thought about.

**So the brief now carries this instruction, first, ahead of the dimension list:**

> For every threshold, cap or limit on a money or safety path: name what the compared quantity is
> summed from, and name one real transaction whose money that sum does not include. Do the same for
> every "already exists" and "already done" check — say what it queries and what writes rows it
> would miss.

Two supporting rules, both cheap:

- **Money file first in the priority order.** Plan 15's brief listed the discharge-bill composer and
  the deposit holds as item 1; the CRITICAL came back in the report's first section.
- **Name the frozen interfaces the phase consumes.** A guard is most often wrong where one module's
  sum is fed by another module's writes, and a reviewer who does not know which interfaces were
  inherited cannot tell a deliberate boundary from an oversight.

### 9.8 A CLOSE-REVIEW FIX IS NOT DONE WHEN IT COMPILES — RUN THE SUITE AND READ THE COUNT — added 2026-08-28 (ledger §2.125, §2.126, §2.127)

Remediation is where a phase's remaining defects concentrate: 09a, 13 and 14 each had their worst
late defect inside the fix for an earlier finding. Plan 15 adds the failure mode from the other
direction — **fixes that are correct and break the fixtures that were quietly documenting their
absence.** Three of its findings did this, and the pattern is mechanical enough to prescribe:

1. **Run the whole suite after each guard, before writing its test, and read the failure COUNT as
   evidence** (§2.125). Zero means the invariant was already enforced — find out by what. Fifty-one,
   as Plan 15 measured for one `force` flag, means it was enforced nowhere and every fixture had
   been exercising a privileged act as somebody who does not hold it.
2. **When the fix adds a second bound on a quantity that already had one, write the inequality
   between them** (§2.126). If the new bound dominates, the old test now certifies a path that
   cannot execute; re-point it at the property rather than leaving it green and meaningless.
3. **When a new invariant makes an existing fixture unconstructable, do not reach for a test-only
   clock or seam** (§2.127). Ask which of the invariants carries the property, and whether the other
   is already covered. A collision between two individually-correct guards is a design finding about
   the pair.

**AMENDED 2026-08-29 (Plan 17 phase 0, ledger §2.140) — A FOURTH PATTERN, AND IT IS ABOUT THE FIX
FOR A DISCLOSURE.** Plan 17's pass-1 CRITICAL was a confidentiality leak; its fix was mutant-verified,
green and CI-green — and pass 2 found the SAME dimension open twice more: the response's `status`
field still implied the hidden row deterministically, and the fix itself turned a caller-supplied
`limit` into a counting oracle (rows filtered AFTER the limit; varying it named the hidden rows'
exact ranks). **So, as rule 4:**

4. **When a fix REMOVES a disclosure, enumerate every OTHER field on the same response that is a
   FUNCTION of the removed one, and every caller-supplied parameter that interacts with the filter.**
   A filter applied at one level of a nested structure is not a filter; a filter applied after a
   limit is a counter. Both of Plan 17's residuals were re-derivations of a boolean the first fix
   had deleted for being too revealing.

**And the budget consequence.** A remediation of this size is not free and must not be priced as an
afterthought: Plan 15's pass-1 remediation touched 31 files, added two migrations and moved the core
suite by +20 tests. The stop-loss covers the REVIEWERS; the remediation is main-session work, and a
phase whose review returns a CRITICAL should expect its close to cost as much again as its tasks did.

### 9.10 THE SECOND REVIEWER IS BRIEFED AT THE FIXES, AND IT IS THE TERM THAT PAYS — added 2026-08-29 (Plan 22c-A close, ledger §2.136)

§6's second budget term has been carried since 09a on the argument that a fix is unreviewed code on
the same path. Plan 22c-A is the first phase to run **two FRESH reviewers** end to end and price the
shape against §2.115's resumed chain:

| | workload | tokens | calls | per call | found |
|---|---|---|---|---|---|
| pass 1, FRESH | 9 commits | 171,587 | 48 | **3,574** | 1 CRITICAL, 4 MAJOR |
| pass 2, FRESH | the remediation only | 133,904 | 47 | **2,849** | 1 CRITICAL, 1 MAJOR |
| *Plan 13 pass 2, RESUMED* | one 7-file diff | 205,365 | 5 | *41,073* | — |

**Fourteen times cheaper per call than the resumed equivalent, nine times more work done, and it
returned a CRITICAL** — the first remediation had fixed a clock-skew hazard with `sql\`now()\``,
which is `transaction_timestamp()`, so the defect survived its own fix. No amount of re-reading the
diff produces that: it is a claim about when Postgres evaluates a function.

**Two amendments, both cheap:**

1. **Brief the second reviewer at the FIXES, never at the phase.** Give it the one remediation
   commit, the findings list with what each fix CLAIMS to do, and require **a verdict per fix —
   CORRECT / INCOMPLETE / WRONG**. That table is what caught both defects; a free-form re-review of
   the whole phase would have re-derived pass 1 and cost pass 1's tokens again.
2. **Tell both reviewers whether another lane is running tests in the checkout, and forbid them to
   run any.** A reviewer's own jest run corrupts the phase's evidence and its own (rule 20). Both of
   this phase's reviewers were told to read only, and both still confirmed migrations, lock order
   and HTTP mappings by reading — the verification depth was not what the restriction cost.

**And the budget line, measured:** two fresh passes came in at **305,491 against a 458,491 review
term — 33% under, with two CRITICALs found.** Price the second pass at roughly the first, not at a
premium; the premium is what a RESUME costs.

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

