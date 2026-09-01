# Execution Lessons — the pipeline's own defect ledger

**What this is.** The durable memory of *how the pipeline itself fails*. Gate reports record what shipped; this file records what it cost to ship it, and what must never cost that again. It is committed to the repo deliberately: it survives sessions, and agents on the build server can read it.

**Binding rule for every session.** Before compiling any pipeline for this repo, read this file AND [`docs/superpowers/AGENT-RULES.md`](../../AGENT-RULES.md), and make every task brief POINT at AGENT-RULES.md as its first instruction — above the goal, not buried in a prose paragraph. A rule an agent skims is a rule an agent breaks: the `/tmp` breach below happened while the prohibition sat as clause five of a nine-line block. Until 2026-08-19 the rules were pasted verbatim into every brief; they are now referenced, because two copies of a rule drift and one does not.

**Write path.** Every gate report ends with a Lessons section; its entries are appended here the same session. No separate ritual.

**Pruning.** Entries carry their cost. Retire one only when the mechanism that made it necessary is gone, **or when it has been merged into a stronger general entry that keeps every specimen** — never because it looks obvious in hindsight. Obvious-in-hindsight is exactly what gets skipped and re-learned. Two consolidations have happened (2026-08-19): §3.14 absorbed §3.14b/§3.14c/§3.32/§3.33 (fixtures that cannot separate), and §3.21 absorbed §3.25/§3.28/§3.39 (tests that claim to observe a lock). Every original specimen survives as a bullet inside its merged entry; nothing was dropped.

---

## 1. The hard rules live in AGENT-RULES.md — not here

**Canonical location:** [`docs/superpowers/AGENT-RULES.md`](../../AGENT-RULES.md), versioned
with the repo. Every task brief POINTS at that file; nothing inlines it any more.

Through Plan 08 pipeline A this section held the rules themselves and every brief pasted them
verbatim. That produced two copies of every rule and no mechanism to keep them in step — the
exact drift §2.7 warns about ("a stated prevention is not a prevention until it is IN THE
ARTIFACT"), one level up. **From 2026-08-19 there is one copy.**

**The division of labour:** AGENT-RULES.md says WHAT the rule is; this ledger says WHY it
exists and what it cost to learn. A rule may only be added to AGENT-RULES.md with a §2 or §3
entry here naming the incident that earned it. A rule may only be removed when the mechanism
that made it necessary is gone, or when it is merged into a stronger rule that keeps every
specimen.

**Rule 22 (the local mirror) is new in v2** and is the only rule ever added here for cost
rather than for correctness — see §2.28 and the method review.

## 2. Pipeline template defects

Project-agnostic — fixed in the pipeline template, so every future project inherits the fix rather than re-learning it.

**THE TEMPLATE'S PATH, because §2.51 caught this entry pointing at a file that no longer exists:** it is
`~/.claude/routing.parked/skills/execute/SKILL.md` as of 2026-08-21 — it moved there when the routing layer
was parked, and `~/.claude/skills/execute/SKILL.md` (which several documents still name) is GONE. Stat it
before you grep it: an empty grep against a missing file reads identically to an empty grep against a
present one, which is §2.42's failure mode in a different tool. If you find this path stale, fix THIS LINE
in the same commit as the template — otherwise §2.7's own remedy rots the way it exists to stop things rotting.

**2.1 — Infrastructure failure must never consume a defect attempt or escalate the tier.** *(Plan 02, T5, ~168k tokens)*
Two consecutive gate agents died on `API Error: 529 Overloaded`. The template treated a dead gate identically to a gate that said *no*: it re-ran the **coder**, then escalated to heavy-coder, then gated again — three agents to re-verify work that was already correct and already committed. Fixed: a dead gate now re-gates **the same coder report** without re-running the coder; a dead coder retries the **same rung** of the ladder. Neither advances the ladder, and neither promotes the tier. Infra retries are capped separately so a genuinely unavailable model still halts the chain.

**2.2 — Retries need a verify-only mode.** *(Plan 02, T4 and T5)*
When a gate's corrections say *"the code is correct — do not re-implement, just prove it"*, the retry prompt still said "the files are in the state the last attempt left them; apply every correction." Both coders then had to manufacture fail-first evidence for already-shipped code: one created and dropped a throwaway database (`hmis_t4_failfirst`), the other temporarily relocated `identity.ts` out of the tree. Both were honest about it and both gates accepted the labelled reconstructions — but the pipeline invited state mutation nobody asked for. Fixed: the gate now sets `retry_mode: "verify-only" | "reimplement"` on its verdict, and a verify-only retry is told explicitly not to rewrite code, not to fabricate a red run by mutating shipped state, and to say so plainly when a legitimate fail-first run is impossible.

---

**2.3 — Never write an acceptance criterion that only the FIRST attempt can satisfy.** *(Plan 02, T4/T5/T11/T12 — the worst finding of the plan)*
Criteria demanding *"a fail-first run was actually performed and its failing output is quoted"* are correct for a first attempt and impossible for a retry, because by then the code is committed and green. Four agents therefore manufactured red states against shipped code: a throwaway database, a relocated source file, a worktree revert — and, worst, **overwriting `guards.ts` and `auth.controller.ts` on the live server with versions that stripped the break-glass bypass and its handlers**, which tripped a security warning. Everything was restored and the final tree was provably intact, but the criteria invited it.
Three fixes, all now in force: fail-first evidence is owed by the **original** attempt and a retry inherits it rather than reproducing it; a gate must never write a correction instructing anyone to delete, strip, or disable security-relevant code (see §1 tripwire 14); and when a red run is genuinely impossible post-hoc, the honest move is a **discriminating mutation-control test** — T10 did this well, showing 0 surviving rows when the event rides the caller's transaction versus 1 for the shipped code, which proves the assertion has teeth without touching shipped state.

**2.4 — A gate correction must never direct a rewrite of published history.** *(Plan 03, T4 retry, ~50k tokens, nothing lost)*
T4's first attempt shipped and pushed `9a9e253`; the gate then correctly failed it for a missing jsonb round-trip assertion — a **genuine code defect** (the plan's verify-by-execution flag ④ claimed T2's `toEqual(DEF_JSON)` covered it, but T4's own suite never asserted it). The gate's correction, however, offered two branches: *if origin has not moved, `git commit --amend` + `git push --force-with-lease`; if it has, a follow-up commit.* The coder took the first branch exactly as written and rewrote a commit that was already on `origin/main` and already CI-green. The blast radius was nil — a one-line test addition, history stayed linear, `bb4f492` remained an ancestor, HEAD matched origin, and both the orphaned `9a9e253` and its replacement `7aeaac1` passed CI — but the harness's classifier correctly flagged it, and on a repo with a second consumer it would have been a real divergence. **The fix is two-sided:** tripwire 15 forbids rewriting pushed history outright, and the gate prompt in `~/.claude/skills/execute/SKILL.md` now forbids writing a correction that instructs it. The only correct shape for fixing an already-pushed commit is a new commit on top — the tidiness of a single clean commit is never worth rewriting public history.

**2.5 — A criterion that pins a test COUNT to a path regex must use a regex the task's own later files cannot match.** *(Plan 05, T4 — a COMPILE defect, mine, not the plan's)*
The brief's criterion said *"`pnpm --filter @hmis/core test -- search` passes with 6 functional tests"*, copied from the plan's Step 4. Jest treats that argument as a **path regex**, and by the end of the task the same task had created `test/perf-patient-search.test.ts` — which also matches `search`. The criterion was therefore satisfiable only in the middle of the task and impossible at its end: the honest final run reports 2 suites / 10 tests. The coder handled it exactly right (quoted the pre-perf 6/6 run as the functional evidence, ran the literal command on the final state too, and named `-- search.test` as the narrowing regex), but the criterion made a correct agent look non-compliant. **This is §2.3's shape in a new place — a criterion only one moment in time can satisfy. When a criterion pins a count to a filter argument, verify the filter cannot match files the task itself adds later.**

**2.7 — A stated prevention is not a prevention until it is IN THE ARTIFACT.** *(Plan 06 → Plan 06.1, found before compiling, 0 tokens)*
Plan 06's cost-ledger row for the weakened gate standard closed with *"Prevention: the isolation requirement now lives in the gate prompt, not only in the brief."* It did not. `~/.claude/skills/execute/SKILL.md`'s `gatePrompt` was never edited, so the fix existed only as a sentence in this file and would have died with that session — the exact failure mode rule 6 of the routing layer exists to prevent, committed by the session that wrote the rule down. Found while compiling Plan 06.1 (by grepping the template for the requirement rather than trusting the entry) and landed before pipeline A fired, so both pipelines carried it. The gate prompt now also forbids a gate accepting weaker evidence than an earlier gate on the same task demanded, which was the underlying Plan 06 failure. **When a lesson's fix is "add it to the template", open the template afterwards and confirm the text is there. A ledger entry describing a fix is not the fix.**

**2.8 — A fail-first criterion must carry its own post-hoc fallback, or infrastructure can make it unsatisfiable.** *(Plan 06.1, T6 — §2.3 recurring, and the only verdict of the plan worth re-examining)*
T6's compiled criterion required *"the manifest test observed RED before g14 existed, with the failing output quoted"* — correct for an original attempt. A network outage then killed T6's coder **after it had pushed**, and the replacement rung (correctly converted to verify-only) could reach that red state only by rewriting a pushed commit (tripwire 15) or deleting/relocating the now-shipped fixture (tripwire 14 in spirit, and named as forbidden manufacture in its own brief). It considered a scratch-worktree re-enactment, rejected it as needing a `pnpm install` against the shared store, and **declared the gap instead of fabricating it**; the gate passed the task on the Assertion Book mutant walk. Both agents behaved correctly and the criterion was mine. **When a fail-first criterion depends on an intermediate state the task itself destroys, write the fallback into the criterion at compile time** — "…or, if a prior attempt already shipped the artifact, the gate re-derives the Assertion Book walk by hand instead." This is §2.3's shape a third time: the first attempt can satisfy it and no later rung can.

**2.9 — Per-file test counts transcribed into a plan are unreliable; measure them immediately before compiling.** *(Plan 06.1 — two of eleven figures wrong; §2.6 one level finer)*
The plan's scout-transcribed per-suite table said `contest.test` had 15 tests (it had **10**) and `tariff.e2e` had 7 (it has **6**), while **every workspace total in its ladder was exactly right** and verified at all seven rungs. T4's coder caught the first mid-run and reported its honest final of 14 rather than padding to the plan's 19; I caught the second by measuring every suite on the server before compiling pipeline B, which is the only reason T7's "9 tests" criterion — unsatisfiable by any correct implementation — never reached an agent. **Measure per-suite baselines on the server right before compiling, paste the measurements into the briefs, and state explicitly that the measurement beats the document.** Otherwise a correct agent burns tokens proving it is correct, or — far worse — pads or splits a test to hit a number.

**2.10 — Two agents running this repo's test suite concurrently CORRUPT each other's evidence.** *(Plan 06.1 post-ship audit — found the cheap way, nothing shipped wrong)*
The per-worker test database name derives from `JEST_WORKER_ID`, which is per-process and therefore **collides across agents**. Two auditors running in parallel had one agent's `truncateAll` break the other's measurements mid-run; the failures carried an unmistakable signature (`unknown SoD pair key: workflow_drafter_activator`, `approval … was decided concurrently`) and vanished on isolated re-run, but one agent lost two experiment rounds. **A race-flake measurement corrupted by another agent's truncate is indistinguishable from a real flake** — which is precisely the confusion §3.21 cost a retry over. Before running audits, scouts, or a second pipeline concurrently with anything that runs tests, either serialize the test runs or give each agent a distinct database namespace. Note the pipeline itself is safe by construction (tasks are sequential); the hazard appears the moment something runs *alongside* it. **Promoted to tripwire 20 on 2026-08-15.**

**2.11 — A scout's deliverable exists ONLY in its final message; transcription scouts that emit progressively and then summarize lose the payload.** *(Plan 06.2 authoring, 2026-08-15 — ~267k scout tokens spent on recovery)*
Two haiku transcription scouts returned final reports reading "previously transcribed in the first batch above" and a tail fragment of one file — the transcriptions had been emitted as intermediate messages, which are DISCARDED; only an agent's final message reaches the requester. Both were resumed with an explicit correction; one then failed the same way a second time (re-sent one of five requested files plus repeats), and the remaining four files were re-fetched by a sonnet scout whose brief carried an explicit output protocol. **Every scout brief must state, as a numbered hard rule: "Only your FINAL message reaches the requester — intermediate output is discarded. Gather everything FIRST, then emit ONE final message containing the complete deliverable. Never write 'previously transcribed', 'see above', or a summary in place of content."** Haiku handles transcription volume fine; the failure was in the brief, not the model — but until the protocol line is standard, prefer sonnet for multi-file transcription where a silent partial return would poison a plan.

**2.12 — A chain-halt rule for a surviving mutant must distinguish "the shipped code is wrong" from "the plan's test cannot discriminate".** *(Plan 06.2, T2 — ~185k tokens, my compile defect riding on a genuine plan defect)*
The brief's mutant-discipline block said flatly: *a mutant the plan marks "required DIED" that SURVIVES is a CHAIN HALT — stop, do not fix it silently, report it as a plan defect.* T2's coder obeyed it exactly: Mutant A (activation serializer deleted) SURVIVED 5/5 against the plan's Test 1, so it committed nothing and reported. The gate independently reproduced the SURVIVED, agreed it was a real plan defect, failed the task on unmet criteria, and issued a correction — which the coder could have applied itself, because **T2's only file IS the test**, so the fix was inside its own scope the whole time. One coder rung and one extra gate bought a conclusion available one rung earlier.
**The owner's own framing was finer than my brief's:** *a disclosed defect fixable within the task's own scope may be fixed minimally in-task; anything larger halts the chain.* Both halves matter. A survivor must never be silently fixed — that is how a non-discriminating test survives three reviews (§3.25). But **the halt should trigger on what the survival implies, not on the survival itself**: if the shipped implementation is wrong, or the fix reaches outside the task's Files list, halt; if the plan's *test* cannot discriminate and the test is the task's own file, that is a disclose-and-fix-minimally case. Write both branches into the mutant block, and require the disclosure either way. Note the rule still earned its cost: firing loudly and stopping is the correct failure direction, and the ~185k bought the catch of the run (§3.28).

**2.13 — The §2.8 fail-first fallback needs a PROVABLE precondition, or it becomes a way to skip fail-first entirely.** *(Plan 07, T6 — 0 tokens, discharged by the gate)*
§2.8 gave every fail-first criterion the escape hatch *"…or, if a prior attempt already shipped the artifact, the gate re-derives the Assertion Book walk by hand instead."* T6's coder invoked it and skipped fail-first altogether — reading four dead session-limit rungs as "a prior attempt". But those rungs **shipped nothing**: the precondition was simply false, and plan line 106 ("fail-first evidence is owed by the ORIGINAL attempt") still owed a red run to the attempt that actually did the work. The gate discharged the fallback itself — re-derived the Assertion Book rows and rebuilt all three mutants — and by then no remediation was possible without rewriting pushed history (tripwire 15), so the task stood.
**The hole is that the precondition is a judgement call stated in the passive voice.** "A prior attempt already shipped the artifact" is checkable in exactly one way, so the criterion must demand it: **the fallback may be invoked only by NAMING THE COMMIT that already contains the artifact.** Absent that SHA, fail-first is owed and its absence is a violation, not an interpretation. A dead rung is not a prior attempt; a pushed commit is. Write the named-commit requirement into every fail-first criterion at compile time — an escape hatch whose trigger condition cannot be audited will be taken whenever the honest path is expensive.

**2.14 — Frozen-path rules govern COMMITTED changes; say so, or mutant scratch has nowhere legal to live.** *(Plan 07, T3 — 0 tokens, nothing shipped wrong)*
The mutant-discipline block says mutants are separate scratch files "beside the source". T3's source lives in `modules/patients/`, a **frozen** directory, so obeying the mutant block meant writing `registration.mutantD.ts` into a path the frozen-path rule forbids. The coder built it there, never committed it, and deleted it before counting; the tree was clean and the gate ratified it. But the two rules contradict each other as written, and the next agent may resolve the contradiction the other way — by skipping the mutant.
**Resolution, to be written into every brief:** frozen-path rules constrain what may be **committed**; transient mutant scratch that is never committed and is deleted before the workspace count may sit beside the source even in a frozen directory — but prefer a non-frozen location when one exists. The invariant that actually matters is the one the gate can check: `git status` clean, no `*.mutant.*` residue, no frozen path in the diff.

**2.15 — A compiled pipeline script must be DRY-RUN, not merely syntax-checked: `node --check` cannot see an undefined identifier.** *(Plan 07 pipeline B, first launch — 0 tokens, caught in 140 ms)*
Pipeline B was compiled by splicing: `head -236` of pipeline A's script (the shared blocks) + a freshly authored `TASKS` array + `tail -n +719` (the machinery). Line **717** — `const AGENT_FOR = { sonnet: 'coder', opus: 'heavy-coder', haiku: 'runner' }` — sat in the seam between the two cut points and was silently dropped. The pre-flight was the prescribed one and it passed cleanly: `node --check` said OK, and a render harness printed all four briefs with the tripwire block verbatim and `${PIPESTATUS[0]}` un-interpolated. **Neither could have caught it.** `AGENT_FOR` is not a syntax error, it is a runtime `ReferenceError`; and the render harness only evaluated the file's HEAD region (up to `REPORT_SCHEMA`) to reach `TASKS`, so it never executed `runTask`, which is the only place `AGENT_FOR` is read. The workflow launched, threw on the first `parallel[0]`, and returned `0/4 done`.
**Two things worth keeping.** First, the cost was nil and the *dependency edges behaved exactly as designed* — T8/T9/T10 reported `skipped: dependency not done` rather than running against a broken T7, which is the §2.1 ladder protecting a chain from a defect in its own harness. Second, the fix is a standing one: **before firing, execute the WHOLE script with stubbed `agent` / `parallel` / `phase` / `log` and assert every task reaches `done` with an empty `halted`.** The stub returns a schema-shaped object per call and records the roster, so one run also verifies the agent count, the tier→agentType mapping, the label scheme, wave ordering, and that any newly added verdict field actually propagates into the returned report. That last check is not hypothetical: the same dry run is what confirmed §2.7's `findings` fix worked end-to-end rather than merely being present in the schema.
**The general rule: a pre-flight that does not RUN the code path cannot vouch for it** — which is tripwire 21's argument (build the mutant, don't predict it) applied to the pipeline's own harness rather than to the code it ships.

**2.16 — A gate finding that names a prerequisite for a LATER task has no owner, and evaporates.** *(Plan 07 pipeline B, T8 → T9 → T10 — the run's most expensive process failure: one CI-red commit and ~1-in-5 verify flakes)*
T8 shipped `kernel/realtime/tail.ts` with a **dormant** shutdown race: `setInterval(() => { void this.poll(); })` discards the promise, `stop()` does not await an in-flight poll, and `poll()` makes two sequential queries, so `pool.end()` landing between them rejects with `Cannot use a pool after calling end on the pool` and nobody owns the rejection. It was dormant because `poll()` early-returns at `if (names.length === 0) return 0;` **before any pool access** — with no router registered, the tail never queried at all. **T9 registered the OPD router and switched a 300 ms poll on in all fourteen AppModule-booting e2e suites.** T8's gate flagged the residual at ship time; T9's gate then confirmed all three mechanism claims from source and wrote, explicitly, *"Recommend a one-file follow-up owning tail.ts, ideally BEFORE T10."*
**Nothing happened, because a recommendation is not a task.** T9's own commit went CI-red on it (`f84f1b1`: all 524 tests passed, the *suite* failed at teardown), T10's retry burned a verify run on it, and jest's habit of attributing an unhandled rejection to *whichever file the worker picks up next* meant it surfaced in three different innocent suites and read as an unrelated flake each time. It was fixed only because the main session read the gate reports afterwards and the owner authorised a remediation task.
**Two rules.** First: **when a gate's findings name work that must happen before a later task, the pipeline is already compiled and cannot absorb it — the main session must either halt the chain or book the follow-up immediately, in writing.** A finding routed to nobody is a finding discarded. Second, the technical half, which generalises past this bug: **a defect can ship dormant and be ARMED by a later task whose Files list cannot reach the fix.** T8 could not have tested it (nothing registered a router yet) and T9 could not have fixed it (kernel/realtime was frozen to T8). When a task activates a code path that a previous task shipped unexercised, that activation is itself a risk worth naming in the brief.

**2.17 — Never prescribe an evidence MECHANISM in a brief without checking it works in this repo's harness.** *(Plan 07 R1 — 0 tokens, caught by the coder with a throwaway probe)*
R1's acceptance criterion required the regression test to capture an unhandled rejection *"EXPLICITLY (e.g. an installed-and-removed process listener)"*. **That mechanism is inert here.** `jest-environment-node` hands each test file a **sandboxed `process`**, while node emits `unhandledRejection` on the real one — jest catches it there, outside the sandbox. The coder proved it rather than assuming: a probe logged `PROBE_DELIVERIES=0` with `listenerCount('unhandledRejection') === 1` after `void Promise.reject(...)` and a 250 ms wait, and the gate independently reproduced it. The shipped listener is decoration, correctly commented as such; the load-bearing capture was moved to **source capture** — a gated `Db` wrapper recording every rejection the tick would have leaked, plus `queries === 2` proving the second query is never issued after `stop()`. That capture is what produced the quoted RED and what killed the rebuilt mutant.
**The lesson is §3.20's shape ("never assert exhaustiveness about a host environment you have not executed") applied to an instruction rather than a fact.** A brief that names *how* to obtain evidence is making an executable claim about the harness, and it inherits the same burden as any other claim: **suggest the property to prove, not the API to prove it with — or verify the API first.** Prescribing an inert mechanism is worse than prescribing nothing, because a less careful agent satisfies it literally and ships a test that observes nothing.

**2.18 — `node --check` on a `.js` file CANNOT see a duplicate declaration, and neither can a `new Function` dry-run: the harness parses top-level bindings LEXICALLY.** *(Plan 07 pipeline C, first launch — 0 tokens, rejected in milliseconds)*
Pipeline C was compiled by reusing pipeline B's script and re-cutting its shared blocks. The `finish()` extraction ran three lines long and carried the head of `brief()` with it, so the assembled script declared **`function brief()` twice**. Every prescribed pre-flight passed: `node --check` said OK, and the §2.15 dry-run completed 6/6 with 114 content assertions green — including "the HALTS block is present in every rendered brief". **Neither could have caught it.** `node --check` on a `.js` file parses **sloppy script mode**, where a duplicate top-level function declaration is perfectly legal, and inside the dry-run's `new Function` wrapper the *later* declaration silently wins — which happened to be the correct one, so all six rendered briefs were right and nothing looked wrong anywhere. The workflow harness parses top-level bindings **lexically**, the way a module does, and refused the script at launch with `Identifier 'brief' has already been declared`.
**The fix is a third pre-flight step, and it must be proved to discriminate.** Rewrite the script's single top-level `return {` into a binding and let node parse the result as an **ES module** (`node --check foo.mjs`); a duplicate declaration is then a SyntaxError. Prove the probe works by appending a duplicate and watching it fail — a probe nobody has seen fail is tripwire 21's problem in a new place, and the first version of this one was **inert**: `"use strict"` inside a `Function` body does NOT reject duplicate function declarations, only lexical top-level scoping does.
**Note the clean division of labour, confirmed by control:** the module-parse probe catches duplicate declarations and CANNOT catch a dropped constant (a `ReferenceError` is not a parse error — §2.15's `AGENT_FOR`); the dry-run catches the dropped constant and cannot catch the duplicate. **Both are required, and neither substitutes for the other.** §2.15 said "a pre-flight that does not RUN the code path cannot vouch for it"; this is its converse — *a pre-flight that runs the code path in a DIFFERENT PARSE MODE than the harness cannot vouch for it either.*

**2.19 — A dead constant in a compiled brief template is invisible; assert the RENDERED brief, not the constant.** *(Plan 07 pipeline B, found while compiling C — 0 tokens, no known harm)*
Pipeline B's script defined a full `HALTS` block — the migration rule, the frozen-path halt, the refuse-to-force-push rule, the scope-drift boundary — and **never referenced it.** `brief()` concatenated `[TRIPWIRES, PLAN_REF, BASELINE] + parts + [EVIDENCE, MUTANTS, FROZEN, DEVIATIONS]`. The halt conditions reached B's four agents only through whatever inline mentions their individual task bodies happened to carry. Nothing failed, and it would have gone unnoticed indefinitely had pipeline C not reused the script.
**A constant that exists is not a constant that ships.** The dry-run must assert, per task, that each named block's marker text appears in the RENDERED brief string — `b.includes('HALT CONDITIONS')`, not `typeof HALTS !== 'undefined'`. This is §2.7's rule ("a stated prevention is not a prevention until it is IN THE ARTIFACT") applied one level down, to the artifact the agent actually reads.

**2.20 — A task that GENERATES A MIGRATION mutates shared host state that `git checkout` cannot undo, and the pipeline has no rollback for it.** *(Plan 08 pipeline A, T1 — the run's blocking failure: ~934k tokens, 0 of 6 tasks delivered)*
T1's first attempt ran `db:generate`, let the test suite's own `migrate()` apply the new `0011` into all seven per-worker databases, then deleted the file when the attempt unwound. **The source tree reverted; the databases did not.** What remained on the host: fourteen orphan billing tables in `hmis_test_1..7`, three orphan FK constraints pointing into `patients`, and a phantom `drizzle.__drizzle_migrations` row (`created_at 1787067914989`) matching no journal entry. The consequence is the part worth remembering — **`origin/main` itself went RED on the build host**, with no commit anywhere containing the cause: `truncateAll`'s *shipped* patients statement now fails with `cannot truncate a table referenced in a foreign key constraint` because a table no commit contains still references `patients`. Reproduced independently three ways (the coder's run, the gate's run on `patients/allergies.test.ts`, and the main session's detached run on `kernel/db/schema/events.test.ts` — exit VALUE 1 read from a file, failing at `test/helpers/db.ts:69`).
**Every remedy the rules allow was closed at once**, which is what makes this a template defect rather than an agent error: a delta migration is a third migration (owner halt condition), hand-editing `_journal.json` is barred by the plan's own verify-by-execution flag, hand DB create/drop is barred by tripwire 7, and the DDL repair was denied by the permission classifier. The agent halted correctly and burned two further rungs proving it had to.
**Three rules.** (a) **Treat "generate a migration and let a suite apply it" as an irreversible mutation of shared host state, not a source edit** — a migration task's brief must name its rollback path BEFORE the generator runs, and the ladder must know that a failed migration rung leaves debris. (b) The cheapest rollback that breaks no existing rule is **re-pointing the base database name in the git-ignored `apps/core/.env` `TEST_DATABASE_URL`**: `test/helpers/db.ts`'s `ensureWorkerDatabaseExists` then has the SUITE create clean per-worker databases and migrate them from `0000`, which is exactly the behaviour tripwire 7 protects rather than the hand-created database it forbids. It is additive, enters no commit, and needs no new permission — but it abandons the corrupt databases rather than repairing them, so the repair (dropping the orphan tables and the phantom migration row) is still the option that leaves the host consistent with git. (c) **A pipeline whose first task generates a migration must re-confirm the host is green at the baseline SHA before the second task starts** — otherwise every later measurement in the run is worthless and no one finds out until the counts stop reconciling.

**2.21 — A measured baseline has a SHELF LIFE inside a pipeline that mutates shared state; the brief asserts it as timeless fact.** *(Plan 08 pipeline A — 0 extra tokens, but it made every brief after T1 false)*
The compiled brief said, correctly and with evidence: *"Measured at plan commit 3fadd5f, immediately before this pipeline was compiled, with nothing else running, all three suites GREEN: apps/core 93 suites / 536 tests."* Attempt 1 falsified it within the same run (§2.20), and every subsequent agent still received it as a stated fact, above their own goal. The T1 gate flagged it explicitly: *"the pipeline baseline in the brief is now false."* This is §2.6 one level deeper — §2.6 said do not pin a *SHA*, because sequential tasks move it; the same is true of the *green* the SHA is asserted to have. **Write the baseline with its measurement timestamp AND an instruction to re-confirm: "this was green at <time>; before you trust it, run one cheap shipped suite and confirm the host is still green — if it is not, that is a finding, not your bug."** A number that was true when compiled is not a number that is true when read.

**2.22 — `node --check` on a `.js` file containing a top-level `return` is INERT: it exits 0 on genuine syntax errors.** *(Plan 08 pipeline A compile — 0 tokens, caught by a negative control)*
The prescribed first pre-flight passed a compiled script whose `SEP` constant held a raw newline inside a single-quoted string — an unambiguous `SyntaxError`. The identical construct in a three-line file was rejected (exit 1); inside the full pipeline script it was **accepted (exit 0)**, reproduced deliberately by re-injecting the break into the working script. The §2.18 ESM-rewrite probe caught it correctly. The cause is the pipeline template's own shape: a top-level `return` is illegal in both script and module parsing, so `node --check` takes a different path through the file and stops being a syntax check.
**This extends §2.18's division of labour with a third finding: the `.js` check is not a WEAKER probe than the `.mjs` one, it is a NON-probe for this script shape.** Keep it only as a smoke test; the load-bearing pair is the module-parse probe (duplicate declarations, real syntax errors) plus the dry run (dropped constants, wiring). And the general form of the lesson is the one that keeps recurring: **a pre-flight nobody has watched FAIL is not a pre-flight.** Every probe in the harness now ships with a negative control that must be observed to fail in the same run.

**2.23 — What the ladder got RIGHT under a total failure, worth keeping because it is invisible when it works.** *(Plan 08 pipeline A)*
Two protections paid for themselves in a run that delivered nothing. First, §2.1: `gate:t1#1` died on `API Error: Server error mid-response`, and the ladder **re-judged the same coder report** instead of re-running the coder — the infra retry consumed no defect attempt and promoted no tier, exactly as designed. Second, a wave-stall guard added at compile time (`if the wave did not complete, break`) stopped T2–T6 from launching against an undelivered T1 in a strictly sequential chain; without it, five tasks would have run against a broken host and a missing schema, at roughly the cost of the whole pipeline again. **In a sequential pipeline, an explicit wave-stall break is not redundant with dependency edges — the edges mark later tasks `skipped`, but the break is what stops the run from spending its budget discovering that.**

**2.24 — A PARTIAL plan amendment is worse than none: the corrected section and the stale per-task prose disagree, and four separate gates each paid to rediscover it.** *(Plan 08 pipeline A run 2 — 0 tokens lost, but flagged as a finding by the T2, T4, T5 and T6 gates independently)*
Ruling R5's amendment corrected the plan's *Test-count ladder* section and every passage naming the truncate design — and did not touch the twelve per-task `Step N: Run to pass` lines or the twelve per-task acceptance lines, which still carried the old numbers. So Task 4's Step 4 said "Core 105 suites / 619 tests" while the amended ladder said 106/623 and measurement said 106/623. Each gate reconciled it correctly and each wrote a finding about it; none was harmed, and all four were right to spend the words. **The rule: when you amend a value in a plan, grep the WHOLE document for every occurrence of it before committing — the section that "owns" the value is never the only place it appears.** This is §2.19's argument ("assert the artifact, not the constant") applied to plan amendments rather than to brief templates, and it is cheap to prevent: the amendment commit should end with a grep whose output is empty.

**2.25 — A brief's FROZEN-PATH block can contradict the very Files list it ships beside.** *(Plan 08 pipeline A, T1 — 0 tokens, flagged by the gate as a wording defect that a stricter gate could have failed the task on)*
The compiled frozen-path block read `apps/core/src/kernel/**` — "byte-frozen, with EXACTLY TWO exceptions … Nothing else in kernel, ever", naming the schema barrel and the truncate helper. But T1's own Files list *requires creating two brand-new files inside kernel*: `src/kernel/db/schema/billing.ts` and its test. A literal-minded agent reads a halt condition; a literal-minded gate reads a violation. The T1 gate resolved it the sensible way (the exceptions clause governs *modifications* to shipped kernel files; creating the module's own schema file is the task's whole point) and recorded it rather than failing on it. **The rule: generate the frozen-path block's exception list FROM the tasks' Files lists at compile time, never hand-write it alongside them.** Two hand-maintained lists of the same fact drift by construction — which is §3.1's "the Files list must name every file its Steps touch" seen from the other side.

**2.26 — A mutant that dies at TYPECHECK proves nothing, and a strict tsconfig makes that the default failure mode.** *(Plan 08, T2 — caught by the gate on its own first mutant build)*
The T2 gate's first `M-B01` build failed with `TS2532: Object is possibly undefined` on `lines[0].gst.rateBps`, because this repo compiles with `noUncheckedIndexedAccess`: any mutant that indexes an array literal dies at the compiler, before a single assertion runs. A DIED verdict recorded from that run would have been worthless — the test never executed. **This is §3.23 ("a fail-first red that cannot compile proves nothing") applied to mutants instead of to fail-first tests, and it is more dangerous there, because a mutant is *supposed* to fail and the report format asks only for DIED/SURVIVED.** The rule: **a mutant kill must be evidenced by the ASSERTION's own failure — quote expected vs received — never by a non-zero exit alone.** A gate that accepts "DIED, exit 1" without the expected/received pair has accepted a typecheck error as proof of discrimination.

**2.27 — When a plan makes a file PURE and later assigns it SQL readers, the contradiction is detectable at authoring time and will otherwise be rediscovered once per consuming task.** *(Plan 08, T5 and T6 — both handled correctly, both cost a disclosure paragraph and a gate ruling)*
T2 shipped `billing-purity.test.ts` with `settlement.ts` in its `PURE_FILES` sweep (no `kernel/` import, no `await`). T5's Files list then said "Modify `settlement.ts` — add `outstandingOf`, `invoiceSettlement`", and T6's said "add `advanceOf`". Mutually exclusive. Both coders reported it as a plan defect instead of quietly relaxing the purity list, kept `settlement.ts` byte-pure, and put the readers in the files that own the rows. Both gates ratified, and T6's gate noted it was now "two tasks old and will recur". **The authoring check is mechanical: cross-reference every file named in a purity/lint sweep against every LATER task's Files list, and reconcile before the plan ships.** The standing resolution adopted here generalises: **a derived-state reader belongs in the module that owns the rows it reads, not in the file that owns the pure function it feeds.**

**2.28 — ARCHIVED 2026-08-27 (Plan 14 close, v3 §5): there is no remote build host and no mirror — see ARCHIVE at the foot.** ~~THE SSH TAX: on a remote build host, code NAVIGATION becomes the largest single cost in the pipeline, and nothing in the process makes it visible.~~ *(Measured across Plans 02–08 in the 2026-08-19 method review; the largest cost finding in this file)*
Coders are **67%** of a pipeline's tokens. Measured across the three largest coder agents in Plan 08 pipeline A: of **318 Bash calls, 234 were SSH round-trips that were neither test nor git** — **65 grep, 48 file read, 13 list/count**, about **42 pure code-navigation round-trips per agent**, median command length 122 characters. Native `Read`/`Grep`/`Edit` were used **30 times in total across the same three agents.**
The cause is structural rather than agent behaviour: the build host is remote, and the rules that (correctly) protect the owner's Windows checkout and forbid POSIX paths in `Write`/`Edit` leave SSH as the only way to touch a file. So every read, every grep and every write becomes a one-command round-trip whose command AND full output land in the agent's context. **Nobody saw it because no report has ever broken cost down by tool call** — the gate reports counted agents, tokens and wall clock, all of which looked ordinary.
**The fix is rule 22:** pull the tree ONCE into a local scratch mirror (~7 MB without `node_modules`/`.git`), navigate and author natively there, push the changed files in one `scp` whose list IS the task's Files list, confirm the sync landed by checksum, and keep every evidence-producing action — migrations, tests, `pnpm verify`, git, commit, push — on the server where CI parity lives. One round-trip replaces about forty-two. **The general lesson is not about SSH: it is that a process can grow a dominant cost that none of its own instruments measure.** Break cost down by tool call at least once per plan.

**2.29 — Agents were carrying a 248-tool MCP roster they never once called.** *(Plan 08 pipeline A, measured 2026-08-19)*
Every one of the twelve pipeline agents received two attachment records totalling ~44 KB (~11k tokens) enumerating **248 distinct MCP tool names** across six servers — claude-mem, n8n, hetzner, github, composio, claude-in-chrome. Across all twelve agents there were **zero MCP tool calls of any kind.** That is ~**132k tokens per pipeline (~5.4%)** of roster nobody read.
The tempting conclusion — "wire the memory server in so at least it earns its keep" — is also wrong, and worth recording so it is not tried: claude-mem stores **main-session narrative** ("Plan 06 post-ship audit: 4 critical findings"), not task context. A coder implementing one task gains nothing from it and would pay search round-trips to discover that. **Memory earns its keep for the session that spans sessions, not for an agent inside a single task.** Give pipeline agents a restricted tool set; keep the memory server for the main session.

**2.30 — Route models by the KIND of judgement a task needs, not by its size — and check the rejection data before dropping a tier.** *(Measured across Plans 05–08, 62 tasks)*
The intuition "sonnet gets rejected, stop using it" does not survive the numbers: **sonnet 5 rejections in 34 tasks (15%), opus 3 in 28 (11%)** — four points apart — and the single worst task in the whole series (Plan 05 T6, **three** attempts) was **opus**. Sonnet tasks also cost less (165k–266k against opus's 181k–368k on comparable work), so even pricing in the higher retry risk sonnet is the cheaper expected cost.
**But the rejections are not randomly distributed, and that is the finding.** All five sonnet rejections were the same failure mode: *the test did not discriminate* — Plan 05 T13 (a framework second-cause produced the observable), Plan 07 T14 (the harness flattened the status code, plus a vacuous absence assertion), Plan 07 T16 (fixture discipline). Not one was "sonnet wrote bad code". **So the rule is: opus wherever correctness rests on proving an assertion has teeth — fixture design, mutants, races, absence assertions; sonnet for everything else, including most implementation.** Plan 07 broke exactly this rule by putting two fixture-discrimination tasks on sonnet, and paid for both.

**2.31 — The per-task gate stopped being a REJECTOR and became a DISCOVERER, and we kept paying rejector prices.** *(Plans 07–08, measured 2026-08-19)*
Twenty-two consecutive tasks with **zero gate rejections** — Plan 07's 16/16 first pass, Plan 08 pipeline A's 6/6 first rung — while the gate cost **a third of every pipeline** (33% of tokens, 273 of 920 tool calls in Plan 08 pipeline A). Re-running every suite and re-checking every criterion is the expensive half of the gate's job, and it is the half that has produced nothing for two plans.
It is emphatically not idle: the same gates produced **54 findings** in one pipeline, including the lock-mode discovery now in §3.21, an independently rebuilt confirmation that an Assertion Book row named a non-discriminating instant, and two plan defects. **Those are a different job at a different price.** v2 splits them: a ~5k **mechanical check** on every task (detached `pnpm verify` with the exit value read from a file, `git show --stat` against the Files list, frozen-path grep, CI by SHA, clean tree) which the main session already does and does better because it is genuinely independent; a full per-task gate **only on CRITICAL tasks**; and **one discovery reviewer per pipeline** reading all the commits together. That last is an upgrade, not a downgrade: the findings that mattered most — a defect shipped dormant by one task and armed by another (§2.16), a convention six screens honour that no test protects (§3.34) — are **cross-task** findings a per-task gate structurally cannot see.
**The general rule: when a control stops firing, ask whether it changed jobs before you either delete it or keep paying for it.**

**2.32 — The MECHANICAL-CHECK prompt inherits NONE of the rules the coder and gate prompts carry, and the pre-flight cannot catch it.** *(Plan 08 pipeline B, T12's checker — 0 tokens, one rule-3 breach on the build host)*
EXECUTE-METHOD v2 introduced the sonnet mechanical check for ROUTINE tasks. `mechanicalPrompt()` is built from persona + task body + criteria + coder report + the seven-item checklist, and **nothing else**: no pointer to AGENT-RULES.md, no frozen-path list, no mirror workflow. The coder and gate prompts all render `brief()`, which carries all three. Observed consequence: T12's checker wrote `/tmp/t12-verify.log`, `/tmp/t12-verify.pid`, `/tmp/t12-verify2.log` and `/tmp/t12-verify2.exit` **to the build host's `/tmp`** — the absolute prohibition of rule 3, the same breach that cost ~100k tokens in Plan 02 T1. It deleted them and disclosed them; it was simply never told the rule. **The pre-flight could not have caught this**: its shared-block assertion iterates `coders.concat(gates)`, so checks — and the discovery reviewer — are excluded from that guarantee by construction. Two fixes, both owed before pipeline C compiles: render the rules pointer into `mechanicalPrompt` too, and widen the pre-flight's shared-block assertion to **every agent the script spawns**.

**2.33 — The CI item of the mechanical checklist is UNRUNNABLE from the build host, and four commits shipped CI-red because of it.** *(Plan 08 pipeline B, T7–T10 — found two sessions late)*
Checklist item 4 says `gh run list --commit <sha>`. `gh` is not installed on `root@62.238.106.231`, the repo is private, and the anonymous API answers 404 — so every reviewer that has ever run this checklist has silently skipped its only check of the thing CI actually measures. It went unnoticed until pipeline B's own compile commit `36592a6` added `plan-08-pipeline-B.preflight.js` under `docs/`, `pnpm lint` failed on it (`no-require-imports` ×2, `no-unused-vars` ×1), and **T7, T8, T9 and T10 each shipped and passed an opus gate with CI red**. The billing code was never at fault. Note the shape: **the pipeline broke the build with a file it added in order to document itself.** Fixes: install and authenticate `gh` on the build host, or state in the checklist that CI is discharged by the main session and have the main session actually do it every time — and lint the pipeline's own scripts before committing them, or exclude them deliberately and say so (`d2d8371` chose the latter, so `docs/**` is now unlinted).

**2.34 — A PRE-FLIGHT THAT ASSERTS MARKERS PROVES PRESENCE, NEVER CORRECTNESS.** *(Plan 08 pipeline C compile, 2026-08-20 — found by a parallel read-only session, 0 tokens of rework because it was caught before the run)*
The compiled T13 brief said *"Design context: D5 (the counter flow), D10 (the wedge scanner)."* **D5 is "Document series — per-FY, row-locked, ≤ 16 chars"; D10 is "What this plan deliberately does NOT build."** Neither has anything to do with a counter screen or a scanner — the wedge lane is owner ruling 5 in the plan header plus Task 13's own Step 2. The pre-flight **passed**, because it asserted that a marker string existed, not that the cross-reference it contained resolved to anything. Every one of the 40-odd assertions was a `indexOf(marker) !== -1`.
Impact was low while briefs are read whole by agents that then open the plan anyway — but it becomes severe the moment anything AUTOMATES on those edges (a per-agent plan bundle keyed on the declared design sections would have shipped "Document series" and "what we don't build" to the flagship money screen). **The rule: for every cross-reference a brief makes into another document, either the pre-flight RESOLVES it or a human reads it. A marker assertion is a spell-check, not a fact-check.** Fixed in the artifact: the pre-flight now asserts no brief opens its design context with the two known-bad numbers, and that T13's clause names the five sections that actually govern the screen.
**Two corollaries, both earned the same day.** (a) The audit that found this ALSO produced a false positive — it reported T14 declaring no design context at all, because `grep -o "Design context: [^.]*\."` cannot match across the `\n` inside a JS string literal. T14's clause was there and correct. **Audit compiled briefs against the RENDERED prompt, never the source file.** (b) Two of this pre-flight's own marker assertions failed on first run for the identical reason — the marker spanned a line wrap in the brief text. Same trap, three times in one day, in three different tools.

**2.35 — THE FIRST RULE REMOVAL: mutant run counts drop from 3× to one kill plus one CONTROL.** *(Plan 08 pipeline C, owner ruling 2026-08-20)*
The plan prescribed *"3× each"* for all eleven pipeline-C mutants (T13 Step 5, T14 Step 3, T15 Step 3, T16 Step 4) and the compiled briefs faithfully transcribed it — so this was never an unwritten ritual, it was a plan instruction, and overruling it is a deliberate act rather than a cleanup. What the rules actually require: AGENT-RULES rule 21 asks for *"DIED or SURVIVED with counts"* and names no number; the run-count-as-FLOOR rule (§2 evidence discipline item 3) is scoped to rows the plan marks `*measure*`; and **pipeline C contains no `*measure*` row — K37–K47 are all deterministic assertions.**
The substantive argument for the change, not just the token one: **three identical failing runs cannot separate "died because the assertion caught the mutation" from "died because a fake timer, jsdom, or an unrelated flake broke."** They repeat the ambiguity. A CONTROL run resolves it — the byte-identical scratch spec with only its import repointed at the SHIPPED module, observed to PASS. Both coders on the 2026-08-20 money fixes invented that control unprompted and it is what made their kills credible; the second one wrote it down as *"so both mutant modules compile and run, and the failure is the guard's assertion and nothing else."*
Net: 33 isolated runs → 22, with strictly stronger evidence. **METHOD-REVIEW §3.1 observed that no mechanism in this process ever REMOVES a rule. This is the first removal.** Treat it as an experiment and measure it: the pipeline C notes must record whether any kill was ambiguous in a way a third run would have resolved. If one was, this entry is wrong and 3× comes back.

**2.36 — §2.35's REMOVAL SURVIVED ITS FIRST TEST, AND THE CONTROL RUN EARNED ITSELF BACK THE SAME DAY.** *(the billing read-projection fix, 2026-08-20 — the measurement §2.35 said would decide it)*
§2.35 replaced the plan's "3× each" with one kill run plus one CONTROL run, and said to record whether any kill turned out ambiguous in a way a third run would have resolved. The very first task run under the new rule answered it, in the direction the rule predicted.
Round 1 of that task's mutants produced two apparently perfect kills — M-P1 and M-P2 each reported `Test Suites: 1 failed, 1 total` / `Tests: 1 failed, 1 total`, which is exactly what a kill looks like. **Their CONTROLS failed identically**, and the real failure was `expected 201 "Created", got 400 "Bad Request"` at `registerPatient`: the scratch harness had never seeded `registration_config 'main'`. The harness was broken; the assertions had caught nothing. The coder disqualified its own round, fixed the harness, re-ran all six, and disclosed the whole episode rather than reporting the first-round kills.
**Under the old rule those two would have been recorded as confident kills three times over.** Repetition repeats the ambiguity; it cannot separate "the assertion caught the mutation" from "the harness broke". A control can, and did, on its first outing. §2.35 stands — and this is the specimen that keeps it.

**2.37 — "PROVES WHICH PERMISSION GUARDS WHICH ROUTE" IS A CLAIM ABOUT 31 ROUTES, AND FOUR IS NOT THIRTY-ONE.** *(the same task's gate, 2026-08-20 — a criterion claiming more than its test can deliver, caught before it could be believed)*
The task was ordered to close §3.42 (a role-less 403 sweep proves a route is guarded, never that it is guarded by the RIGHT permission). Its criterion asked for "a representative set of routes"; the shipped test honestly delivers **4 of 31** — and the coder said so. But the DEFECT was stated as *"nothing anywhere proves WHICH permission guards WHICH route"*, and after the commit **27 of 31 bindings remain unasserted**, including `POST /billing/refunds/:id/pay` — the route that actually CAPTURES the payee identity reference the task was redacting — and `POST /billing/eie`.
Two lessons, and the second is the general one. (a) The remaining 27 are mechanically closable: the 403 sweep already table-drives the route list, so the binding can be table-driven the same way. (b) **When a criterion says "a representative set", write down what the full set is and how many the test covers, in the criterion itself.** Otherwise a task legitimately passes and the ledger entry it was meant to close silently reads as discharged. The gate caught this only because it counted; nothing in the criterion made counting necessary.
Recorded as: §3.42 is NARROWED, not closed. **The remaining 27 were closed on 2026-08-20** — see §3.42's CLOSED note for what closed them and for the three mutants that proved each leg discriminates. Lesson (b) is untouched by that: it is about what a criterion must WRITE DOWN, and it stands.

**2.38 — AN AMENDMENT THAT LEAVES ITS OWN CONTRADICTION STANDING COSTS EVERY LATER AGENT A PARAGRAPH.** *(AGENT-RULES rule 22(f) vs §5 step 0, 2026-08-20 — three agents reported it before it was fixed)*
Rule 22(f) was amended to "you do NOT delete your local mirror and must not try". **§5 step 0 was left reading "…and delete your local mirror."** Both clauses are in the same file, four screens apart. Three consecutive agents — two coders and a gate — each spent part of a report reconciling the two, correctly following 22(f) and flagging the stale sentence. That is the §2.7 failure mode ("a stated prevention is not a prevention until it is IN THE ARTIFACT") in its mirror image: the prevention landed, and its contradiction was left in place. **When amending a rule, grep the file for every other clause that states the old behaviour and fix them in the same commit.** Fixed: §5 step 0 now says leave the mirror alone and delete SERVER-side scratch with `rm -f`.

**2.39 — THE WORKFLOW TOOL RUNS WAVES BACK-TO-BACK, WHICH DELETES THE ONLY WINDOW §2.16's RULE DEPENDS ON.** *(Plan 08 pipeline C, T13's gate → T14 — the finding was correct, specific, actionable, and had nowhere to go)*
§2.16 says that when a gate's findings name work that must happen before a later task, "the pipeline is already compiled and cannot absorb it — **the main session must either halt the chain or book the follow-up immediately**." That rule silently assumes the main session is *between* the waves. In pipeline B it was: the `Workflow` tool was blocked by the permission classifier, so the waves were driven by hand with the Agent tool and the main session sat in every gap. Pipeline C ran under `Workflow`, which runs waves back-to-back autonomously.
T13's gate found that `TenderEditor` takes a REQUIRED `payablePaise` and always renders short/exact/over, so T14's take-advance lane — which has no invoice and therefore no payable — must not be built against `0`; it said so explicitly and asked for the fact to be put in T14's brief. **T14's coder was already running.** `billing-dues.tsx:522` now reads `payablePaise={0}`, and `tender-editor.tsx:75` computes `state = sum === payable ? "exact" : sum < payable ? "short" : "over"`, so every legitimate advance renders "Payable: ₹0.00" and "Over by ₹<the whole advance>". Non-blocking (the component's own docstring says "OVER IS NOT AN ERROR"), no money wrong, and nothing tests it — a misleading label on a money screen, predicted hours in advance by the agent whose job is to predict it.
**The rule needs a mechanism, not an intention.** Either (a) a between-wave hook that lets the main session amend the next brief, or (b) a standing instruction that a gate finding naming a LATER task is written to a known file which every subsequent coder is told to read first. Booking it in the main session's own notes — which is what §2.16 literally asks for — is necessary but demonstrably not sufficient: it informs the report, not the code. **When you automate the loop a rule ran in, re-read the rule and ask which of its steps used to happen in the gap.**

**2.40 — ARCHIVED 2026-08-24 (Plan 11f close, v3 §5): the mirror is gone — see ARCHIVE at the foot.** ~~EVERY AGENT IN A SESSION SHARES ONE SCRATCHPAD, SO EACH "FRESH" MIRROR PULL INHERITS EVERY EARLIER AGENT'S SCRATCH — AND IT PRODUCED A FALSE ACCUSATION OF RULE-BREAKING.~~ *(Plan 08 pipeline C — hit by two agents, one of whom drew a wrong conclusion from it; the most serious PROCESS defect of the run)*
Rule 22(a) says pull the tree into `"<SCRATCH>/mirror"`, where `<SCRATCH>` is "your session scratchpad directory". **Every agent in a session shares that directory.** Rule 22(b) says author in the mirror. Rule 22(f), amended the same day, says never delete it. Compose the three: T14's coder correctly authored `billing-dues.{stub,w5.mutant,w5.mutant.test,w5.control.test,w6.mutant,w6.mutant.test,w6.control.test}.tsx` **in the mirror**, and `tar xzf - -C <mirror>` for every later agent extracts *over* that directory without removing files absent from the archive. So T15's gate and the discovery reviewer both pulled "fresh" trees containing seven files that exist in no commit and were never on the server.
**T15's gate caught it** — `git status --porcelain` empty and `find /opt/hmis -name '*mutant*'` empty seconds later in the same batch, and a second tar not reproducing them — re-pulled into a clean tree, md5-verified the sources, and reported the race. **The discovery reviewer did not**, and concluded from the same seven files that AGENT-RULES §5 step 0 "was not honoured at T14" and that "the local `pnpm verify` behind those two commits could not have been green". It flagged its own uncertainty honestly and could not exclude an alternative; the alternative was this one.
**The main session settled it, and the counts are what settle it:** the gates measured `apps/web` ON THE SERVER at 26 files (T13), 28 (T15) and 29 (T16); the contaminated tree yields 33 files with 2 failing, which is exactly what the reviewer's own reconstruction produced. Its reconstruction was accurate; its attribution was not. The mirror mtimes confirm the sequence — T14's scratch at 23:02 IST, T15's `billing-session.test.tsx` extracted into the same directory at 00:36 IST.
**Why this outranks the wasted paragraphs of §2.38: the failure mode is a confident, evidence-backed accusation that a compliant agent broke a hard rule.** A contaminated mirror makes every NEGATIVE conclusion drawn from it unsound, and negative conclusions ("this file is absent", "this scratch was left behind") are exactly what reviewers draw. **FIXED 2026-08-21, before Plan 08.5 compiles.** AGENT-RULES **22(a)** now requires a mirror directory unique to the agent (`<SCRATCH>/mirror-<taskid>-<role>`, with the retry case stated: a retry of your OWN task reuses your own directory deliberately), 22(c)'s `scp` path moved with it, and a new **22(g)** forbids the inference that actually did the damage: *the mirror is a copy and is not evidence about the server's tree — every claim that a file is present, absent or left behind must be made against the SERVER in the same batch as the claim.* 22(d) guarded the PUSH direction; nothing guarded the PULL, and nothing at all guarded the CONCLUSION.
**One copy of this rule still drifts.** The compiled pipeline brief carries a `MIRROR` block that RESTATES rule 22 rather than pointing at it — the second-copy problem §1 of this file says the v2 referencing change existed to end. Pipeline C's script is a completed artefact and was left unedited (editing it would falsify what its agents actually received); **the next compile must render that block from the amended rule, or reduce it to a pointer.**

**2.41 — §2.35's SECOND AND DECISIVE MEASUREMENT: ELEVEN MUTANTS, NO AMBIGUOUS KILL. THE REMOVAL STANDS.** *(Plan 08 pipeline C — the experiment §2.35 opened and told this pipeline to close)*
§2.35 replaced the plan's "3× each" with one kill plus one CONTROL and required pipeline C's notes to record whether any kill was ambiguous in a way a third run would have resolved. Across W-1…W-11 plus nine unprompted mutants built by the gates and the discovery reviewer, **not one kill was ambiguous**: every kill quoted the ASSERTION's own expected-vs-received (never a bare exit code, never a typecheck death — §2.26), and every one carried a passing control proving the harness was sound.
**The one ambiguity that did arise proves §2.35's argument rather than denting it.** T14's gate's first full `pnpm verify` exited 1 on three `opd-lifecycle.e2e.test.ts` failures. Three identical re-runs would have reproduced it identically for about thirty minutes and then stopped — repeating the ambiguity, which is precisely what §2.35 says repetition does. What resolved it was DIAGNOSIS: `git diff --stat 7015fbc b81e127 -- apps/core packages/` empty, plus the suite's own docstring naming the window (see §3.41). Net 33 prescribed isolated runs → 22, with strictly stronger evidence. **The first rule ever removed from this process has now survived two independent tests.**
**THIRD TEST, Plan 08.5 (2026-08-21): no ambiguous kill either.** Thirteen mutants across T1, T3 and T4 (M-T1, M-H1, M-D1..M-D5, M-A1..M-A6) all DIED with expected-vs-received quoted from the assertion and a passing control; both opus gates rebuilt mutants of their own and re-killed them. The two NON-kills the run produced were both genuine discoveries rather than ambiguities a third run would have resolved: **M-S2 SURVIVED** a census that asserts a set (§2.57), and T4's gate found that the Book's literal M-A1 shape (**target** dropped) SURVIVES while the whole-clause version dies — so the Book's stated outcome named a mutant the Book's own wording did not describe. A control separates a kill from a broken harness; nothing separates a wrong Book row except building it, which is rule 21.

**2.42 — `gh run list --commit <SHORT SHA>` RETURNS EMPTY WITH EXIT 0: THE CI CHECK FAILS SILENTLY GREEN-ISH.** *(Plan 08 pipeline C, main session — caught on the first use, 0 tokens)*
The mechanical checklist's CI item is `gh run list --commit <sha>`. Given a **short** SHA it matches nothing, prints nothing, and **exits 0** — it does not error. Only the full 40-character SHA matches. A reviewer who pastes the short SHA everyone else uses in prose gets silence and reads it as "nothing to worry about". This is §2.33's shape one turn further in: there the CI item was unrunnable on the build host and silently skipped; here it is runnable, run, and silently answers about no commit at all. **Always pass `git rev-parse HEAD`, and treat an EMPTY `gh run list` as "not checked", never as "not failing."**

**2.43 — A CRITERION CAN DEMAND THAT AN AGENT RESTATE A DEFECT THAT HAS SINCE BEEN FIXED.** *(Plan 08 pipeline C, T14 and T16 — §2.38 recurring, inside the artifact whose own header cites §2.38)*
The compiled CARRIED block states as **item 4** that `GET /billing/receipts` returns the raw receipts row including `panNumber` and that `GET /billing/refunds` returns raw `payeeIdRef` — and as **item 9, in the same brief**, that both were FIXED in `30a272d`. Item 9 is the true one: `billing.controller.ts:444-469` selects an explicit column list and returns `panCaptured: sql<boolean>(${receipts.panNumber} is not null)`, docstring "the PAN is not even read out of the database". Item 4 was never corrected in place — and **T14's and T16's acceptance criteria, derived from it, both require the report to "RESTATE that the server-side raw-row exposure … is UNFIXED"**, which cannot be satisfied without asserting something false.
Both coders refused, both gates verified the controller and upheld the refusal, and both spent a finding on it — the right outcome, paid for twice. §2.38 says "when amending a rule, grep the file for every other clause that states the old behaviour". **This is its compile-side twin: when a carried-forward item is closed, do not ADD a closure note beside it — rewrite the item, and then grep the CRITERIA for every sentence derived from it.** A criterion is downstream of a carried item, and the amendment stopped at the item.

**2.44 — A "REPRESENTATIVE" FIX IS THE SAME DEFECT AS A REPRESENTATIVE TEST: SCOPE IT TO THE CLASS, AND MAKE THE CLASS MECHANICALLY ENFORCED.** *(the re-entrancy fix, 2026-08-21 — §3.43 and §2.37 applied to a UI idiom)*
The discovery review named nine re-entrant money buttons; the codebase had **thirteen**, because the review listed some lanes as "and the lanes beside it". Fixing the nine would have been scoping to the reproduction (§3.43) and would have left four money writes double-posting behind a commit that read as complete.
Two things made the class closable rather than merely enumerable. **(a) One owner:** the guard lives in a single `SubmitButton` component whose spec proves the discrimination once, instead of thirteen open-coded flags — the §3.34 lesson applied before the drift rather than after it. **(b) One enforcement point:** a source sweep asserts that no billing screen still contains the bare `onClick={() => void ` idiom, PLUS a per-screen census of `<SubmitButton` mounts. Neither half works alone — the sweep is satisfied by deleting every button, and the census is satisfied by leaving a bare lane beside a guarded one — and the pair was proved to discriminate by reverting one lane in a scratch copy and watching both fail (`expected [ 'billing-dues.tsx:347' ] to deeply equal []`).
**The rule: when a convention has N implementations and zero tests, the fix is not N fixes — it is one owner plus one artefact whose removal fails something.** §3.34 has now produced three specimens (six OPD screens, the back office's three worklists, thirteen money buttons); this is the first time the enforcement artefact was built with it, and the census is what turns "we fixed the ones we found" into a number a reviewer can check (§2.37(b)).

**2.45 — A MUTANT THAT DIES BY TIMEOUT IS NOT A KILL, FOR THE SAME REASON ONE THAT DIES AT TYPECHECK IS NOT.** *(the billing idempotency fix, 2026-08-21 — caught while reading the mutant's own output)*
§2.26 established that a mutant killed by `TS2532` proves nothing, because the test never executed. A mutant killed by a **jest/vitest timeout** fails the same test for the same reason one level out: the assertion never got to run, so the DIED verdict rests on the runner giving up rather than on the property under test.
The specimen: M-I1 (the idempotency claim recorded AFTER the work instead of before) was verified against a concurrency test written as `await expect(duplicate).rejects.toMatchObject(...)`. Under the mutant the duplicate does not reject — it quietly does the work a second time — so the assertion hung and the mutant "died" at the 15-second timeout with no expected-vs-received anywhere. Rewritten to CAPTURE the loser's outcome and assert the invariant instead, the same mutant dies in **288 ms** with `Expected: 1 / Received: 2`. Same mutant, same verdict, fifty times faster and with actual evidence behind it.
**The rule: when a report says DIED, look at HOW. A timeout, a typecheck error and an unhandled rejection are all non-kills wearing a kill's clothes — the only kill is an assertion that ran and failed.** And the shape that produces the timeout is worth naming: `await expect(x).rejects` on a promise that the mutant makes RESOLVE will always hang, so a refusal test is exactly where this hides.

**2.46 — RESOLVE EVERY PATH IN THE PLAN'S FILE STRUCTURE AGAINST THE ACTUAL TREE BEFORE COMPILING. UNDER §2.25 A WRONG PATH IS NOT A TYPO, IT IS A HALT.** *(Plan 08.5 compile, 2026-08-21 — FIVE defects in one task, all found in about four minutes of `test -e`, none of them findable by reading)*
The plan's File Structure block listed `apps/web/src/lib/i18n.ts` for the bell's en+hi strings; `i18n.ts` holds **no strings** — it is eight lines that `import en from "../locales/en.json"` and hand both files to `i18next.init`. It listed `README.md` under the `apps/core/` heading; there is no `apps/core/README.md`, the repo has exactly one README and it is at the root. It named `vite.config.ts` for a `test.exclude` but not for the `/alerts` proxy line the bell needs to work in dev at all. It told T2 to re-signature `sweepExpiredTempRoles` and said "its existing test updated" **without naming the test**. And it named six files for a comment truth-pass whose class is nine.
**Why this is a HALT class and not a nuisance class, which is the part worth remembering:** §2.25 makes the frozen-path block *generated from the Files lists*. So a file the list does not name is **frozen**. A coder who discovers the right path mid-task cannot edit it — the correct action and the forbidden action are the same action. Every one of those five would have burned a rung and produced a plan-defect report instead of a commit.
**The check is mechanical and it is cheap:** for every path in the File Structure, assert the *modify* targets EXIST and the *create* targets DO NOT. Twenty-five and nine respectively here. **Do it against the tree, never by reading** — the plan's prose was excellent and its source line references were exact to the line (`dispatcher.ts` sig :5 / read :25 / `break` :34 / advance :39, `gateway.ts` `TopicSpace` :15 / `getHttpServer()` :71, `guards.ts:64`, all four sweep signatures). A document can be scrupulous about the code it quotes and still be wrong about where the code lives, because those are two different acts of attention.

**2.47 — A PLAN WHOSE TASKS ARE IN DEPENDENCY ORDER CAN STILL CONTAIN A FORWARD REFERENCE, AND NEITHER ITS AUTHOR NOR ITS PER-TASK READER CAN SEE IT.** *(Plan 08.5, D1 and T2 step 2 vs T4 — caught at compile, would have halted wave 2 of 6)*
D1 said the worker's registry installs *"the same seven manifests **+ the alerts manifest**"*. T2 step 2 said it *"builds the `SubscriptionBus` for the dispatch job **from the alerts consumer (T4's export)**"*. **T2 is wave 2. T4 is wave 4.** Neither file exists when T2 runs, so T2 was unbuildable as written — and T4 could not have repaired it either, because `worker.module.ts` was T2's file and therefore frozen to T4. The defect had no owner anywhere in the pipeline.
**The blindness is structural, which is why a careful author misses it.** The plan author is thinking about the *finished system*, where the alerts manifest obviously belongs in the worker's registry; the tense of a plan is future-perfect. The per-task reader only ever sees their own section. The contradiction exists only in the join between the Files lists and the wave numbers, and nobody reads those together — until the compiler does.
**The check, and it is one pass:** for every task, does its body name a file, an export or a symbol owned by a LATER task? If yes, that is a forward reference and it must be resolved before compiling, not discovered at runtime. **The resolution shape that cost nothing here: the earlier task ships the SEAM and the later task FILLS it** — `registerAllJobs(scheduler, db, registry, consumers)` takes a map, wave 2 passes `{}`, wave 4 adds the one entry, and a declared subscription with no handler is a boot error rather than a silent skip. It adds no task and it makes the seam load-bearing in both directions. What it does cost is one line in the later task's Files list, so amend that in the same commit.

**2.48 — RESOLVING A FORK IS AN AMENDMENT IN EVERY WAY THAT MATTERS, AND THE INSTRUCTION "FORK RESOLUTION IS NOT A PLAN AMENDMENT" IS EXACTLY WHAT INVITES THE MISS.** *(Plan 08.5, FORK-B — §2.24's shape, in the one place its own wording tells you to relax)*
The execute prompt said, correctly and for good reasons, *"Fork resolution is not a plan amendment; anything beyond the forks is."* That sentence is about **authority** — you may close a fork without owner sign-off. It is silently also read as being about **process**, i.e. that closing a fork does not need §2.24's whole-document grep. It does, and more than an ordinary amendment does, because a fork-open plan deliberately seeds the losing branch **everywhere**: FORK-B alone had live pg-boss consequences in nine places — D2's header, the T2 task header (`ROUTINE on FORK-B-loop / CRITICAL if pg-boss`), T2 step 1, T2's acceptance criteria (which demanded a pgboss-schema rollback), the File Structure `package.json` row (`pg-boss only on FORK-B, with pnpm-lock.yaml`), the Pipeline Notes tier map, the token basis, and verify-by-execution flag ⑤.
Recording only the verdict in a "Spike verdicts" block would have left every one of those standing, and a coder reading its own task header would have found it labelled with a tier and a model that the fork had just overturned.
**The rule: after resolving a fork, grep the whole plan for the LOSING branch's name and either resolve each occurrence or mark it explicitly as history.** Mark the dead branch dead *in place* — a `> **RESOLVED — the loop won; read the rest of this section as the reasoning that produced the fork, not as a live choice**` block at the top of the design section costs one paragraph and stops the next reader treating a refuted alternative as an option.

**2.49 — WHEN A SPIKE ANSWERS "NOTHING USES THIS YET", IMMEDIATELY ASK WHAT THE PLAN ASSERTS ABOUT IT: THE ANSWER IS PROBABLY A VACUOUS ASSERTION.** *(Plan 08.5 spike question D — the cheapest question in the brief returned the most valuable finding)*
Question D was housekeeping: *who calls `subscriptionsFor` in production, and what joins a manifest declaration to a `SubscriptionBus` handler?* Predicted answer, nobody and nothing. The measured answer was worse and better than that: **the seam is not merely unbound, it is EMPTY** — all seven shipped manifests declare `subscriptions: []`, `subscriptionsFor` has zero production callers, and `SubscriptionBus` is instantiated only in `dispatcher.test.ts`.
Now read T2's planned assertion against that: *"the bus's (consumer, event) pairs equal the union of every installed manifest's `subscriptions` entries."* Against the real registry that is **`[] === []`**. It passes. It always passes. A mechanical checker passes it, a gate passes it, and the §4 seam the plan describes as "finally consumed" is protected by nothing at all. This is §3.14's class — a fixture that could never produce the thing — arriving through a door nobody watches, because the assertion *looks* like a reconciliation rather than an absence.
**Two rules.** (a) **A plan's assertion about a surface the spike just proved unused is vacuous by construction — go and look at it the moment the spike says "nothing".** (b) The fix is not to delete the assertion but to give it a leg that can fail: install a **synthetic** manifest declaring one subscription with a matching stub handler and assert the bus equals exactly that, plus assert the handler-missing case throws — then keep the real-registry check as an honestly-labelled regression pin. Leg (a) is where the teeth are; shipping only leg (b) is the task failure.

**2.50 — UNDER THE WORKFLOW TOOL A ROUTINE TASK HAS NO VERDICT, SO IT CANNOT FAIL, SO THE WAVE-STALL BREAK IS DEAD FOR IT.** *(Plan 08.5 compile — EXECUTE-METHOD v2 §4 crossed with §2.39, found while writing the script)*
v2 §4 moved the mechanical check off the pipeline and onto the main session: *"Mechanical check · main session · every task."* Pipeline C could honour that literally because all four of its tasks were CRITICAL and therefore all four had opus gates. Plan 08.5 has **four ROUTINE tasks out of six**, and §2.39 established that the Workflow tool runs waves back-to-back with the main session **not in the gap**. Compose the two: a ROUTINE task's coder returns a report, nothing judges it, `runTask` must mark it `done`, and the wave-stall break — which fires on `status !== 'done'` — **can never fire on four of the six waves.**
That is not a theoretical loss. **T1 applies a migration**, which §2.20 established is an irreversible mutation of shared host state that `git checkout` cannot undo and which once turned `origin/main` itself red on the build host with no commit containing the cause. A silently-failed wave 1 leaves a host on which no later measurement means anything (§2.20c), and five tasks would run on it before the main session saw a single report.
**The fix used here: a cheap sonnet mechanical-check agent on every ROUTINE task, rendering the same shared blocks as the coders (§2.32).** It costs ~5k and it is not a second gate — its prompt says so explicitly, and its verdict rules are "fail for a claim that is not true", never "fail for a judgement I would have made differently". The main session still runs its own independent check and the full-range verification; the in-pipeline checker does not replace that, **it is the thing that stops the chain in time.** The general lesson is §2.39's, one turn further in: *when you automate the loop a rule ran in, re-read the rule and ask which of its steps used to happen in the gap* — and here the answer was not "a finding gets routed" but "a task gets to fail."

**2.51 — §2.7's "OPEN THE TEMPLATE AND CONFIRM THE TEXT IS THERE" MUST FIRST CONFIRM THE TEMPLATE IS WHERE YOU THINK IT IS.** *(Plan 08.5 compile, 2026-08-21 — 0 tokens, but it is §2.42's failure mode wearing §2.7's clothes)*
The execute prompt sent me to `~/.claude/skills/execute/SKILL.md` to verify the §2.32 fixes were in the pipeline template. **That file does not exist.** The template had been moved to `~/.claude/routing.parked/skills/execute/SKILL.md` when the routing layer was parked, and the copy there was the **pre-v2** version, dated two days before v2 was adopted: no `mechanicalPrompt` at all, no AGENT-RULES pointer (it still said "paste the Tripwires block verbatim"), no wave-stall break, no findings inbox.
**The trap is that the natural check answers identically in both worlds.** `grep -c mechanicalPrompt <path>` prints `0` and exits 1 whether the file is missing its fix or missing entirely; `grep -n` prints nothing either way unless you read stderr. That is exactly §2.42 (`gh run list` on a short SHA: empty output, exit 0, read as "nothing to worry about") in a different tool. An empty grep is "not checked", never "not present."
**Two rules.** (a) **Stat the artifact before you grep it**, and treat "file not found" as a finding about the process, not a detail to route around. (b) **When a lesson's fix is "add it to the template", the ledger entry must record the template's PATH, and a session that finds the path stale must fix the entry as well as the template** — otherwise §2.7's own remedy rots exactly the way the thing it was written to prevent rots. Both were landed here: the template is at the parked path and now carries `mechanicalPrompt` with the rules pointer, the all-agents pre-flight assertion, the wave-stall break and the findings inbox.

**2.52 — THE RULE-16/17 TRAP FIRES DURING PRE-FLIGHT, AND A NEGATIVE CONTROL IS THE MOST DANGEROUS PLACE FOR IT TO FIRE.** *(Plan 08.5 compile — my own near-miss, caught by re-reading my own output)*
Verifying the amended template parsed, I ran `node --check tmpl.neg.mjs 2>&1 | head -3; echo "neg exit: $?"` and read back **`neg exit: 0`**. That is `head`'s status, not node's — rules 16 and 17 in one line — and the honest reading of `0` on a NEGATIVE CONTROL is *"the probe is inert; the duplicate declaration was accepted."* I would have recorded a working probe as broken and gone looking for a fault that did not exist. Re-run unpiped with the value written to a file: **exit VALUE 1**, the control fires correctly.
**Why this earns an entry when rules 16–18 already exist:** every specimen in this ledger is about the trap producing a **false PASS** on evidence. Here it produced a **false FAIL on the instrument** — and an instrument you believe is broken gets "fixed", which is how a working negative control gets weakened into a green one. §2.22's rule is *a pre-flight nobody has watched FAIL is not a pre-flight*; its corollary is **you must also be sure you watched the right thing fail.** Read the VALUE, in the pre-flight too.

**2.53 — `pgrep -af jest` MATCHES ITS OWN COMMAND LINE, AND RULE 20 TELLS EVERY AGENT TO RUN IT.** *(Plan 08.5 spike and compile — hit by two agents independently, no harm, but the naive reading is "another agent is running")*
Rule 20 says: before trusting any timing, race or flake measurement, confirm nothing else is running with `pgrep -af jest`. The command is almost always run inside a compound `ssh root@… 'cd /opt/hmis && … pgrep -af jest …'`, whose own `bash -c` command line **contains the literal string `jest`** — so `pgrep` matches itself, once per shell in the pipeline, and prints two hits that look exactly like two concurrent test runs. The correct reading requires looking at the matched *command lines*, not counting them. Obfuscating the pattern (`pgrep -af "j""est"`) sidesteps it only when the surrounding command text does not also contain the word, which it usually does.
Cheap, and it fires on exactly the agents being most careful — the ones that check before measuring. **Rule 20 now carries the clause: read the matched command lines, never the count.** Recorded here because AGENT-RULES may only gain a rule that a §2 or §3 entry earns.


**2.54 — THE PLAN'S FILES LIST AND THE PIPELINE SCRIPT'S `files` ARRAY ARE TWO HAND-MAINTAINED COPIES OF ONE FACT. I AMENDED ONE. THE PIPELINE'S HEADLINE DELIVERABLE DID NOT SHIP.** *(Plan 08.5, amendment 6 — my compile defect, and the most expensive finding of the run)*
While compiling I found a genuine forward reference (§2.47): D1 and T2 step 2 both told wave-2 T2 to import wave-4 T4's exports. I resolved it properly — T2 ships the seam, T4 fills it — wrote it into the plan's File Structure and into T4's task body, committed it as a visible amendment, and **never added `worker.module.ts` to T4's `files` array in the compiled script.** The frozen-path block is GENERATED from that array (§2.25), so T4's brief listed twelve files and its generated frozen block told it, under the heading *"OWNED BY OTHER TASKS — DO NOT TOUCH THEM, EVEN IF YOUR CHANGE WOULD BE CORRECT"*, that the file belonged to T2. **T4 read its brief and obeyed it, which is exactly what the rules require of it.** The plan said do it; the brief said don't; the brief won.
Result: `worker.module.ts:58` ships a comment reading `// T4 (amendment 6) adds: registry.install(alertsManifest);` and `worker.ts:26` calls `registerAllJobs(…, {})`. Executed on the dev compose: 12 events, **0 deliveries, 0 alerts, 0 `event_cursors` rows** — `runDispatchCycle` heartbeated every two seconds for five minutes and did nothing, because `bus.consumers()` is empty so its per-consumer loop never ran. The plan exists to make escalations reach a human; they reach nobody.
**This is §2.25's own sentence — "two hand-maintained lists of the same fact drift by construction" — committed by the session that wrote §2.46 the same day, one level up.** §2.25 made the frozen block generated *from the script*, which removed one copy and left the other: the script's array is now a second copy of the PLAN's list, and nothing reconciles them. **The fix is a pre-flight assertion, and it is the one this pre-flight lacked**: for every task, the script's `files` array must equal the plan's File Structure rows for that task, parsed from the plan file. My pre-flight asserted the frozen block was *generated* and that each task allowed its own files and forbade the others' — 83 assertions, and not one of them compared the script to the plan. **A generated artefact is only as good as the list it is generated FROM, and that list needs its own check.**
Two more things worth keeping. **The §2.39 inbox worked and could not help:** T4's coder and T4's gate both reported the missing wire into the findings inbox as an owner call, and T6 read it and worked around it. The routing was fine; there was no agent with permission to act. **And a half-fix is worse than none:** `jobs.ts:36-45` makes a declared subscription with no handler a BOOT ERROR, so installing the manifest without adding the handler ships a worker that throws at startup, with a green suite behind it.

**2.55 — CI IS THE ONE CHECKLIST ITEM NO IN-PIPELINE AGENT CAN RUN, AND UNDER THE WORKFLOW TOOL NOBODY ELSE RUNS IT EITHER. SIX COMMITS SHIPPED RED.** *(Plan 08.5 — §2.33 recurring at 1.5× its original cost, and §2.50's fix aimed at the wrong hole)*
`gh` is not installed on the build host and the repo is private, so every gate and checker was told — correctly, and by me — to report CI as *"delegated to main session"* and move on. That delegation is sound when the main session sits between waves. **Under the Workflow tool it does not.** I anticipated exactly this and put mechanical-check agents on the four ROUTINE tasks so a ROUTINE wave could fail and the wave-stall break could fire (§2.50). It worked as designed and was irrelevant: **the hole I patched and the hole that swallowed the run were different holes.** The checkers ran every item they could; CI is the only one they cannot, and it is the one that was red.
`main` went red at T2 and stayed red through T3, T4, T5 and T6 — six commits, always the same test, always the same error — while `pnpm verify` on the build host was green at every one of them. Nobody was wrong; the loop had no eye on that axis for five and a half hours.
**CLOSED 2026-08-21, and not the way this entry first proposed.** `gh` IS now installed on the build
host — but deliberately left **unauthenticated**, because `gh` refuses to run without a token even
for a public repo, and the only way to give it one is to put a GitHub credential on an
internet-facing box that logs ~71 000 failed auth attempts and 343 distinct probing IPs per log
rotation. That is a new exposure to close an old hole. Instead the watch runs where an authenticated
`gh` already exists — the owner's machine — as **`docs/superpowers/pipelines/ci-watch.sh`**, in the
background for the duration of a pipeline. It reports every new commit on `origin/main` as GREEN, RED
or DID-NOT-RUN and exits 1 on red. It was validated against this session's own history, which
happened to contain all three states: T1 green (808 s), T2–T6 red (800–1600 s), and three
billing-blocked commits correctly identified as *did not run* (4–5 s) rather than red.
**SUPERSEDED IN PART 2026-08-24 — see §2.91 and `pipelines/ci-watch-host.sh`.** The security
reasoning above is unchanged and still governs: no token goes on the probed box. What changed is
that none is NEEDED — the repository is public, so a build-host session reads green/red per full
sha over unauthenticated `curl`. "The watch runs on the owner's machine" was true of `gh`, not of
CI.
**The lesson that generalises past this fix: when the obvious remedy is "give the untrusted box a
credential", check whether the check can simply run somewhere that already has one.**

**Two fixes, and the first is the real one.** (a) **Put CI in the pipeline, not in the epilogue** — either install and authenticate `gh` on the build host (§2.33 proposed this two plans ago and it was never done), or have the compiling session poll CI by full SHA between waves from the machine that has it. A pipeline that cannot see CI is a pipeline that cannot stop for CI. (b) Until then, the compiling session must check CI **after every task's commit**, not once at the end — the wave-stall break exists to stop a chain in time, and an epilogue check cannot.

**2.56 — A TEST THAT CALLS A PRODUCTION FACTORY INHERITS ITS ENVIRONMENT REQUIREMENTS, AND THE BUILD HOST'S `.env` HIDES THAT FROM EVERY LOCAL RUN.** *(Plan 08.5, T2 — the specific defect behind §2.55, green on exactly one machine in the world)*
T2's L14 census test calls the real `registerAllJobs`, which calls `loadConfig()`, which parses the **process environment** through a zod schema in which `DATABASE_URL` is REQUIRED and has no default. The build host has `DATABASE_URL` in `apps/core/.env` because it is also a dev machine. CI sets only `TEST_DATABASE_URL`. So a **fake-clock unit test that touches no database** hard-requires a database URL and fails with `ZodError … path: ["DATABASE_URL"] … received undefined` everywhere except the one machine the pipeline runs on.
Note what this defeats. The plan's D9 deliberately defaulted every NEW key in the schema so no `.env` change would be needed anywhere, and its verify-by-execution flag ⑧ named *"CI green at the T2 commit"* as the discharge. The new keys behave perfectly; the defect is that `registerAllJobs` reaches for `loadConfig()` at all, pulling in a pre-existing REQUIRED key. **A config-defaults promise is not discharged by the new keys defaulting — it is discharged by the whole call graph the new code touches.**
**The rule: a test that invokes a production wiring function is an integration test wearing a unit test's clothes.** Either the function takes its config as a parameter (the same shape the consumers map already uses in this very file), or the test supplies the environment explicitly. And when a plan promises "no env change needed", the check is a run in an environment that HAS no env — which is what CI is for, and which is why §2.55 is the entry above this one.

**2.57 — A CENSUS THAT ASSERTS A *SET* CANNOT SEE A MUTATION THAT PRESERVES THE SET — AND THE ASSERTION BOOK'S OWN STATED DISCRIMINATING INPUT WAS WRONG TOO.** *(Plan 08.5, L14 / M-S2 — both measured by the discovery reviewer with passing controls, neither reasoned)*
L14 asserts that all six jobs are invoked within a faked 25-hour advance. **M-S2** — daily-IST instants computed from the UTC calendar instead of `+IST_OFFSET_MS` — **SURVIVES it**, because all three daily jobs fire within any 25-hour window under either calendar. The set is preserved; only the *timing* moves, and the census does not look at timing.
Worse, and this is the part rule 21 exists for: **the Book's own stated discriminating input does not discriminate either.** Row L14 named *"the guardians job must fire in the tick window containing `2026-08-21T18:35:00Z`"* and predicted the mutant fires it *"~5.5 h later"*. Executed: shipped passed, **mutant also passed** — `isDailyDue`'s `pastInstant` is a `>=` comparison, so at 18:35 UTC the mutant sees hour 18 > 0 and fires guardians in that very window too. The input that actually separates them keys on the day index against an existing heartbeat.
**Rule 21 says never claim an assertion discriminates unless you built the mutant and watched it fail. This extends it: the same burden applies to the INPUT a plan writes down.** An Assertion Book row's "exact discriminating input" is a prediction like any other, it is written before any code exists, and here it was wrong in the direction that matters — a coder who built exactly what the Book asked would have shipped a census that cannot see the mutant, and reported the row as satisfied. **When a Book row names an input, the task that ships it must confirm by execution that the input separates the two implementations, not merely that the test passes.**

**2.58 — THE DOCUMENTED WAY TO RUN THE APPLICATION HAD BEEN BROKEN FOR FOUR DAYS AND THREE PIPELINES, WITH EVERY TEST GREEN, BECAUSE NOTHING IN `verify` RUNS THE APP THE WAY A HUMAN DOES.** *(found by Plan 08.5's demonstration; the defect itself is Plan 07's, from `f84f1b1`)*
README §"Run locally" step 3 is `pnpm --filter @hmis/core start:dev` → `http://localhost:3000/health`. That command dies: `TypeError: Cannot read properties of undefined (reading 'registerTopicSpace')` at `OpdRealtimeRegistrar.onModuleInit`. The cause is a toolchain seam — `OpdRealtimeRegistrar` uses class-typed constructor injection, `tsx` transforms with esbuild, esbuild does not emit `design:paramtypes`, so Nest injects `undefined`. **ts-jest DOES emit it**, so all 807 core tests pass, CI's only complaint is something else entirely, and the application cannot be started.
It surfaced only because Global Constraint 10 required a real-clock DEMONSTRATION rather than a test, and the demonstration needed `/health`. The spike had flagged the same seam as *"incidental, not measured — worth someone checking"* and moved on; nobody checked for four days.
**Two rules.** (a) **A demonstration is not a slower test — it is the only thing that exercises the paths tests structurally cannot**, and this project now has a specimen worth the whole cost of the constraint. Keep demanding one. (b) **When a plan adds a second process entrypoint, the invariant that makes it work needs an enforcement artefact, not a comment.** Plan 08.5's worker boots under `tsx` only because every provider is token-injected; that fact is recorded in a comment in `worker.module.ts` and enforced by nothing, and jest cannot see it — the next class-typed provider added to the worker graph breaks `start:worker` at runtime with a green suite.


**2.59 — A CI `conclusion: "failure"` IS NOT A VERDICT ABOUT THE CODE. A BILLING-BLOCKED JOB "FAILS" IN THREE SECONDS HAVING NEVER STARTED, AND `gh run list` REPORTS IT IDENTICALLY TO A RED SUITE.** *(the 08.5 remediation, 2026-08-21 — caught only because the fix "failing" was implausible)*
§2.42 established that an EMPTY `gh run list` means "not checked", never "not failing". This is the same trap one step further in: a **non-empty** result whose `conclusion` is `failure` can also mean "not checked". GitHub Actions billing lapsed on this account mid-session, and every push after it produced a run that lasted **3–4 seconds**, executed nothing, and reported `conclusion: "failure"` — indistinguishable in `gh run list --json conclusion` from the six genuinely red commits earlier the same day. The annotation is the only tell, and it is not in the JSON most checklists query:
> *"The job was not started because recent account payments have failed or your spending limit needs to be increased."*
**I nearly recorded the remediation as having failed.** The commit's own message said "and CI goes green"; CI said `failure`; the honest reading of those two facts together is "the fix did not work". What saved it was implausibility — a change that had just been proved correct by two independent executions should not fail CI — so I opened the run instead of the list. **That is not a method. The method is: never read `conclusion` alone.** Check that the run actually RAN: a duration of seconds rather than minutes, an empty `steps` array, or an annotation, all say the job never started. A CI result is evidence about a commit only if the job executed, and the three states are *green*, *red*, and **did not run** — the third has been silently collapsed into the second by every checklist this project has written.
Corollary, learned the same hour: **when CI cannot run at all, the CI criterion cannot be discharged and must not be quietly dropped.** B1 was a defect whose entire definition was "green on the build host, red in CI". With CI blocked, the only honest verification was to REPRODUCE CI's condition on the build host — run the suite with `DATABASE_URL` unset — and say plainly that this is a reproduction of CI, not CI.

**2.60 — A TEST'S WORKAROUND THAT WAS NEVER IN EFFECT, AND THE DOWNSTREAM READER WHO BELIEVED ITS COMMENT.** *(Plan 08.5 T2 → its mechanical check → the remediation, 2026-08-21)*
T2's L14 census set `WORKER_DAILY_TICK_MS: 5000` in an env-override block, with a comment arguing at length that 5 s beats the 30 s production default for `runDailyClose`'s one-IST-minute window — ~12 ticks of margin instead of ~2. **`Scheduler` takes its tick from its CONSTRUCTOR (4th argument, default 30 000) and the census never passed one.** The env key it set was read by nobody. The claimed margin never existed; the census had always run on the 30 s grid.
The cost is in what happened next. T2's mechanical checker observed a `runDailyClose` miss under full parallel load, went looking for an explanation, found that comment, and **routed it forward into the findings inbox as the explanation** — telling T6 that the census "works around" the narrow window and that any miss it saw was therefore expected and not a regression. A false premise, propagated in good faith through the one channel built to carry facts between tasks (§2.39), and believed downstream precisely because it was specific and well-argued.
**Two rules.** (a) **A test that sets configuration must assert the configuration took effect**, or it is decoration with a persuasive comment attached — and the more carefully the comment argues, the more readers it will convince. (b) **A finding that EXPLAINS an observation is a claim like any other and inherits rule 21's burden.** The checker executed the flake honestly; what it did not execute was the mechanism it offered for it. When routing an explanation forward, say which part you ran and which part you read.


**2.61 — A MUTANT OF A CLASS WITH `private` MEMBERS CANNOT BE DROPPED UNDER A FUNCTION TYPED AGAINST THE SHIPPED CLASS: TYPESCRIPT IS NOMINAL THERE, AND THE RUN DIES AT TYPECHECK.** *(the 08.5 remediation's gate, 2026-08-21 — found while rebuilding M-S2, 0 tokens lost because the gate recognised the non-kill)*
§2.26 established that a mutant killed by `TS2532` proves nothing because the test never executed, and named `noUncheckedIndexedAccess` as the usual cause. Here is a second, structurally different one. `Scheduler` has `private` fields, and **TypeScript compares classes with private members NOMINALLY, not structurally** — so a scratch `scheduler-ms2-mutant.ts` cannot be passed to a function whose parameter is typed `Scheduler`, even though it is a byte-copy with two arithmetic characters changed. The mutant dies at the compiler, the report says DIED, and nothing was proved.
**The fix that makes the mutant reach the assertion:** copy the one INTERMEDIATE module that stands between the mutant and the test — here `jobs.ts` — with **only its `import type` line repointed** at the mutant, and drive the test through that copy. The spec then differs from its control in exactly two import lines, which is also what makes the control credible.
**The general rule, and it is the one to carry:** *when a mutant will not compile, ask whether the obstacle is the LANGUAGE or the ASSERTION before you rewrite either.* An indexed array literal (§2.26), a class with private members (this entry) and a changed signature are all the compiler refusing to let the mutant reach the test — not evidence about the property under test. A DIED verdict is owed an assertion's own expected-vs-received, always; if you cannot produce one, you have not built a mutant yet.


**2.62 — TWO TASKS IN ONE WAVE CAN COALESCE THEIR COMMITS INTO A SINGLE PUSH, AND THE EARLIER COMMIT THEN HAS NO CI RUN AT ALL — NOT A BLOCKED ONE, NONE.** *(Plan 10, T2 `0f512c3` — found in Phase 4, which is exactly where §2.55 says it is too late)*
GitHub Actions raises one `push` event per push, for the tip. Wave 2 ran T2 and T3 in parallel; the push that carried T2's commit to `origin` also carried T3's, so `gh api .../actions/runs?head_sha=<T2>` returns an **empty** `workflow_runs` array. §2.42 taught that an empty `gh run list` means "not checked, never not failing", and §2.59 taught that a non-empty result whose job never started means the same. **This is the third member of that family and the only one where no run object exists to inspect at all.**
It cannot be repaired afterwards. The workflow declares `on: [push, pull_request]` with no `workflow_dispatch`, and dispatching on a bare SHA is refused (`422 No ref found`) — a re-run needs a run to re-run. What is left is discharge by equivalence, and it must be labelled as such: T2's three files were byte-identical at `0f512c3`, at the next commit (CI green, 445 s) and at HEAD, and the tree at `0f512c3` differs from that CI-green tree only by four added files. **That is not "CI green at that SHA" and must not be written down as if it were.**
**The rule: in a pipeline with any parallel wave, check CI per COMMIT and treat "no run object" as its own state.** The cheap prevention is upstream of the check — a parallel wave's tasks should not both push, or the compiling session should push a no-op between them. The cheap detection is to compare the count of task commits against the count of runs.

**2.63 — `ci-watch.sh` STALLS PERMANENTLY ON THE FIRST COMMIT THAT HAS NO RUN, SO §2.55's OWN ARTEFACT DID NOT FIRE ON THE ONE RED COMMIT IN THE PIPELINE IT WAS WRITTEN FOR.** *(Plan 10 — the watcher ran for the full 5 h 25 m and reported nothing useful)*
Its sweep walks `git rev-list --reverse origin/main -20` and, on rc 2 — which means *pending* **or** *did-not-run* — `continue`s **without adding the sha to `seen`**. So every sweep re-reports the same historical billing-blocked commits forever, and the log's last line for the whole run was `0f512c3  no run yet`: true, and permanent, because that run will never exist (§2.62). The red at T3 was found by the main session querying `gh` by hand in the epilogue — the position §2.55(b) exists to move the check *out of*.
**Two defects, and the second is the one that generalises.** (a) `seen` must record a sha the watcher has decided it cannot resolve, with a bounded retry, or one unresolvable commit blocks every later one. (b) **A watchdog that reports only exceptions is indistinguishable from a watchdog that has stopped watching.** This one printed nothing about the four green commits it did see and nothing about the red one it never reached; a periodic "checked N commits, latest `<sha>` GREEN" heartbeat is what would have made the stall visible within one sweep.

**2.64 — A CI RED WHOSE DIFF CANNOT EXPLAIN IT IS A CANDIDATE FOR RE-RUN BEFORE IT IS A CANDIDATE FOR DIAGNOSIS.** *(Plan 10, T3 `b7546cf` — red at attempt 1 in 400 s, GREEN at attempt 2 in 445 s, same commit)*
The failing test was `scheduler.test.ts`'s L14 25-fake-hour census, and `invoked` came back **completely empty** — `Set {}`, not five of six. `scheduler.jobs()` had passed six lines earlier, so registration worked and the whole advance simply did no work before `stop()` latched: a starvation signature under CI's slower container, not a logic one. T3's diff is four files, none of them the scheduler, the census or `jobs.ts`.
§2.59 established the three CI states — green, red, did-not-run. **This is a fourth reading of a red: the job ran, executed the suite, and still was not evidence about the code.** The tell is the same one that saved the 08.5 remediation: implausibility. When the diff cannot reach the failure, re-run the identical commit *before* writing the diagnosis — it is one API call and it converts an argument into a measurement.
And book the flake: a census that can come back empty under load is a census that can be green for the wrong reason. `scheduler.test.ts` has now produced three ledger entries (§2.57, §2.60, this).

**2.65 — THE FORWARD-REFERENCE PASS CATCHES A CLASS THE PATH SWEEP STRUCTURALLY CANNOT: A FILE NO TASK NAMES, THAT A WIDENED TYPE WILL BREAK.** *(Plan 10 compile, amendment 7 — one HALT-class defect, found before a single brief was written)*
§2.46 resolves the paths a plan *wrote down*. It passed cleanly here: 27 modify-targets existed, 14 create-targets did not. The defect was in the paths the plan **did not** write down. T4 registers a seventh scheduler job and widens `JobIntervals`; three shipped artefacts break the instant it does, in two files T4's Files list never named — `scheduler.test.ts`, owned by **nobody** and therefore frozen to all six tasks, holding `THE_SIX`, `spyOnTheSix` and a `JobIntervals` **object literal** that stops typechecking the moment the `Pick` widens; and `test/worker-runtime.e2e.test.ts`, owned by T5, one wave later. Under §2.25 the frozen block is generated from the Files lists, so T4's brief would have forbidden what the plan required — B2's exact shape — and T4's `pnpm verify` could not have been green.
The plan also named the wrong file for the work (*"the census in `jobs.test.ts`"*; that file holds no job-name census at all), which is §2.46's write-from-memory class surviving a §2.46 sweep because the sweep only checks that named paths *resolve*.
**The mechanical form of the check: for every symbol a task WIDENS or a registry a task GROWS, grep the whole tree for its other readers and ask which task owns each one.** A widened `Pick`, a grown census array and a new enum member all have the same signature — the compiler or an equality assertion will find them, and it will find them in a file that is frozen. The resolution cost nothing: two rows in T4's Files list and one deliberate two-owner file across sequential waves.

**2.66 — `pkill -f <pattern>` MATCHES ITS OWN INVOKING SHELL, AND WHERE `pgrep` MERELY MISLEADS, `pkill` ACTS.** *(Plan 10, the flag-④ demonstration — killed my own SSH session mid-run and orphaned the worker)*
§2.53 established that `pgrep -af jest` matches the compound shell that contains the literal string `jest`. The same is true of `pkill`, and the consequence is not a misread: `ssh root@… 'cd /opt/hmis && … pkill -TERM -f "tsx src/worker.ts"'` matched the outer `bash -c` whose command line contains that string, killed it, and returned 255. The `pnpm` wrapper died (exit file: 143), the `tsx` child was orphaned and kept running, and the transcript had to be recovered on a fresh connection.
**Kill by PID, never by pattern, from inside a shell whose own command line contains the pattern.** Resolve the PID in one call, read the matched command lines to confirm what it is (rule 20), then `kill <pid>`. No harm here — the demonstration's evidence was already on disk — but the same shape aimed at a test run would have killed the measurement and left the thing being measured alive.

**2.67 — A FINDING ROUTED FORWARD CAN BE TRUE AND STILL TOO NARROW, AND THE NARROWNESS IS WHAT PROPAGATES.** *(Plan 10, T4's gate → the discovery reviewer, 2026-08-22 — §2.60's second specimen)*
T4's gate built an unprompted mutant that moved the expiry gate one position down the suppression gauntlet, watched the whole suite stay green, and booked it honestly into the inbox: *"the gauntlet's ORDER is not mutant-enforced… both orders are non-sends, so nothing reaches a person either way."* Every word of that is true **of the mutant it built**. The discovery reviewer then built a different relocation — the D-33 deceased stop moved past channel resolution — and the conclusion collapses: a patient who is both deceased and phoneless takes the `no_phone` rung instead, which appends `notification.failed`, which the alerts consumer turns into a desk task instructing a duty manager to telephone a dead patient's family. Shipped code is correct; nothing pins that it stays correct.
§2.60's rule was *an explanation routed forward inherits rule 21's burden*. **The extension: so does a REASSURANCE.** "I built the mutant and it was harmless" generalises from one mutant to a whole class, and that generalisation is a prediction like any other. When booking a survivor as benign, say which mutant you built and what the class of unbuilt ones is — or say that you do not know.

**2.68 — CHECK THE TOKEN TARGET AGAINST THE ASSERTION BOOK'S OWN ROW COUNT AT COMPILE TIME. EXECUTE-METHOD §8 ALREADY SAYS SO.** *(Plan 10 — 2.64M against a 1.2M target, 2.2× over)*
§8's calibration note is explicit: the tiering dial pays in proportion to how much genuinely routine work a plan contains, and *"count the required-DIED mutants in the Assertion Book before promising a number — that count IS the plan's own risk assessment, written before any code existed."* Plan 10's Book has fifteen rows, thirteen of them owned by the two CRITICAL tasks, and they produced **twenty mutants**. The review split worked exactly as designed (four ~15k mechanical checks instead of four ~130k gates) and the total still came to ~203k per agent — the Plan 08 rate v2 was written to cut.
Nothing overspent. **The target was wrong, and it was checkable before the run**: the prompt inherited 1.2M from "smaller than 08.5's 1.5M because there is no spike", which prices the *absence* of a phase rather than the *presence* of twenty mutants on a send path. The gate that would have caught it is one arithmetic step at compile time, and I did not take it.
Worth keeping alongside: the single best-value agent in the run was the **one discovery reviewer**, which produced both MAJOR findings with executed evidence and corrected a false-in-part inbox entry. The most expensive practice that found nothing — a gate rebuilding all nine of its task's mutants from scratch — is the same practice that caught 08.5's surviving census mutant, and should not be cut on one quiet run.


**2.69 — AN ABSOLUTE PROHIBITION WRITTEN FOR ONE CONTEXT BECOMES A BLOCKER IN ANOTHER, AND THE TIME TO NOTICE IS WHEN YOU WRITE THE PLAN THAT WILL VIOLATE IT — NOT WHEN ITS AGENT HALTS.** *(Plan 11a's handoff, 2026-08-22 — caught at zero cost, one turn before it would have cost a rung)*
AGENT-RULES rule 7 read *"Create no docker container"*. It was written when the build host carried an unrelated co-tenant and a shared docker daemon, and for four plans it was exactly right. **Plan 11a's entire job is to ship a production Compose file.** *"Create no docker container"* and *"ship a compose file"* cannot both be true, and nothing in the process would have surfaced that until a coder read its brief, obeyed the rules file as instructed, and halted — or worse, obeyed the plan and got failed by a gate for breaking a hard rule.
It surfaced only because writing the handoff prompt forced a pass over *"what does the next session need that is not true any more"*. That is not a check anybody had prescribed; it fell out of the act of writing the handoff.
**Two rules.** (a) **When a plan's scope contradicts a hard rule, the rule changes BEFORE the plan is compiled, deliberately and in a visible commit — never by an agent deciding mid-task that the rule cannot have meant this.** Rule 7 became a *boundary* (named compose projects; `hmis-db-1` and its volume never touched; no blanket prune, ever, because a prune cannot tell scratch from the dev database) rather than being deleted. (b) **Retire a rule by striking it in place, with its date and reason — never by deleting the line.** Briefs compiled earlier cite rules BY NUMBER; an agent reading one must find out what happened, not find a gap where rule 6 used to be. The same §2.48 discipline that governs a dead fork branch governs a dead rule.
**And the generalisation worth carrying:** every hard rule encodes a fact about the world at the moment it was written. When that fact changes — a co-tenant leaves, a host is dedicated, a dependency dies — **go and read the rules that were justified by it**, because they will not announce themselves. Rule 6's retirement was obvious the moment InsForge went; rules 7 and 9 both silently depended on it and neither mentions InsForge by name.


**2.70 — A REMOVAL VERIFIED AGAINST THE INVENTORY YOU KNEW ABOUT MISSES THE LAYER YOU DID NOT, AND THE CLEAN VERDICT PROPAGATES.** *(the InsForge removal, found by the Plan 11a writing session, 2026-08-22 — caught one session later at zero cost, by a general port scan run for an unrelated reason)*
The removal session deleted InsForge's containers, volumes, images and `/opt/InsForge`, then verified "only port 5433 listens" — **by checking the five ports the co-tenant was known to use** (5430/5432/7130/7131/7133). All five were indeed free, the claim entered the handoff prompt and the roadmap, and "the box is dedicated" became ground truth. It was false at the host layer: an **enabled, active nginx** with a Certbot certificate was still serving the co-tenant's domain into a dead upstream — **holding 80 and 443, the two ports the production Caddy needs** — because docker inventory was the removal's frame and nginx is not a container. The next session found it only because it ran `ss -tlnp` unfiltered while sizing the box.
This is §2.37's "four is not thirty-one" one level up: *verify the property, not the enumeration you happened to have.* "Nothing else listens" is a claim about ALL ports and is one unfiltered `ss -tlnp` away; "the stack is gone" is a claim about every layer a stack can occupy (containers, volumes, images, host services, cron, certs, DNS), not the layers its install docs mention. **When a removal or cleanup is verified, state the property being claimed and run the check that answers THAT — the enumerated check will pass precisely when the surprise is outside the enumeration.**


**2.71 — WHEN A PLAN'S DELIVERABLE IS DEPLOYED CONFIGURATION, SOME TASK MUST OWN THE FINAL DEPLOY — OR EVERY TASK CORRECTLY DECLINES AND THE SHIPPED COMPOSE IS NEVER DEPLOYED.** *(Plan 11a, found in Phase 4 by running `deploy.sh` myself — the whole backup fabric was inert in production and six commits were green)*
Rule 7 permits an agent to stop or recreate an `hmis-prod` container only when its brief says so **in as many words**. No brief said so. T4 changed the `db` service onto the pgBackRest image and **declined to deploy it**, disclosing the consequence exactly: *"THE BACKUP FABRIC IS THEREFORE NOT YET LIVE IN PRODUCTION."* It booked the item for T6; T6 was equally unauthorised and equally correct to decline. Both agents obeyed the rules perfectly and the outcome was a production database running the previous task's image with `archive_mode` off and `pg_stat_archiver` reading `archived_count=0`.
**Nothing in the pipeline was wrong. The plan had no step whose job was "make the box match the repo."** T3's bring-up drill ran at wave 3 and every later task proved its work on throwaway stacks — correctly, because that is what the rules allow them.
**The rule: for any plan that ships deployed configuration, name the task (or the main-session step) that puts the FINAL state on the box, and give it the authorisation in as many words.** The tell is cheap and mechanical: at Phase 4, compare the running image of every service against the compose file, and the set of running services against the set declared. Both comparisons are one command and both were false here.

**2.72 — "CHANGE NOTHING ELSE" IN AN ALLOWED FILE IS A FROZEN PATH WEARING A DIFFERENT HAT, AND IT COST THE MONITORING STACK.** *(Plan 11a T6 — my compile defect, found by deploying)*
§2.54 is about a file a Files list OMITS. This is its mirror: a file the list INCLUDES, narrowed by an instruction until the required work is forbidden anyway. `deploy.sh` had three sequential owners, so T6's brief said *"You add the seeding slot, in D13's position… **Change nothing else.**"* I wrote that to protect T3's and T4's content. T6 obeyed it exactly — and T6's own four monitoring configs are installed into the deploy directory by nobody. Prometheus crash-loops on a missing config file; Grafana comes up with no datasource; postgres-exporter runs without `queries.yml`, so the heartbeat gauge that is the entire point of D9 does not exist and neither do flag ⑨'s alert rules. T3 had even left the seam as a comment — `# T6 installs the prometheus/ and grafana/ trees here.` — and my instruction told T6 not to touch it.
**The rule: when a multi-owner file's brief restricts an owner to one region, ENUMERATE what that owner must add, do not write a blanket prohibition.** "Add the seeding slot AND install your own configs; change nothing T3 or T4 placed there" is the same protection and does not forbid the deliverable. A prohibition is cheap to write and its blast radius is invisible until something does not start.

**2.73 — A COMPILE-TIME CENSUS EXPIRES THE MOMENT PHASE 0 LANDS, BECAUSE PHASE 0 IS CODE THAT DID NOT EXIST WHEN YOU RAN THE SWEEP.** *(Plan 11a — my compile defect, caught by T5's typechecker rather than by me)*
§2.65's mechanical form is *"for every symbol a task WIDENS, grep the whole tree for its other readers."* I ran it and measured, correctly: exactly ONE `JobIntervals` object literal existed (`CENSUS_INTERVALS`), so T5's widening would break exactly one file and T5's Files list named it. **Then Phase 0's R0-2 shipped a wiring test containing a SECOND `JobIntervals` literal** — and my sweep, run before it, was silently stale. T5 hit `TS2739`, correctly disclosed it as a plan defect, and its gate ruled the edit authorized; no rung was lost, but only because the typechecker is loud.
The same run produced the same shape twice more: the discovery reviewer found a **third** literal that T5's own `sweep.test.ts` had added, invalidating a T5 gate note that closed with *"any later task that widens `JobIntervals` again must edit BOTH literals."*
**The rule: re-run the §2.65 greps AFTER Phase 0 lands and BEFORE compiling, not once at the start — and state a census as "N at commit `<sha>`", never as a bare number.** A count without a commit is a claim with no expiry date on it, and everything downstream inherits it.

**2.74 — A DEPLOY SCRIPT WHOSE ONLY GATE IS ONE HTTP ENDPOINT EXITS 0 WITH A SERVICE CRASH-LOOPING BESIDE IT.** *(Plan 11a, my Phase-4 deploy)*
`deploy.sh` ran eight steps, printed `==> hmis-prod is up`, and exited **0**. In the same `docker compose ps` it had just printed, `hmis-prod-prometheus-1` read `Restarting (2)`. The gate is `/health` through Caddy, which is a statement about the api, the db and the worker — and about nothing else. Everything the gate looked at was genuinely healthy.
This is §2.70's *"verify the property, not the enumeration you happened to have"* in a deploy script: the property is **"every service this compose declares is running"**, and the check that answers it is one command against `compose ps`, not a curl against one route.
**The rule: a bring-up gate asserts the SET of declared services is up, then asserts the endpoint.** And it is worth a moment at compile to ask, of any script whose exit code you are about to trust, *which failures can this exit 0 through?*

**2.75 — TWO ASSERTIONS CAN BE INDIVIDUALLY CORRECT AND JOINTLY BLIND, AND THE GAP LIVES EXACTLY WHERE THEIR FIXTURES DO NOT OVERLAP.** *(Plan 11a T5, found by the discovery reviewer with executed evidence, re-verified from source)*
V5 proves a legal hold stops the partition drop. V12 proves the companion sweep respects the window and never touches a `retrying` delivery. Both DIED as required; both are right. **Neither asks what the OTHER one's subject does under the FIRST one's condition** — and the answer, measured, is that a held month keeps its events and loses its `event_idempotency`, `event_deliveries` and `event_dead_letters` rows to the same sweep run. `blockingHold()` is consulted inside the partition loop and nowhere else.
The structural tell is in the fixtures, not the code: **V5's fixture has no side-table rows and V12's has no hold.** Two disjoint fixture worlds, so no mutant either row can build will ever reach the composition.
**The rule: when a plan ships a GUARD and a SWEEP in the same task, write one row whose fixture carries both the guard's condition and the sweep's subject.** Ask, per protective mechanism: *what else does this run delete, and does the protection reach it?* This is §2.57's family — an assertion that cannot see a mutation that preserves its own set — one level up, at the composition rather than the set.

**2.76 — TO TELL A FLAKE FROM A REGRESSION, RE-RUN A COMMIT YOU ALREADY BELIEVE, NOT ONLY THE ONE YOU DOUBT.** *(Plan 11a — the `scheduler.test.ts` L14 census, five reds across ~31 runs)*
§2.64 says re-run the identical commit before writing the diagnosis. That is necessary and it was not sufficient here, because **this flake fails twice in a row**: two separate commits needed a THIRD attempt. After two reds the tempting reading is "not a flake after all."
What settled it in one API call was a **control**: `855550a` and `51c2e36` have byte-identical source across all three workspaces — the only difference in the tree is a shell script under `docs/` — so I re-ran the commit that had been GREEN. It went green again, and the doubted one went green on its third attempt. Identical source, green/green against red/red/green, interleaved in time. No argument about runner speed was needed.
Two riders. **The watcher structurally undercounts this:** `?head_sha=` returns only the LATEST attempt, so every historical red that was re-run green is invisible — the per-run rate is worse than the per-commit rate suggests. And **the discriminator when the diff CAN reach the failing test** (T2 grew that very census) is downstream: T5 later grew the same census to nine jobs and CI was green twice, which no broken census survives.
**The rule: pair every suspicious red with a re-run of a commit whose verdict you already trust and whose source is identical. A control turns "probably the flake" into a measurement, and it costs one API call.**
**2.77 — A SERVICE THAT READS ITS CONFIG ONLY AT STARTUP IS NOT RECONFIGURED BY REPLACING THE FILE, AND `compose up -d` WILL NOT NOTICE.** *(Plan 11a remediation, 2026-08-23 — found by verifying the fix rather than by trusting it)*
Installing the missing prometheus/grafana configs was the obvious half of the fix and it was not enough. Afterwards, grafana still reported **zero datasources and zero dashboards**. The files were demonstrably inside the container (`ls -R /etc/grafana/provisioning` listed all three), and the API still returned `[]`. The timestamps are the whole story: grafana **started at 18:32:36**, the files **landed at 19:07:52**, and grafana reads provisioning **once, at boot**.
`docker compose up -d` recreates a container when the service DEFINITION changes. Replacing the contents of a bind-mounted directory changes no definition, so compose correctly does nothing, and the running process keeps whatever it read at startup — indefinitely, and silently, with the correct file visible inside the container the whole time. **The evidence that the mount is right is not evidence that the process read it.**
T3 had already met this exact trap for the Caddyfile and solved it with an explicit `caddy reload`; the lesson did not generalise to the next two services that needed it, because the note was written as a fact about Caddy. **The rule: for every bind-mounted config, know whether the process re-reads it, and if it does not, RELOAD OR RESTART IT IN THE DEPLOY SCRIPT — then assert the effect through the service's own API, never through `ls` inside the container.** Where a reload needs credentials the script must not hold, restart instead; a service on loopback with its state on a volume costs nothing to restart.

**2.6 — Never quote a fixed baseline SHA in the briefs of a SEQUENTIAL pipeline.** *(Plan 05, T2/T3/T4/T5 — four agents, four reconciliation paragraphs)*
Every brief carried *"The repo is at commit cc22b19 on main"*, true only for T1. T2 found `c66e76b`, T3 found `2b8c6a9`, T4 found `45475fc`, T5 found `5011bc2` — and each one stopped, investigated whether it was looking at drift, and wrote a paragraph explaining why it proceeded anyway. All four reasoned correctly and none was harmed, but it is four rounds of avoidable doubt bought with tokens, and a more literal agent would have halted. The same line's *"45 suites / 208 tests"* caused T3 to report the baseline as irreconcilable — it was comparing its per-workspace `apps/core` count against a repo-wide total, and the two do reconcile exactly. **In a sequential pipeline, state the baseline as "the previous task's commit, i.e. current `origin/main`" and give test counts per workspace, or omit the numbers.**

---

**2.78 — A COMPILE-TIME CENSUS EXPIRES WHEN PHASE 0 LANDS (§2.73) — AND SO DO LINE NUMBERS, IN THE SAME COMMIT, FOR THE SAME REASON.** *(Plan 11c compile, 2026-08-23 — caught at zero cost by running the §2.73 re-grep and then noticing what else had moved)*
§2.73's rule is *re-run the §2.65 greps AFTER Phase 0 and state a census as "N at commit `<sha>`"*. I did: three `JobIntervals` object literals at `7bfdd3a`, unchanged from the pre-Phase-0 count. **But R0-2 restructured `scheduler.test.ts`, and every line reference the plan cited for that file went stale in the same commit** — `THE_NINE` 140→168, `CENSUS_INTERVALS` 223→251, `CENSUS_DAILY_TICK_MS` 261→289, M-S2 304→460. The plan's D6 names those coordinates to tell T3 where to work.
**The rule: a plan's line references are a census too, and Phase 0 invalidates them exactly as it invalidates a count.** After Phase 0, re-resolve every line reference the plan makes into a file Phase 0 touched, and **brief the task to navigate by SYMBOL rather than by the plan's coordinates**. Cheap tell: a Phase-0 commit's `--stat` names the files whose line references are now suspect; here it was one file and the sibling `worker-runtime.e2e.test.ts` was genuinely unaffected, so `:100`/`:317`/`:366` stayed exact and could be quoted with confidence. **A coordinate is a claim with no expiry date on it, and §2.73 is the entry that already said so about counts.**

**2.79 — ARCHIVED 2026-08-24 (Plan 11f close, v3 §5): there is no Windows authoring host — see ARCHIVE at the foot.** ~~CRLF IS A LIVE HAZARD IN THE RULE-22 MIRROR WORKFLOW: TWO AGENTS HIT IT IN ONE PIPELINE, AND IT SHIPS AS A WHOLE-FILE REWRITE THAT LOOKS LIKE A SCOPE VIOLATION.~~ *(Plan 11c, T2 and Phase 0's R0-2, 2026-08-23 — one extra commit, one near-miss)*
Rule 22 has agents authoring on a Windows host and syncing to a Linux build host. **Windows tooling rewrites line endings, and the diff that reaches the server is then every line of the file.** T2's three files landed CRLF and shipped as **717 insertions / 717 deletions** — a change whose `--stat` is indistinguishable from a rewrite of somebody else's work, and which needed the correction commit `74dea4d`. R0-2 hit the same trap from a different direction: `git apply` on the mirror silently converted its target, which would have turned a 126-line patch into a 566-line one; **it was caught only because the agent byte-inspected the result with `od -c` instead of trusting `git diff --stat`.**
**Two rules.** (a) **After any Windows-side write or patch, verify line endings before syncing** — `od -c | head` or `file`, not a visual diff, because CRLF is invisible in every rendered view. (b) **When the edit is surgical and the file is large, prefer patching SERVER-SIDE** (a `python3 - <<'PY'` heredoc over ssh, reading and writing with `newline=""`), which cannot introduce the problem at all. The main session used exactly that for its own remediation in this run, deliberately, having watched the trap fire twice. Note the second-order damage: a whole-file diff defeats the per-commit `--stat`-against-the-Files-list check that every gate and mechanical check runs, because the file IS on the list and only its size is wrong.

**2.80 — ONE GREEN RUN NEVER CONFIRMS A FLAKE FIX, AND A FIXED SETTLE COUNT IS THE WRONG INSTRUMENT FOR A LATENCY-BOUND WAIT.** *(Plan 11c, 2026-08-23 — my remediation `766cade`, reported as fixed on one green CI run and refuted by the very next commit)*
§2.76 says *to tell a flake from a regression, re-run a commit you already believe.* **This is its mirror, and I got it wrong in the same run I wrote §2.78 in.** I landed a census fix, CI went green on attempt 1, and I reported the defect closed. The next commit — four markdown files, incapable of reaching any test — came back **red with the identical signature**. Against a roughly one-in-four failure rate a single green is exactly what luck looks like. My own gate report contained the sentence *"one green run is one data point"* while I was simultaneously treating one green run as confirmation.
**The technical half is worth as much as the process half.** The fix that failed added explicit stops with a **fixed 50-turn settle** at each. The shape's own comment defends that choice: *"on a starved container each turn takes LONGER, so the same count buys proportionally more real time."* **That reasoning is false whenever the thing being waited on is ONE round-trip's latency rather than accumulated event-loop work** — 50 turns of an otherwise idle loop is ~50 ms whatever the load, while a single database write on a contended container can take several times that. The measurement that settles it: the same test ran **37.6 s on CI against 2.9 s on the build host**.
**Two rules.** (a) **Wait on the CONDITION, not on a count** — `settleUntil(() => done(), maxTurns)` costs one turn when the work is already finished and as many as the machine needs when it is not; it is self-scaling, bounded, and it cannot make a broken assertion pass because the assertion after it is unchanged. (b) **A flake fix is confirmed by several consecutive greens across commits that touch UNRELATED files, never by one** — and until that bar is met, the honest report says "a better instrument with an argument behind it", not "fixed". Corollary for a report already committed: **correct it in place rather than let the wrong claim stand**; the run's honest record is worth more than a tidy one.

**2.81 — A PLAN'S STATED MUTANT IS ITSELF A PREDICTION, AND TWELVE OF THIS BOOK'S DID NOT SURVIVE EXECUTION.** *(Plan 11d, 2026-08-24 — the run's headline, found by the tasks and gates that were asked to build them)*
Rule 21 says never claim an assertion discriminates unless you built the mutant and watched it FAIL. **The corollary this run earned: the mutant the PLAN names is a prediction with exactly the same standing as the assertion it is meant to test.** Plan 11d's Assertion Book had 21 rows; 32 mutants were built; every required-DIED mutant died. **And twelve rows or design claims were refuted by execution**, each of which would otherwise have shipped as green evidence proving nothing:
R1's "force the bound to 1 turn" is a NO-OP — on a healthy box `done()` is true on turn 0, so it passes at exit 0 under both budgets · V2's three named exceptions are all HELD, because they were justified by *guards no route* while V2 asserts *held by a role* · V3's "parser returns `[]` instead of throwing" cannot fail, because every real README cell is recognised and the `throw` branch is unreachable · V10's "exactly one appended row per round in all three" is false for case B **and could never have killed either mutant there**, since shipped, no-lock and wrong-position all produce `appended=2` · V13's mutant WAS the shipped code while a chain halt stood · V15's "each must die on THIS leg with the others green" is structurally impossible for three of four · D2's "the worker installs a smaller SUBSET" is measurably false (it omits `ops` and adds `notify`) · D5's "ahead of the refusal AND the read, BOTH" is only ahead-of-the-read, proven by a mutant that SURVIVED 4/4 across 15 rounds · D9's leg-4 uniqueness holds only in its strong form · **D9's leg-10 independence is provably false — leg 10 ⊆ (leg 8 ∧ leg 9)** · D1's exceptions list held the wrong property · V2's census summed to 56, not 59.
**Only ONE row (V20) survived contact intact.** **The rule: when a task finds its stated mutant cannot fail, that is a DISCOVERY and outranks the kill it was asked for — say so plainly and build the one that can.** Every agent in this run did, and each disclosure was worth more than the mutant it replaced. The cheap tell at authoring time: *if the shipped code already satisfies this mutant's premise, what exactly changes when I apply it?*

**2.82 — THE FILE-OWNERSHIP GRAPH IS NOT THE GRAPH A WIDENING CHANGE TRAVELS ALONG; WALK THE ASSERT-ON GRAPH, TRANSITIVELY, INCLUDING ASSERTIONS THE WIDENING TASK ADDS IN THE SAME COMMIT.** *(Plan 11d T3's chain halt, and then its gate — my compile defect, twice, one hop apart)*
A plan's File Structure gives every file ONE OWNER. It does not model **which files ASSERT ON which files' behaviour**, and that second graph is what a change to a value travels along. T3 added `changeId` to the `ops.mode_changed` payload; the compile sweep enumerated every reader of the PAYLOAD and found them all. The break was two hops downstream — `test/ops-lifecycle.e2e.test.ts:319` pins the ALERT's `refId`, which is a value the payload produces — and that file was frozen to T3. T3 built the repoint, MEASURED the break, backed it out under §3(a) and shipped half the design.
**Then the amendment routing that work walked the new graph ONE HOP AND STOPPED**, saying "two lines across two files". T3's gate built the repoint itself and found a THIRD reader, `consumer.test.ts:659` — **inside T3's own file, written by T3 while raising the halt.** So a compile-time sweep structurally could not have seen it.
**Two rules. (a) Walk the assert-on graph to a FIXPOINT, not one hop.** (b) **Include assertions the widening task ADDS in the same commit** — the set is not fixed at compile time. The cheap mechanical form: for every value a task widens, grep for the value's consumers, then for THEIR consumers' assertions, and repeat until nothing new appears.

**2.83 — AMENDING A TASK'S BODY WITHOUT AMENDING THE FILE STRUCTURE IS §2.54'S DEFECT ONE DOCUMENT EARLIER.** *(Plan 11d, found by T4's gate)*
§2.54 is about the pipeline script's `files` arrays drifting from the plan's File Structure. **This is the same drift between two parts of the PLAN.** When the chain halt above routed work to T4, I amended Task 4's BODY to name three files and left the File Structure assigning `consumer.test.ts` to T3 alone. §2.25 makes the frozen-path block **generated** from those lists — so the amended brief REQUIRED an edit the generated block would have FORBIDDEN, which is §2.72's consequence exactly: the coder obeys the brief, correctly, and a reviewer reads a scope violation.
**The rule: every amendment that changes WHO TOUCHES WHAT must touch BOTH lists, and the compile sweep's "assert the arrays equal the File Structure, both directions" must be RE-RUN after any mid-run amendment — not only at compile.** It did not bite T4 (its brief was explicit and later than the block); it would have bitten the next reader.

**2.84 — `gh run list --commit <SHORT-SHA>` RETURNS `[]` SILENTLY, WHICH IS INDISTINGUISHABLE FROM §2.59's DID-NOT-RUN.** *(Plan 11d main session, 2026-08-24 — caught on myself, at zero cost, by re-querying)*
§2.59 established that a CI result has three states — green, red, and DID NOT RUN — and that the third reports identically to the second. **There is a fourth thing that reports identically to the third, and it is the query.** `gh run list --commit 03d4e90` returns an empty array; `gh run list --commit 03d4e903a22ef281e26149fdcee2232c25f6b556` returns the green run. I read two commits as never-dispatched on exactly that basis before re-querying.
**The rule: always query CI by FULL SHA, and treat an empty result as "the query was wrong" until the full SHA has been tried.** The execute prompt has said "CI green by FULL SHA" since Plan 08.5; **this is the measurement showing the word FULL is load-bearing rather than stylistic.**

**2.85 — A RAW CONTROL BYTE PAST GIT'S 8000-BYTE BINARY HEURISTIC SHIPS INVISIBLY, SURVIVES CI, AND MAKES THE FILE UN-GREPPABLE.** *(Plan 11d T1, found by its gate — not by the coder, not by review, not by CI)*
`seed-roles.ts` shipped **two raw NUL bytes**: a `\0` composite-key separator that a heredoc interpreted during authoring instead of writing the escape into the source. Semantically the right separator; what shipped was the byte. **CI was green, V5 exercises that exact path and passes, and the diff rendered normally in review — because the bytes sat at offset 14621, past git's 8000-byte binary-detection window.** The cost: `grep` and `rg` degrade to `binary file matches` on the ONE file that is the role model's source of truth. The gate hit that wall on its first search.
**Two rules.** (a) **Write control characters as ESCAPES (`\u0000`), never as raw bytes** — identical at runtime, greppable in source. (b) **Byte-check every file authored through a heredoc**: `tr -cd '\r' | wc -c` = 0 **and** `tr -cd '\000' | wc -c` = 0. §2.79 taught the CR half; this is the same lesson one byte over, and the NUL half is worse because CRLF at least shows up as a whole-file diff.

**2.86 — ADDING A REQUIRED FIELD TO AN EVENT WHOSE STREAM IS APPENDED AND IMMUTABLE POISONS HISTORY, AND THE LOSS IS SILENT BY CONSTRUCTION.** *(Plan 11d T3, found by the DISCOVERY REVIEWER after six per-task gates had returned ACCEPT)*
T3 added `changeId: z.string().min(1)` — required, no default, no version bump — to `ops.mode_changed`, and `handleModeChanged` opens with `payloadSchema.parse(e.payload)`. **Every row already in a live `events` table lacks that field.** Measured through five dispatch cycles: **0 alerts raised, `status=parked`, `attempts=5`, dead-lettered, `consumer.poisoned` raised.** The control with the field present delivers in one cycle.
**The silence is the sharp half.** `consumer.poisoned` has **zero subscribers** in the tree; `event_dead_letters` is read by exactly one thing — the retention sweep, which DELETES from it and is inert under `RETENTION_ENABLED=false`; no alert rule reads either; **and a dispatch cycle that parks an event is a SUCCESSFUL run to the scheduler's staleness rules.** The most likely arming path is not a deploy: **any NEW consumer starts at cursor 0 and replays every historical row, blocking its whole in-order stream.**
**The rule: a schema over an appended immutable stream is a statement about HISTORY, not a message contract. Widening a field is the only cheap direction — add it OPTIONAL and let the consumer carry the fallback — and any tightening needs an explicit version with a legacy branch.** And the second-order rule this exposed: **something must watch `consumer.poisoned`**, or every defect of this class is invisible for ever.

**2.87 — A TASK THAT PUSHES IS A TASK THAT MUST RUN WHAT CI RUNS. §2.8's "full suite ONCE, at the end" SILENTLY BECAME A PER-COMMIT GAP.** *(Plan 11e T2 and T4, 2026-08-24 — two red commits on `origin/main`, cause still unidentified)*
§2.8's test-run economy is correct and this session obeyed it: narrow suites while iterating, the full workspace suite once at the end. But under v3's LIGHT lane **the session commits and PUSHES after every task**, and each push is what CI judges. T2's evidence was typecheck, lint and a 14-suite blast radius; T4's was typecheck, lint and the full `apps/core` suite — never `packages/contracts`, never `apps/web`, never `pnpm verify` itself. **Both went RED in CI while the build host called them green.** The phase's own close verify was exit 0, so nothing was broken at HEAD; what was broken was the evidence standard at two intermediate commits, and the cause could not be recovered because job logs need a credential the build host does not have.
**The rule: before the finish block's push, run the same command CI runs — `pnpm verify`, detached, exit value from a file.** "The end" in §2.8 means the end of a phase for a HEAVY pipeline whose waves land together; for a lane that pushes per task, the end is every commit. The economy §2.8 protects is real, so the clause is narrow: iterate on narrow suites freely, but the run that PRECEDES A PUSH is the full one.

**2.88 — A PARITY PIN BETWEEN TWO HAND-MAINTAINED LISTS CANNOT SEE WHAT IS IN NEITHER, AND THREE PRODUCTION SURFACES WENT DARK UNDER ONE.** *(Plan 11e CLOSE, found by the independent reviewer; two of the three predate 11e by whole plan cycles)*
`test/caddyfile-parity.test.ts` exists precisely to stop an API prefix going dark in production — its docstring names the failure exactly: *"a module adds a prefix to vite, works perfectly in dev, and in production its calls fall through to the SPA handler and come back as index.html with HTTP 200."* It compares `vite.config.ts`'s proxy keys to the Caddyfile's `@api` matcher and it was GREEN throughout. **Three prefixes the SPA actually calls were in NEITHER list**: `/admin` (11e's whole surface), **`/ops` — Plan 11c's operating-mode and downtime-kit screens, dark since 11c shipped, one letter from the proxied `/opd`** — and `/tariff` (the billing counter's service picker). A pin over two copies of a fact is blind to a fact absent from both copies.
**The rule: a parity pin over N hand-maintained copies needs an N+1th source DERIVED FROM USE.** Here that is the set of prefixes `apps/web/src` actually requests, parsed from the call sites, asserted as a subset of the proxied set — independent of both lists, and it names the offenders rather than comparing lengths. This is §3.42's closing move generalised: **a leg must read something that is not the thing under test.** Cost: an emergency downtime surface unreachable in production for a whole plan cycle, under a green test written to prevent exactly that.

**2.89 — WHEN A GUARD AND A COUNTER ANSWER THE SAME QUESTION IN DIFFERENT CODE, THE PAIR IS EXPLOITABLE EVEN WHEN BOTH ARE CORRECT ALONE.** *(Plan 11e T3, found by the independent reviewer as C2 — a permanent admin lockout reachable in two authorised requests)*
The phase's named safety property was "no mutation may leave zero active users holding `auth.users.manage`". The guard on every admin route is `@RequirePermission(…, "hospital")`, and `hasPermission` REFUSES a `department`- or `floor`-scoped holding against a hospital requirement. The invariant's counter joined `role_assignments ⋈ role_permissions ⋈ users` **with no scope predicate**. So its holder set was a SUPERSET of the set that can reach the routes, and the difference was exactly what it existed to protect: give the sole administrator a second, department-scoped assignment of the same role, then revoke their hospital-scoped one. The counter saw two holdings, answered 204, and left a deployment whose only administrator is 403 everywhere — repairable only by direct database access. **Both pieces of code were individually correct**; the defect lived in the gap between them, and the shipped tests used hospital scope exclusively, so nothing could see it.
**The rule: where an invariant counts WHO MAY DO SOMETHING, derive the count from the function that DECIDES whether they may — or, where that is impractical, make the counter strictly stricter than the guard and say so.** Stricter can only refuse a legal act; looser permits the catastrophe. (This phase's counter excludes temporary grants deliberately, which is the safe direction and is now stated in the code.)

**2.90 — DELETING A DEFECT WITHOUT RETIRING ITS DOCUMENTATION LEAVES THE OLD BEHAVIOUR ASSERTED IN EIGHT PLACES, ONE OF THEM EMITTED TO AN OPERATOR AT THE MOMENT THEY NEED THE REPAIR.** *(Plan 11e T5, found by the independent reviewer as M4)*
T5 deleted `seed-admin.ts`'s early return — MAJOR 1's residual — and made re-running the script the documented repair it had always claimed to be. **Eight places in `scripts/` still asserted the early return still existed.** Seven were prose. The eighth was `seed-roles.ts`'s census PROBLEM STRING: *"NOTE that seed:admin RETURNS EARLY on a deployment that already has an admin, so a permission declared after first boot will never be granted by re-running it — it needs granting explicitly."* That text is printed to whoever is repairing a deployment, and it steered them away from the fix the same phase had just built.
**The rule: a commit that removes a behaviour retires every claim about it in the same commit, and EMITTED text ranks above comments in that sweep.** `grep` for the behaviour's own name before closing. This is §2.78's class in the emitting direction: not a stale document being read, but a stale document being *printed as guidance*. (Its test pinned the stale sentence and failed on the correction, which is the pin working — the assertion then moves to the property, not the wording.)

**2.91 — "THE BUILD HOST CANNOT SEE CI" WAS TRUE OF THE TOOL AND FALSE OF THE QUESTION.** *(Plan 11e CLOSE, 2026-08-24)*
EXECUTE-METHOD-V3 §8 rules that `ci-watch.sh` stays off the build host because `gh` cannot authenticate there, and `ci-watch.sh`'s own header says the same. **Both are correct about `gh` and neither is correct about CI.** The repository is public, so the UNAUTHENTICATED GitHub API answers `/repos/{owner}/{repo}/commits/{sha}/check-runs` and `/actions/runs/{id}/jobs` over plain `curl` from the build host — which is the only reason §2.87's two red commits were found at all, rather than at some later phase's close. Job *logs* remain 403, so the failing test could not be identified; conclusion/duration/step-level status are all readable.
**The rule: when a method records that a host cannot do something, record WHICH TOOL was tried.** A capability ruling stated against a tool expires the moment another route exists. A ~15-line `curl` poller gives a build-host session green/red per SHA with no credential, and §2.55's "CI is watched, not assumed" stops depending on which machine the session runs on.

**AMENDED IN PLACE 2026-08-26 (Plan 16a), AND THE ENTRY PREDICTED ITS OWN EXPIRY.** ~~Job *logs* remain 403, so the failing test could not be identified.~~ **`gh` IS AUTHENTICATED ON THE BUILD HOST** — `gh auth status` reports account `ankits3a` with a PAT under `/root/.config/gh/hosts.yml`, and `gh run view <id> --log-failed` returns the failing test by name. Plan 16a's T6 red (run `32959218495`) was diagnosed from this host in one command: two race legs in `billing/receipts.test.ts` and one in `sessions.test.ts` timing out at 15 s on a starved runner, plus the fixture-collision cascade a timed-out `beforeEach` leaves behind. **A session that had trusted this entry's own struck sentence would have reported "not diagnosable from here" and left a real, fixable flake on `main`** — which is exactly the failure mode the rule above describes, one turn later, with this entry playing the part of the stale method. **Check the tool before quoting the ruling: `gh auth status` costs one line.** The `curl` poller stays — it needs no credential and is the right default for a verdict — but the LOG half of this entry is dead.


**2.92 — `git add -A` IS NOT SAFE ON A HOST SOMEBODY ELSE IS WORKING ON, AND READING THE STATUS FIRST DOES NOT MAKE IT SAFE.** *(Plan 11g, twice in one session; the second time it pushed 457 lines of the owner's work under a commit message that does not mention it)*
AGENT-RULES §5 step 0 already says *"never run `git add -A` over a status you have not read"*, and the status WAS read both times. That is what makes this a new entry rather than a rule ignored. **Reading `git status` tells you what is in the tree NOW; `git add -A` stages what is in the tree AT COMMIT TIME**, and rule 8 says the owner may be working on the same host from the same key — so between the read and the commit, files that are not yours can appear. They did: a 457-line Plan 11h draft landed while a ~9-minute `pnpm verify` ran, and went out inside a commit about auth throttling. The first occurrence the same session was recoverable (a mixed commit `origin/main` had never seen, split with `git reset --soft`); the second was already pushed, so rule 15 forbids the obvious repair and rule 2's boundary forbids the other one — deleting somebody else's file to tidy your own commit is worse than the mis-attribution.
**The rule: stage EXPLICIT PATHS from the task's Files list — `git add -- <path> …` — and never `git add -A`.** The Files list already exists, the paths are already written down, and the enumeration costs one line. `git status --porcelain` before the commit remains right and remains insufficient: it is a check on what you are about to stage, not a substitute for naming it. *(Corollary, recorded because it is what saved the first occurrence: a mixed commit that has not been pushed is cheap to split; the same commit thirty seconds later is permanent. Check `git rev-parse origin/main` against `HEAD` before reaching for any correction.)*

**2.93 — A FORMULA VERIFIED ON FIXTURES WHERE A RATIO EQUALS 1 HAS NOT BEEN VERIFIED. CHECK THE REGIME WHERE ITS NUMERATOR EXCEEDS ITS DENOMINATOR.** *(Plan 09, found by the independent close reviewer; nine golden fixtures and forty dead mutants had all sat at the same ratio)*
Plan 09's accrual base is `targetBase = divHalfUp(eligibleBase x collected, settleable)`. Its spike measured the regime `collected == settleable`, the plan's nine golden fixtures were written from the spike, and every one of them therefore held that ratio at exactly 1. `collected > settleable` is not exotic — a credit note moves `settleable` immediately while `collected` does not move until a refund voucher is PAID — and in that regime the unclamped ratio makes the base the WHOLE invoice instead of the eligible part: crediting a line the agreement pays nothing on raised the commission on an unrelated line by 56%, and the pure probe reached 5x the live eligible base.
**The mutants could not have found it.** Every one of them mutated the FORMULA against fixtures whose inputs never left the verified regime; the shipped formula and the mutants agreed about what a fixture was allowed to contain. **A mutant tests the implementation against the fixture. Nothing tests the fixture against the input space.**
The mechanical form, and it costs one line per ratio: **for every quotient a plan computes, name the regimes of its operands — less than, equal to, greater than — and require a fixture in each that the arithmetic can distinguish.** The same discipline the Assertion Book applies to implementations, applied to inputs. A related tell that fired here and was read as intended behaviour: the suite already CONSTRUCTED the unverified regime (`accrual.test.ts`'s F8 leg builds 250 000 collected against 150 000 settleable) and asserted the unclamped answer with a comment defending it — defensible for the all-eligible invoice it used, false for a mixed one. **When a test constructs a regime your fixtures never cover, that is the fixture gap announcing itself.**

**2.94 — A FILES LIST GRANTS PERMISSION TO COMMIT A PATH; ON A SHARED HOST WHAT IS NEEDED IS PERMISSION TO COMMIT A HUNK.** *(Plan 09 T8 `927afc6`, 2026-08-26 — §2.92 recurring, round-tripped, and this time it cost another lane's finished work)*
Three sessions ran in `/opt/hmis` on one day. T8's brief said, correctly, *"`git add` the paths your Files list names, BY NAME"* — and T8 did exactly that. Its Files list named `README.md` and two locale catalogs, which were dirty because ANOTHER lane was mid-edit in them. The commit swept ~90 lines of that lane's uncommitted work, **went CI red**, and the follow-up commit reverted them as scope creep — correct from T8's side, and it deleted finished documentation from the tree while its own session was still testing. All of it was recoverable (`git show 927afc6 -- README.md`) and was re-landed, verified byte-for-byte, in `1bff417`.
**Staging by path is necessary and not sufficient.** The mechanical form: on a host where another lane may be live, a task diffs the paths it is about to stage **against the SHA it started from** and reports any hunk it did not write — `git diff <start-sha> -- <paths>` before `git add`. That check costs one command and is the only thing that distinguishes "my file" from "my change".
The wider protocol this belongs to is [`plans/reports/2026-08-26-parallel-session-protocol.md`](2026-08-26-parallel-session-protocol.md), written by the session that cleaned up after this.

**2.95 — A STOP-LOSS IS SET FROM THE LAST COMPARABLE PHASE'S PER-TASK RATE TIMES THIS PHASE'S TASK COUNT, NEVER FROM ITS TOTAL.** *(Plan 09, 2026-08-25 — EXECUTE-METHOD-V3 §6 applied with the wrong denominator; §2.68 one level out)*
v3 §6 says a stop-loss is set "from the actuals of the last comparable phase (e.g. 1.5x its actual)". Plan 09 took 1.5 x Plan 11d's **total** (2,884,873 for FIVE tasks) and applied it to an **eight**-task phase, giving 4.5M — a ceiling arithmetically incapable of covering the work before a single agent ran. It fired mid-phase and halted for an owner decision that was not about waste: pipeline A measured **583,827 tokens per task** against 11d's **576,975**, agreeing to within 1.2%. The honest tripwire was 1.5 x 577k x 8 = ~6.9M, and the phase finished at 6.03M — inside it.
The phase document had even predicted the failure mode in prose (*"the tripwire may fire on SCOPE rather than on waste"*) and then not done the multiplication. **A caveat is not a calculation.** §2.68 says check the token target against the Assertion Book's row count at compile time; this is the same check one level out — count the TASKS, and normalise the comparable before you scale it.

**2.96 — A "CHECKED AND CLEAR" VERDICT IS SCOPED TO THE ASSERTIONS YOU LOOKED AT, NOT TO THE FILE.** *(Plan 09 compile sweep, 2026-08-25 — three pinned censuses moved, the sweep found one)*
The compile sweep caught `caddyfile-parity.test.ts`'s SPA route count and recorded, in the same pass, *"Checked and clear: `deploy-parity.test.ts`"* — true about the compose services, the config directories and the restart loop it examined, and blind to the **seed census three paragraphs below them**. A later task broke it, corrected the integer and disclosed it as a plan defect. A third census in `worker/seed-cursors.test.ts` moved the same way one task later. **One shape, three instances, one found.**
The mechanical form: **do not sweep for the files you expect to be affected — grep the test tree for `toHaveLength(` and for fixed-array equality over anything the phase adds to, and resolve each hit.** A verdict about a FILE is worth nothing; the unit is the assertion. This is §3.54's rule ("a criterion naming one location for a sweep whose rule says EVERY location") pointed at the sweeper rather than the criterion.

**2.97 — AGENT COST IS `TURNS x CONTEXT`, AND UNTIL PLAN 09 NEITHER TERM HAD EVER BEEN MEASURED.** *(Plan 09, measured after the fact from the workflow journals; the entry the owner asked for by name)*
Plan 09 spent ~7M tokens on eight tasks. The assumption — everyone's — was that the work was expensive. Measured: **OUTPUT, every line of code, every mutant, every test, was 2.08M. CONTEXT RE-READ was 871M — 420x the output — at an average of 374,461 tokens carried into EVERY ONE of 2,327 tool calls.** An agent pays for its whole context on every call, so cost is the product of two terms, and **the product was never the thing anyone watched.** The stop-loss watched a total; the Assertion Book watched rigour; nothing watched context.
**Where the context came from, measured:** the prompt blocks the pipeline itself rendered were **3,695 tokens** — not the problem. What the briefs TOLD each agent to read was: the ledger **80,655**, the phase document **36,992**, the relay **34,087** and growing all run, AGENT-RULES 6,137. **~152k of documentation per agent, of which each needed perhaps 15k, re-billed on every call.** The turn mix was **2,108 Bash of 2,327 calls (91%)** — agents reading through `cat`/`sed`/`grep`, one billed turn each.
**The mechanical form, and it costs nothing:** before compiling, `wc -c` every file a brief points at and divide by four. **Cite ledger entries BY NUMBER instead of pointing at the ledger. Point at a task's own section, not the whole phase document. Address relay entries to the task that needs them.** At 150k context instead of 374k the same 2,327 turns cost 349M instead of 871M — **a 60% cut with nothing verified less.** The three levers in order of measured leverage are context-per-call, then turns, then agent count; take agent count LAST, because it is the only one that can cost verification.
**The apparatus:** [`../../pipelines/token-audit.js`](../../pipelines/token-audit.js) measures both terms in one command at zero model cost, [`token-baselines.json`](../../pipelines/token-baselines.json) holds the per-phase record, and the `token-audit` skill fires from a PostToolUse hook at every close and every deploy — because this is exactly the step a session skips when the phase is finally green.

**2.98 — A BASE RATE COMPUTED OVER COMMITS IS NOT EVIDENCE ABOUT A PARTICULAR RUN, AND IT NEARLY OVERRULED §2.64.** *(Plan 09 close, 2026-08-26 — my own reasoning error, refuted by the experiment it almost talked me out of)*
Plan 09's CLOSE commit went CI red while the same tree was `pnpm verify` exit 0 twice locally. §2.64 says a red whose diff cannot explain it is a candidate for RE-RUN before it is a candidate for diagnosis. I instead counted eighteen CI observations across the phase and two parallel lanes, found two reds (one already explained), and argued that **"one unexplained red in eighteen is not §2.76's ~1-in-4 flake"** — concluding the cause was probably deterministic and inside a four-line diff.
**It was not.** The controlled second observation — a commit differing from the red one by 41 lines of markdown and, measured by `git diff --name-only -- apps/ packages/ docker/`, **nothing on the test surface at all** — came back GREEN. Red then green on byte-identical code is nondeterminism, proven.
**The rule: an aggregate over commits says nothing about which specific run flaked, and it must never outrank the one cheap measurement that answers the specific question.** A base rate is a prior; §2.64's re-run is an observation, and it costs one push. Compute the base rate AFTER, to decide whether the flake is worth hunting — never BEFORE, to decide whether to look.

**2.99 — A TEST THAT MUTATES AN INPUT MUST PROVE THE MUTATION MUTATED, AND A FIXED REPLACEMENT CHARACTER DOES NOT.** *(Plan 09 T7, found by the owner's `gh` log after it turned the phase's own CLOSE commit red — the FIRST defect this project's CI ever surfaced that its build host could not reproduce on demand)*
The assertion was *"a code differing by ONE CHARACTER resolves to nothing"*, and it built that code as `` `${code.slice(0, -1)}X` `` — replace the last character with a literal `X`. Attribution codes are `RF-` plus the last ten characters of a **ULID**, and ULID is Crockford base32, so **one code in thirty-two already ends in `X`.** On those runs the "mutated" code is BYTE-IDENTICAL to the original, the lookup correctly finds the record, and `toBeNull()` fails. **The test did not test what it says; 3.1% of the time it asserted that a record does not exist while asking for that exact record.**
**Two sites carried it** (the unit test and the e2e), so the phase ran at ~6% chance of an unexplained red per CI run — which is exactly the observed rate: one red in eighteen observations.
**What made it expensive was not the bug, it was the shape.** A red whose diff cannot explain it, on a build host that is green twice over, with job logs behind a credential — §2.91's diagnosis gap made concrete. It consumed a controlled re-run, an hour, and a wrong intermediate conclusion (§2.98).
**The mechanical form, and the throw is the point rather than the swap:** [`test/helpers/mutate.ts`](../../../../apps/core/test/helpers/mutate.ts)'s `differingByOneChar` picks the other of two candidates and **THROWS if the result equals its input**. A helper that merely picked a different letter would fix these two sites and be silently re-broken by the next one; this one cannot return its input, so a future alphabet or prefix change fails LOUDLY at the line that built the fixture. **Generalised: any fixture built by perturbing a real value must assert the perturbation changed it.** §3.14's family — an assertion whose fixture cannot separate right from wrong — with a new and very cheap mechanism.
**2.100 — A CAPABILITY CLAIM IN THIS FILE EXPIRED, AND THE SESSION THAT BELIEVED IT ALMOST LEFT A FIXABLE FLAKE ON `main`.** *(Plan 16a, 2026-08-26 — and the entry it disproves is §2.91, nine entries up)*
§2.91 ends *"job **logs** remain 403, so the failing test could not be identified"*, and Plan 16a's session quoted it: T6's CI red was written up as un-diagnosable, handed to the owner as a one-command action, and the phase moved on. Then the TOOL was checked instead of the ruling. **`gh auth status` reports an authenticated PAT on the build host** — somebody logged in after §2.91 was written — and `gh run view <id> --log-failed` named the failure in a single call: two race legs in `billing/receipts.test.ts` and one in `sessions.test.ts` hitting `Exceeded timeout of 15000 ms` on a runner taking 1760 s against its neighbours' 649-778 s.
**§2.91's own rule is what was violated, and §2.91 is what violated it:** *"when a method records that a host cannot do something, record WHICH TOOL was tried — a capability ruling stated against a tool expires the moment another route exists."* A rule that names its own expiry condition is worth nothing if the next reader treats the entry as the fact rather than as a measurement with a date on it.
**The mechanical form, one line before any "this host cannot" claim is repeated:**
```
gh auth status && gh run view <run-id> --log-failed
```
**The general rule: an entry asserting an ABSENCE — no credential, no tool, no route — carries an expiry that a positive finding never does.** Cite it with the check, or do not cite it. *(Cost, had it stood: a real flake left on `main` behind an "unfalsifiable" label, and every later phase inheriting a red nobody could read. Cost of the check: one command.)*

**2.101 — THIS LEDGER IS NOW 82,000 TOKENS AND EVERY HEAVY PHASE RE-BILLS IT PER AGENT, PER CALL.** *(Plan 16a token audit, 2026-08-26)*
Measured: `EXECUTION-LESSONS.md` is **329,574 bytes ≈ 82k tokens**, against the ~81k Plan 09 was billed on every one of its 2,327 tool calls (§9 of the method, and the 871M context re-read that bought that section). The ARCHIVE pass v3 §5 created has run twice and retired **three** entries — §2.40, §2.79, §2.33 — while the file gained two more in this session alone. **Archiving is losing to accretion by roughly 1:10.**
LIGHT phases do not pay it: 16a ran nine tasks with zero subagents and re-billed nothing to anyone. That is exactly why the liability is invisible until the next HEAVY phase, which is charged 82k × every agent × every call.
**The mechanical form — the number joins every audit, beside the phase's own spend, so the trend is visible before it is expensive:**
```
wc -c docs/superpowers/plans/reports/EXECUTION-LESSONS.md   # / 4 = tokens re-billed per agent per call
```
**The rule it suggests and does not yet impose: a brief cites ledger entries BY NUMBER and carries none of the file.** §9.1 already says it; what is new is the measurement of what saying it is now worth.
**2.102 — THE INDEPENDENT REVIEWER IS THE ONLY INSTRUMENT THAT REFUTES, AND IT FOUND THREE CRITICALS IN CODE THAT HAD PASSED ELEVEN GREEN VERIFIES.** *(Plan 16a close, 2026-08-26 — measured)*
Plan 16a ran nine tasks with zero subagents and one reviewer. **The reviewer cost 181,605 tokens across 37 tool calls and returned three CRITICAL, five MAJOR and six MINOR findings** — against a tree that had already passed **eleven `pnpm verify` runs and eight green CI runs**, plus fourteen mutants of the phase's own design.
**The comparison that matters is not cost, it is KIND.** All fourteen mutants DIED. A dead mutant confirms that an assertion discriminates; it cannot tell you the assertion is aimed at the wrong thing. Every one of the three CRITICALs lived in the ONE seam the phase's tests could not see into — the pure check suite was correct and the pipeline fed it wrong inputs — and the fixtures made all three invisible by construction: drug text always equal to brand name, formulary always freshly seeded and fully active.
**The mechanical form, and it is a fixture rule rather than a review rule:** for every fixture a phase builds, name the field whose value is IDENTICAL to another field's, and write one leg where it differs. Text-equals-brand hid C1 and C2. Fully-active-formulary hid C3. *(Related: §2.93 — a formula verified where a ratio equals 1 has not been verified. Same defect one layer out: a FIXTURE whose fields coincide has not exercised the code that distinguishes them.)*
**And the budgeting consequence:** a LIGHT phase's saving is not a saving until its reviewer has run. Nine tasks of in-session coding produced a tree that looked finished, was green everywhere, and carried three patient-safety defects. The 181k was the cheapest part of the phase.


**2.103 — A MIGRATION THAT ADDS A UNIQUENESS CONSTRAINT CAN FAIL ON DATA THAT ALREADY EXISTS, AND THE FIRST DATABASE IT BREAKS IS YOUR OWN TEST WORKER.** *(Plan 09a T2, 2026-08-26 — measured, nineteen suites red)*
`0028` drops `commission_accrual_subjects_ux` and recreates it on a NARROWER key. The fail-first run that proved the defect — a backdated agreement opening a second subject for one invoice — left those two rows in worker database `hmis_test_1`. The migration then could not apply: **nineteen suites failed, every one with `error: could not create unique index`**, plus a `TypeError: teardown is not a function` where `setupTestDb` threw before returning. The code was correct; the DATABASE was carrying what the migration now forbids.
**Three things follow, and the third is the one that generalises.**
(a) **Narrowing a unique key is not a schema-only change.** Ask what rows the constraint would reject and go COUNT them — in production and in every worker database — before the migration is written, not after it goes red.
(b) **A fail-first that exercises a data defect POISONS the fixture for the fix.** The evidence run and the migration are in tension by construction: the better your red run, the more certainly it leaves behind exactly what the green run cannot tolerate. Truncate the affected tables between them (`TRUNCATE`, not `DELETE` — an append-only trigger correctly refuses the latter).
(c) **Do NOT make the migration self-healing.** The tempting fix is a dedupe before the index. A migration that silently deletes accrual subjects so that it can apply is worse than one that refuses: the refusal is legible and recoverable, the deletion is neither. Production was measured at zero rows, so the deploy is safe — **and the honest sentence is "safe BECAUSE the lane was never armed", not "safe".**

**2.104 — A LOCK MODE THAT DISCRIMINATED IN ONE SUITE CAN PROVE NOTHING IN THE NEXT, AND ONLY THE MATRIX TELLS YOU WHICH.** *(Plan 09a T4, 2026-08-26 — measured on a scratch database before the test was written)*
§2.6 already says: name the lock AND its mode, and confirm no OTHER lock the implementation takes produces the same wait. `entitlements.contention.test.ts` discharged that by holding **`FOR NO KEY UPDATE`** — the weakest mode conflicting with the writer's `FOR UPDATE` that does not also conflict with an FK's `FOR KEY SHARE`. Reusing that choice for the receivable lane would have been silently wrong:

| held mode | shipped (`SELECT … FOR UPDATE`) | lock-less (bare `UPDATE`) | discriminates |
|---|---|---|---|
| `FOR KEY SHARE` | BLOCKED (3125 ms) | proceeded (211 ms) | **yes** |
| `FOR NO KEY UPDATE` | BLOCKED (3117 ms) | BLOCKED (3116 ms) | **no** |

The lock-less mutant reaches an `UPDATE` next, and an `UPDATE` takes `FOR NO KEY UPDATE` — so it would have "blocked" convincingly and the mutant would have looked killed while proving nothing. **The mode is a property of the STATEMENT THE MUTANT REACHES NEXT, not of the suite that last needed one.** Same rule, opposite answer, one table apart.
**A second fact the probe settled, worth having:** the `UPDATE` writes `statement_ref`, a column of a PARTIAL unique index, and still took only a no-key lock — **a partial unique index is excluded from Postgres's key-attribute set.** If you need to know whether an `UPDATE` takes a key lock, two psql sessions answer it in ninety seconds; reasoning from the docs does not.

**2.105 — A COMMENT THAT SAYS "THIS IS THE SAME AS X" IS A LOAD-BEARING CLAIM THAT NOTHING EXECUTES, AND IT GOES FALSE THE DAY SOMEBODY FIXES X.** *(Plan 09a T3, 2026-08-26 — the sharper form of §2.54)*
Plan 09's independent reviewer found a raw-instant validity comparison in `attributeInvoice` and named it MAJOR 3. The identical two lines lived in `pnl.ts`'s `memberSpendFor`, whose own docstring reads *"why this is `attributeInvoice`'s own predicate"* and whose file header promises that reusing the identical predicate *"is what stops 'whose bill is this' from being answered twice by two formulas that could quietly drift apart."* **Fixing only the copy the reviewer named would have made the file's own stated invariant false**, and the comment would have gone on asserting it. Mutant: `memberSpendPaise 0` against `100 000`. DIED.
**Two rules, and they are separable.**
(a) **A REVIEWER'S FINDING NAMES THE SITE IT FOUND, NOT THE DEFECT'S EXTENT.** Before calling any review finding fixed, grep the pattern across the repository. One `grep -rn` over `validFrom|validTo` found the second copy in seconds; nobody had run it in the nine days the first copy was known.
(b) **§2.54 says two copies of one fact drift. The addition: the copies are often a FACT and a COMMENT ABOUT THE FACT**, and the comment is the copy nothing tests. The repair is not "never write it twice" — sometimes you must, as here, where one form must be sargable against a constant and the other must compare two columns. The repair is **one exported expression plus a test that goes red when the forms disagree at the boundaries.** If it must be written twice, make something fail when the copies diverge.

**2.106 — "EVERY TASK COMMIT GREEN BY FULL SHA" IS FALSE FOR ANY TASK YOU DID NOT PUSH ON ITS OWN.** *(Plan 09a close, 2026-08-26 — observed while writing the close that would have claimed it)*
GitHub creates a workflow run for the HEAD of a push, not for each commit inside it. Plan 09a's T1 was committed and pushed alongside later commits and therefore has **no check run at its own SHA** — `total_count: 0` — while T2, T3 and T4, each pushed alone, are green by full SHA. T1's code is covered transitively (every green descendant contains it), which is a weaker guarantee than the sentence this project's close reports make routinely.
**The rule: one push per task commit, or write the weaker sentence.** And when a commit shows no run at all, check the provider's status page BEFORE diagnosing the repository — this phase ran through a GitHub Actions major outage during which a pushed commit sat with zero check runs for forty minutes, which looks exactly like a workflow that is not configured. That is §2.64 one level out: **a CI observation the diff cannot explain is a candidate for the provider's status page before it is a candidate for diagnosis.**


**2.107 — THE REVIEW BUDGET IS NOT OVERHEAD ON A PHASE, IT IS THE PART OF THE PHASE THAT FINDS THE DEFECTS — AND ON THIS ONE IT BREACHED THE STOP-LOSS BY 40% WHILE BEING THE ONLY THING THAT WORKED.** *(Plan 09a token audit, 2026-08-26 — measured)*
Four tasks, coded in-session under the LIGHT lane. Five Assertion Book mutants required, five built, **five died**. Five `pnpm verify` runs, every one exit 0. Four CI runs, every one green. **That tree carried a MAJOR** — T2's own re-key had dropped counterparty separation, so a second partner attributed to one invoice summed the first partner's rows as its own prior and was short-paid by exactly that amount.
**The instrument ledger, and it is the whole argument:**

| instrument | cost | what it found |
|---|---|---|
| four coding tasks + 5 required mutants | in-session (unmeasured) | 5 kills — all CONFIRMATIONS of assertions already right |
| reviewer pass 1 | 206,146 (83 calls) | **1 MAJOR introduced by the phase**, 1 MAJOR inherited, 3 MINOR, 3 NOTE |
| reviewer pass 2 (over the remediation) | 268,625 (30 calls) | **a 9-second test inside a 15-second budget**, a mutant that SURVIVED, an unenforced invariant, 4 more |
| **stop-loss** | **340,000** | breached by 40%, entirely on the two passes |

**The rule: a stop-loss computed from task count alone will halt a phase precisely when its gate starts working**, because the review-and-remediate cycle is not proportional to the tasks — it is proportional to what the tasks got wrong, which is unknowable at kickoff. Enforced at 340k, this phase would have stopped before the counterparty defect was found and shipped it. **Mechanical form:** `stop-loss = 1.5 × per-task rate × task count` **+ one full reviewer pass per remediation cycle**, the second term from actuals (16a 181k for one pass; 09a 475k for two). And the sharper half, which is free: **when the reviewer's findings force a fix, that fix is unreviewed code on the same path — send the reviewer back.** Pass 2 cost more than pass 1 and found the thing that would have turned `main` red.

**2.108 — A RESUMED AGENT STARTS FULL, SO §9's METRIC IS WHAT AN AGENT CARRIES AND NEVER WHAT ITS BRIEF POINTS AT.** *(Plan 09a token audit, 2026-08-26 — measured, and it refutes the naïve reading of §2.101)*
Same agent, same pointers, a SMALLER diff — and pass 2 cost **~8,950 tokens per call against pass 1's ~2,480**, nearly four times, for 36% of the calls. Nothing about the brief changed. **It is a resumed agent: it carried pass 1's entire context — every file read, every probe run, every finding written — into all 30 of its calls.**
**Why this matters beyond arithmetic:** §2.101 and §9 are usually read as *"point briefs at less"*, and that is right for a FRESH agent. For a resumed one the pointer set is irrelevant — the cost is already paid and compounds per call. **Mechanical form: budget a resumed agent at its predecessor's high-water mark, not as a cheap follow-up**, and prefer a resume when the CONTINUITY is worth it (it is — pass 2 knew exactly what it had already proven and re-verified none of it) rather than because it looks cheaper. It does not.

**2.109 — `drizzle-kit` EMITS A COMPOSITE FOREIGN KEY BEFORE THE UNIQUE CONSTRAINT IT REFERENCES, AND THE MIGRATION IS UNRUNNABLE AS GENERATED.** *(Plan 09a close, 2026-08-26 — measured, four suites and 69 tests red on one line)*
`0030` needed `unique (id, counterparty_id)` on one table and a `FOREIGN KEY (subject_id, counterparty_id)` referencing it from another. `pnpm db:generate` emitted the FK first: `ERROR: there is no unique constraint matching given keys for referenced table "commission_accrual_subjects"`. Every suite that calls `setupTestDb` failed, on that line, before a single assertion ran.
**Generated is not the same as correct, and nothing but running it says so.** The statement order was hand-corrected in the `.sql` — which is permitted; **`_journal.json` is what AGENT-RULES §6 forbids editing, not the SQL** — with the reason written at the top of the file so a later reader does not "tidy" it back. **Mechanical form: any migration that adds a composite FK must be RUN before it is committed, and if its generator produced the statements in dependency order by luck, say so in the file.** The generator orders by table, not by dependency.

**2.110 — A MUTANT THAT SURVIVES IS WORTH MORE THAN ONE THAT DIES, AND THIS PHASE PAID FOR THE PROOF TWICE.** *(Plan 09a, 2026-08-26)*
Five required mutants, five kills — and the phase still shipped a MAJOR, because **a dead mutant confirms that an assertion discriminates and can say nothing about whether it is aimed at the right thing** (§2.102's shape, restated from the mutant side). The two mutants that taught this phase something were both unrequested: the `pnl.ts` copy, which DIED and thereby found a second site nobody had looked for; and the differing-amounts contention leg, which **SURVIVED** and thereby proved my own comment — *"the assertion that would fail against a lock-less implementation"* — was a hand-walked prediction stated as a property. Rule 21's exact prohibition, written by the session that had just cited rule 21 twice in the same file.
**Mechanical form:** when a comment claims a test discriminates a particular wrong implementation, that claim is a MUTANT SPECIFICATION and must be executed like one. **Any sentence of the form "this would fail against X" is either an executed result or it must be deleted.**


**2.111 — "NOT MY DEFECT" AND "NOT MY CONTRIBUTION" ARE DIFFERENT CLAIMS, AND A CI RED IN A SUITE YOU NEVER TOUCHED CAN STILL BE LOAD YOU ADDED.** *(Plan 09a close, 2026-08-26 — measured, and the second half was nearly missed)*
`ff79eb9` went red on `src/kernel/worker/scheduler.test.ts` — a suite the phase does not touch — where one test overran its own 120,000 ms budget to 186 s and cascaded into four hook timeouts after it (§16a's named fixture-cascade item, producing five failures from one timeout).
**The causation question was settled cheaply and completely.** `gh run view --log-failed` named the test in one call (§2.100 — this host is authenticated, and believing the stale §2.91 nearly cost an hour once already). Then: `git diff --name-only ff79eb9..8eabf45 -- apps/ packages/` came back **EMPTY** — the four commits after the red one were documentation and a hook — so **the test surface was byte-identical across one RED run and FOUR GREEN ones.** Red-then-green on identical code is nondeterminism proven by execution (§2.98).
**A free trick worth naming:** a phase's close usually produces several docs-only commits after its last code commit. Each one is a CI run over an identical test surface, so **the controlled second observation Plan 09 had to engineer arrives by itself — four times.** Look for it before engineering one.
**AND THE HALF THAT ALMOST WENT UNASKED.** Having proven the red was not caused by the diff, the tempting conclusion is that the diff is blameless. It is not the same question. The phase's new deadlock leg deliberately deadlocks two transactions per trial, and Postgres resolves a deadlock only after `deadlock_timeout` — **eight trials measured at 9,047 ms of real lock contention** against a database every other suite shares, in a file jest runs in parallel with all of them. That plausibly raises the probability of exactly the timeout that fired.
**Mechanical form:** after any CI red, ask BOTH questions and answer them separately — *did my diff CAUSE this* (diff the test surface; read the log) and *did my diff make it MORE LIKELY* (time the suites I added; ask what shared resource they hold and for how long). Here the answers were **no** and **yes**, and the second one was cheap to act on: the leg measures a MAPPING rather than a probability, so trials fell 8 → 3, **9,047 ms → 3,839 ms, a 58% cut with the same evidence.**


**2.112 — WHEN A PREDICATE IS DUPLICATED, CHECK THE CONSTANT UNDERNEATH IT: "DIFFERENT DOMAINS" ANSWERS A QUESTION ABOUT THE PREDICATE AND NOT ABOUT THE CONSTANT.** *(Plan 09a close, 2026-08-26 — measured at NINE sites)*
Plan 09a fixed MAJOR 3 (an IST-calendar-day predicate compared as raw instants), then found a SECOND copy of that predicate in `pnl.ts` (§2.105). While sweeping for a third, it saw `modules/opd/time.ts` and `kernel/worker/scheduler.ts` carrying their own `istDayIndex` and **dismissed them as "different domains"** — true of the PREDICATE, which is about membership validity, and irrelevant to the CONSTANT, which is the hospital's clock.
**Measured when a stranded relay note forced a second look: NINE sites carry the IST offset**, in two spellings (`5.5 * 60 * 60 * 1000` and `330 * 60_000`), across four kernel files and five modules. **One does it correctly** — `kernel/approvals/cumulative.ts` exports `IST_UTC_OFFSET_MINUTES = 330` — **and nothing imports it.** All nine agree today, so there was no defect; but the phase existed *because two copies of an IST predicate disagreed*, and one mistyped digit in any of the nine reproduces it.
**Consolidation was NOT the fix, and that matters.** `scheduler.ts` states a defensible reason for keeping its copy local, and rewriting nine files across frozen modules is not a close remediation's work. **Mechanical form:** where a constant is duplicated by deliberate choice, pin every site VERBATIM in one test with a census, so a tenth copy is a deliberate change and a changed digit is red. `test/ist-clock-parity.test.ts` does this in three legs — the arithmetic, the expression still being present in the file, and the census — and a `5.3` drift mutant died on the first two while the third correctly stayed green, because site COUNT had not changed. **Three legs asking three different questions is what stops a census test from being one assertion wearing three hats.**

**2.113 — A FILE ONLY ONE SESSION CAN VOUCH FOR IS NOT ARCHIVED, IT IS REMEMBERED — AND THIS PROJECT'S EVIDENCE STANDARD EXISTS TO DISTRUST MEMORY.** *(Plan 09a close, 2026-08-26)*
`.plan-09-relay.md` — 136,348 bytes, 127 numbered entries — sat UNTRACKED in the shared working tree, one `git clean` from gone. Asked whether it could be deleted, the session that wrote it answered *"its substance is committed"* and named an 11KB distillation. **Measured: 164 lines against 127 entries**, and four facts sampled at random from the raw file appear ZERO times in the committed one.
The author then re-measured, reversed itself, and got the diagnosis exactly right: *a distillation preserves the load-bearing RULES and is right to; what it does not preserve is the measured facts behind them.* **Asserting equivalence from memory, about one's own file, is the class of claim this ledger exists to stop** — and it nearly cost the archive.
**Two mechanical forms.** (a) **Untracked is not stored.** At every phase close, `git status --porcelain` the tree and account for each `??` — commit it, move it, or delete it deliberately; "somebody's scratch" is a decision nobody made. (b) **Never delete on a description; delete on a measurement.** `wc -c`, entry counts, and a keyword sample against the file said to supersede it cost about ninety seconds here and refuted the description outright. *(And the payoff was not hypothetical: §2.112 came out of entry 16 of the file that was nearly deleted.)*


**2.114 — THE DEPLOY DETECTOR COULD ONLY SEE A DEPLOY RUN THE WAY THE RULES FORBID.** *(Plan 09a, 2026-08-26 — found by running a real production deploy and noticing the silence)*
`is-deploy-execution.py` was written to answer "is `deploy.sh` the word in COMMAND POSITION", and it answers that correctly for `bash docker/prod/deploy.sh`. It steps over interpreters — `setsid`, `nohup`, `sh` — then meets `-c`, which is not an interpreter, stops scanning, and never looks inside. **A shell's `-c` argument is a COMMAND and it was being treated as data.**
**Why that is not a corner case: AGENT-RULES rule 18 REQUIRES long commands to run detached** (`setsid nohup sh -c '…' &`), and a deploy is the longest command this project has. So the only shape a *correctly executed* deploy takes was the one shape the detector could not see, while the shape it did detect is the one the rules tell you not to use. **The trigger and the execution standard were pointing in opposite directions, and nothing compared them.** A real production deploy ran, the stamp was never written, and the owner's standing "audit every deploy" instruction was silently not honoured.
**Mechanical form, and the narrow half matters as much as the fix:** recurse into `-c` **for shells only**, depth-bounded. `python3 -c` and `perl -e` carry a PROGRAM, which really is data, and widening the recursion to every interpreter would reintroduce the mention-vs-execution misfire the file exists to prevent (§16a's three misfires). The pinned suite went 24 → 31 cases, and the new must-NOT-fire entries — `sh -c 'cat deploy.sh'`, `python3 -c "open('deploy.sh')"` — are the ones that would break if that line were crossed.
**The general rule: when a hook watches for an action, test it against the shape the METHOD MANDATES, not the shape that is easiest to type.** A detector validated only against hand-typed commands is validated against the case that will not occur.



**2.115 — A RESUMED REVIEWER GETS MORE EXPENSIVE EVERY TIME, AND ITS PER-CALL COST EXPLODES AS ITS WORKLOAD SHRINKS.** *(Plan 13 close, 2026-08-27 — measured across three invocations of ONE agent)*
§2.108 established that a resumed agent starts full. Plan 13 resumed one reviewer twice and measured the stronger law: **each resume is dearer than the last, because the transcript it replays now contains its own previous report.**

| invocation | workload | tokens | tool calls | **per call** |
|---|---|---|---|---|
| pass 1, fresh | 8 commits, 40 files, +38,779, plus the live database | 175,209 | 38 | **4,611** |
| pass 2, resumed | ONE 7-file diff, +163/−27 | 205,365 | 5 | **41,073** |
| pass 3, resumed | FOUR yes/no questions over a 6-file diff, +92/−6 | 224,081 | 2 | **112,041** |

**Total 604,655 — 92% of the phase's whole 660,000 stop-loss, on the reviewer alone, and the phase breached it.** The workload fell by roughly two orders of magnitude between the first call and the third; the cost went UP 28%. Per call it went up **24×**. The plan's review term (450,230) was derived from 16a's fresh pass plus 09a's ONE resume, and it is short by a third against two.

**The mechanism, and it is why the trend is monotonic rather than noisy:** a resume re-bills the whole transcript, and the transcript grew by the agent's own output — a full review report is thousands of tokens that the next resume pays for on every call it makes. With few calls the context ramp is the entire cost and nothing amortises it.

**Mechanical form: RESUME FOR MEMORY, SPAWN FRESH FOR SCOPE.** Before resuming, ask whether the question actually needs what that agent remembers.
- **Needs memory** — *"is the fix for the defect YOU found correct?"* Pass 2 qualified: it had to hold the original code in mind to judge whether the remediation preserved it, and it earned every token by finding two MAJORs in that remediation.
- **Does NOT need memory** — *"confirm these four properties of this 92-line diff."* Pass 3 did not qualify. A FRESH agent carrying `AGENT-RULES.md` (24.5k) plus the diff (~3k) plus the questions (~1k) would have opened at roughly **7k of context against the resumed agent's whole transcript**, and answered the same four questions. On this measurement that is a **4–7× saving on that invocation with nothing verified less.**

**And the counter-rule, because the cheap move here would be to stop reviewing:** Plan 13's pass 2 found **two MAJOR defects in pass 1's own remediation**, one of which (a `ResourceError` escaping an OPD controller's `toHttp` as a 500) re-introduced the exact defect class this project's own DD14 and `errors.ts` cite as their cautionary tale — **introduced by the commit that fixed a different defect.** A phase that stopped after one pass ships it. The lesson is not *review less*; it is **review the remediation with a resumed agent, then confirm the confirmation with a fresh one.**

**2.116 — A MUTANT OF SQL NEEDS A TEST THAT RUNS THE SQL, AND A MIGRATION'S BRANCHES CAN DIE UNEXECUTED.** *(Plan 13 close, 2026-08-27 — found by the independent reviewer, not by the executor)*
Plan 13's Assertion Book named four rows — A8, A9, A11, A12 — whose mutants are mutations of a **migration file**, and the tests that shipped for them exercise the application code on either side of it. The reviewer's finding: **no test anywhere applies `0032` to a database with rows in `opd_rooms`.** Every per-worker test database is empty when the migration runs, so the backfill inserts zero rows; and production held two rooms with `floor NULL` and `active true` on both. **The `floor IS NOT NULL` branch and the `active = false → 'retired'` branch therefore never executed in ANY environment — and T7 dropped the source table, so they never can again.**

The rows were genuinely discharged, by a scratch-database drill in the executing session: `0000`–`0031` applied with `psql`, a template snapshot, one mutated `0032` per row, assertions in SQL. All four mutants DIED with quoted output. **But that evidence lives in one transcript and nothing in the repository regresses it.**

**Mechanical form, two halves.** (a) When an Assertion Book row's mutant is a mutation of a `.sql` file, the row must say **which instrument discharges it** — a migration-level test, or a named drill whose transcript is the evidence — because a plan that says "mutant · discriminating input" and means "run it by hand once" is describing a different instrument from the one every other row uses. (b) At authoring time, ask of every backfill branch: **is there any environment in which this branch executes?** A branch guarded by a field that is NULL in production and absent from every fixture is dead code with a `CASE` around it, and the phase that drops its source table is the last one that could ever have found out.

**2.117 — "ENFORCE THE INVARIANT AT THE WRITE PATH IN ONE PLACE" IS ONLY SOUND WHEN THERE IS ONE PLACE — AND ADDING A GUARD CHANGES WHAT EVERY CALLER'S ERROR MAPPER CAN RECEIVE.** *(Plan 13 close, 2026-08-27 — two review passes, and the second defect was created by the fix for the first)*
Plan 13's DD6 stated an occupancy invariant as a biconditional and said it was *"enforced at the write path in one place"*. There were **four** write entry points and a module-facing facade on top of them. It was enforced on two. The first remediation closed a third; the second review pass found the fourth — `createResource`, where `status` is a public optional input and the occupied value is a legal member of the vocabulary, so a resource could be **registered** into the state the invariant forbids.

**Then the fix for the third door opened a different defect.** Making `changeResourceStatus` refuse an occupied resource made a new error code reachable from an OPD route, and that module's error union has no code for it — so the module's translator rethrew, the controller's `toHttp` rethrew, and a correct refusal reached the masters counter as a **500**. That is §2's Plan 09 specimen (a `MembershipError` escaping `billing.controller.ts`) reproduced one phase later **by the commit that was fixing a correctness bug**, in a phase whose own plan cites that specimen twice.

**Mechanical form, and it is two greps.** (a) Before writing *"enforced in one place"*, `grep` for every function that writes the columns the invariant constrains and **count them**; if the answer is more than one, the sentence is a specification of what should be true, not a description of what is. (b) **In the same commit that adds a refusal to a shared function, walk every caller's error mapper** — `grep` the callers, and for each one check its `toHttp`/translator against the code you just made reachable. A guard added in the kernel is a change to the HTTP contract of every module that calls it.

**2.118 — THE GENERATOR'S DEFAULT CAN BE THE DANGEROUS FORM, AND A PLAN THAT ASSUMES OTHERWISE HAS THE EFFORT BACKWARDS.** *(Plan 13, 2026-08-27 — measured at `drizzle-kit generate`)*
Plan 13's A12 pinned that `0033` must be a bare `DROP TABLE "opd_rooms";` and **never** `CASCADE`, and described the CASCADE mutant as *"one word long"* — the natural reading being that the safe form is what you get and the dangerous one takes an edit. **It is the other way round.** `pnpm db:generate` emitted `DROP TABLE "opd_rooms" CASCADE;`, and the hand-edit that ships is the REMOVAL of that word.

Measured against a database at `0031` with the repoint not applied — the hand-applied-hotfix scenario, which AGENT-RULES-compliant detached execution makes more likely rather than less: `CASCADE` **succeeds**, emits `NOTICE: drop cascades to 2 other objects`, and **both `room_id` foreign keys vanish — zero surviving** — leaving a live hospital's schedule book unconstrained. The bare drop refuses and names both dependent constraints.

**Mechanical form: read the GENERATED file before writing the plan row that describes it.** A plan authored from what a tool *ought* to emit mis-states which case is the deviation, and the mis-statement points the executor's attention away from the word that matters. Where a generated migration will be hand-edited, the plan should quote the generator's actual output and mark the edit against it.


**2.119 — A LOCK'S DOCSTRING IS THE PLACE A LOCK'S GAP HIDES.** *(Plan 14 close, 2026-08-27 — the phase's one CRITICAL, found by the independent reviewer against nine green commits)*
`postMovements` took an ordered set lock (`SELECT … FOR UPDATE`) over the `(resource, batch)` pairs a movement touches, and wrote the new balance as an APPLICATION-COMPUTED ABSOLUTE through `INSERT … ON CONFLICT DO UPDATE`. Its docstring stated the gap **exactly** — *"`SELECT … FOR UPDATE` locks rows that EXIST"* — and then dismissed it in the next sentence: *"the INSERT that creates it takes its own lock through the primary key."* That sentence is TRUE and it is NOT SUFFICIENT. Under `ON CONFLICT DO UPDATE` the loser blocks on the winner's tuple and then takes the `DO UPDATE` branch, writing **its own** absolute over the winner's.

Measured against the shipped code with the interleave forced by the winner's uncommitted tuple: two concurrent receipts of 5 into a `(store, batch)` pair with no balance row left `{ ledgerSum: 10, balance: 5 }`. **Five units of stock received, recorded in an append-only ledger, and absent from the shelf figure, with no error anywhere.** The loss lands HIGH, so `stock_balances_non_negative_ck` never fires — the constraint defends against a NEGATIVE balance and this defect produces a perfectly legal one.

Nothing in the phase's own evidence could have caught it. Every task was green, both A8 legs were written (and one was correctly recorded as non-discriminating), every CRITICAL mutant was built and killed, `pnpm verify` was 0 and CI green by full SHA on all nine commits. **Both A8 legs are about a row that EXISTS**, because that is what a lock is about — so the Assertion Book asked the right question of the wrong case.

**Mechanical form.** Where a comment says *"X cannot happen because Y"*, **Y is a claim about runtime behaviour and belongs in a test, not in prose.** At authoring time: grep the module for `cannot happen`, `is safe because`, `already takes`, `is guaranteed by` — each hit is either a test that exists (cite it by name) or a gap that is UNPROVEN and must say so. At review time, the sentence AFTER an admitted gap is the highest-yield line in the file: somebody wrote down the hole and then talked themselves out of it, and every later reader inherited the conclusion without the derivation.

**2.120 — A CHECK CONSTRAINT IS EVALUATED AGAINST THE PROPOSED TUPLE, BEFORE THE UNIQUE INDEX REPORTS THE CONFLICT THAT WOULD HAVE SENT EXECUTION DOWN `DO UPDATE`.** *(Plan 14 close remediation, 2026-08-27 — the C1 fix, failing 13 tests before it shipped)*
The first fix for §2.119 kept the single statement and moved only the `set:` clause to an atomic increment, leaving `values({ qtyOnHand: m.qtyDelta })` as the proposed row. The generated SQL was **correct** — `on conflict (…) do update set "qty_on_hand" = "stock_balances"."qty_on_hand" + $6` — and it failed five ledger tests and eight consumer tests outright, every one on `stock_balances_non_negative_ck`.

An outbound movement of −4 into a location holding 10 proposes a row with `qty_on_hand = −4`. **Postgres validates that tuple before the index tells it the row already exists**, so the CHECK rejected it before `DO UPDATE` could ever run and compute the real post-value of 6. The insert branch of an upsert is not dead code when the row exists — its VALUES are still constraint-checked.

The shape that works, and why the tempting one-liner does not: **materialise with ZERO (`ON CONFLICT DO NOTHING`), then a separate atomic `UPDATE … SET col = col + delta RETURNING`.** Zero is not a fabricated figure and satisfies the CHECK by construction, and the CHECK then judges the TRUE post-value — so it stays a real backstop. The alternative that also passes the suite, `values({ qtyOnHand: Math.max(delta, 0) })`, quietly destroys that: an unguarded negative movement becomes a silent zero row instead of an error.

**Mechanical form: an upsert whose target table carries a CHECK must propose a row that SATISFIES the CHECK, independently of which branch will run.** When writing one, ask what the VALUES clause means on its own; if the answer is "nothing, it's discarded", the constraint disagrees.

**2.121 — FIXING A PREDICATE THAT COULD NEVER FIRE MAKES THE CODE BEHIND IT REACHABLE FOR THE FIRST TIME, AND THAT CODE HAS NEVER RUN.** *(Plan 14 close remediation, 2026-08-27 — found reviewing the fix, not the original)*
`ensureTransitStore`'s race recovery tested for a raw Postgres `23505` that `createResource` had **already** converted into `ResourceError("duplicate_code")`. The comparison could never be true; the `catch` was dead. The reviewer filed it (M2), and the remediation fixed the predicate — correctly — and stopped there.

**The re-read behind that predicate had never executed, and it could not.** `duplicate_code` is raised off a genuine unique-index violation, and a constraint violation puts the enclosing Postgres transaction into the ABORTED state: every subsequent command answers `25P02 current transaction is aborted`. So the "fixed" recovery would have raised a second, more confusing error on top of the first, and the race would still have surfaced as a 500. The real fix is a SAVEPOINT (drizzle's nested `transaction()`), so only the failed insert rolls back.

**This is §2.117's shape one level in, and it is the second consecutive phase to hit it: a remediation is unreviewed code on the path the reviewer just told you is fragile.**

**Mechanical form: when a fix makes dead code live, review that code as NEW code — because it is.** A `catch` body, an `else` branch or a fallback that a broken guard has been shielding has never been executed, never been typechecked against reality, and carries whatever assumptions its author had. Two questions, both cheap: *what is the state of the world when this now runs* (here: an aborted transaction), and *is there a test that reaches it* (here: no — one was written, forcing the interleave with the winner's uncommitted tuple).

**2.122 — A CLAIM ABOUT THE TEST SUITE, WRITTEN IN THE FILE THE TEST WOULD GUARD, IS BELIEVED BY EVERYONE INCLUDING THE REVIEWER OF THE TASK THAT WAS MEANT TO WRITE IT.** *(Plan 14 close, 2026-08-27 — measured in one pass over one directory)*
`materials/errors.ts` closed its header with *"Both directions are asserted by `errors.test.ts` at T8, when every thrower exists."* **`errors.test.ts` did not exist.** The sentence was written at T2, read by six later tasks, by the gate on T8, and by the executing session, and none of them ran `ls`.

What it was hiding, found mechanically in one pass: **five declared codes with zero throw sites** (all five `qc.ts` `RuleCode`s — a different union, recorded on a GRN line as a verdict, transcribed into the error union because the rules read like refusals); and `not_in_transit` **declared for a call that could not throw it** (a ternary whose true branch sat inside a guard excluding it) while a *different* function BORROWED it to mean something else — the exact practice the same header forbids two paragraphs above the promise.

**Mechanical form, and it is one command — but `ls` is the wrong half of it.** At close, `/usr/bin/grep -oa` the module's sources for every string ending in `.test.ts`, then `find` each one **repo-wide**, not in the naming directory. Run on `modules/materials` at this close it produced sixteen names: seven local, one genuinely phantom (`errors.test.ts`), and **eight false alarms** — `billing-purity`, `guardrails`, `manifests`, `masters`, `materials.e2e`, `seed-roles`, `versions.contention`, `worker-runtime.e2e` — every one a real file cited as precedent from another directory, which is exactly the kind of citation this codebase's comments are full of. A directory-scoped `ls` would have buried the one real finding under eight it invented; the rule that catches phantom claims needs its own coinciding-field check (§2.123). A comment that names a test file is a checkable claim; treat it as a census row like any other. The general rule: **a promise in a comment is not a guard, and a promise about a GUARD is worse than silence — it buys the confidence of the guard without the guard.**

**2.123 — A FIXTURE THAT MAKES A CONVERSION THE IDENTITY HAS REMOVED THE CONVERSION FROM THE TEST RATHER THAN EXERCISED IT.** *(Plan 14 close, 2026-08-27 — the seventh §2.102 instance in one phase, and the only one that hid a MONEY defect)*
§2.102's coinciding-field rule has six instances recorded in this phase's own plan, all about ordering, identity and multipliers, all costing a test that fails to discriminate. The seventh is different in kind. `consumption.test.ts` gave both the batch and the price regulation `mrpUom: "each"` on an `each`-based item, so `mrpPerBaseUnit` multiplied by 1 and **every unit conversion in the consumer was a no-op**. Behind that, `material.consumed` carried a per-PACK `mrpPaise` beside a silently per-BASE `ceilingPaise` — and Plan 15 applies `min(tariff, MRP, ceiling)` to exactly those two fields. On an implant sold in fives that is a 5.6× error in a patient's bill, in whichever direction the numbers happen to fall.

The same close pass found the same shape in the clock: `expiry.test.ts` pinned `NOW = 06:30 UTC`, which is noon IST, so the UTC calendar day and the IST calendar day coincide — hiding a sweep that computed "today" in UTC and was therefore a day out for the 00:00–05:30 IST window. **A census could not have caught that one either, and the reason generalises: `ist-clock-parity` counts hand-rolled offset COPIES, and the defect was the ABSENCE of an offset. A census of copies cannot count omissions.**

**Mechanical form: a multiplier of 1, an offset of 0, a timezone at noon, a currency at par and a rate of 100% are one trap.** For every fixture that crosses a unit, a zone, or a scale, write one leg where the two sides DIFFER — and prefer that leg as the default, keeping the identity case as the explicit control. Where the conversion is on a MONEY path, that leg is not optional: name the field, state the multiplier, and assert both operands in the same unit.


**2.124 — A SERVER-SIDE PERMISSION CHANGE IS HALF A PERMISSION CHANGE, AND THE OTHER HALF IS A HARD-CODED TABLE IN THE SPA.** *(Plan 14 close, 2026-08-27 — found by the SECOND reviewer, in the remediation for the finding it completes)*
Authority in this system is declared three times: in a module manifest (`menu[].permission`), enforced in a controller (`@RequirePermission`), and **rendered from a separate hard-coded `NAV` table in `apps/web/src/router.tsx`**. The close review's M6 moved the GRN entry from `materials.grn.capture` to `materials.stock.read` so `pharmacy` — DD11's ruled QC signatory, which holds `grn.qc` and `stock.read` and deliberately not `grn.capture` — could open the document it signs. It changed the manifest and the controller. **It did not change `router.tsx`.**

Nothing broke and nothing failed. The client table is courtesy rather than security, so the route worked; the only symptom was **a role that could do its job and could not find the door** — which is the exact symptom M6's own docstring claims to have removed, and which the remediation's commit message asserted was fixed.

**Both files carried a comment stating the invariant.** `router.tsx`: *"The strings match the `menu` entries the server's module manifests declare, which is where the authoritative pairing lives."* `materials/manifest.ts`: *"so the permission-gated link and the screen it opens cannot drift apart."* Nothing compared them. That is §2.122 with the roles reversed — not a comment naming a test that does not exist, but a comment naming an INVARIANT no test asserts, and both are claims a reader believes on sight.

**Mechanical form, two parts.** (a) **In the same commit that changes a permission string server-side, `/usr/bin/grep -ra` that string across `apps/web`.** One command; it would have returned `router.tsx:92` here. (b) **Where a client table says it mirrors a server list, write the test that compares them** — `apps/core/test/nav-parity.test.ts` is that test, parsing `NAV` out of `router.tsx` from a core test the way `caddyfile-parity.test.ts` already parses its route table. The general rule: **a comment asserting that two files agree is a claim about a file its author is not editing, and it decays silently.**




**2.125 — WHEN A NEW GUARD BREAKS N TEST FIXTURES, N IS THE FINDING.** *(Plan 15 close, 2026-08-28 — MINOR 10)*
The reviewer noticed that `force` — the flag clearing the duplicate-booking soft block — was taken straight off the request body, while the plan's A9 reads *"unless `force` by `ot_incharge`"*. One `actorHoldsAnyRole` check closed it. **Then 51 tests failed across five files, and not one of them was a code defect: every failing fixture had been booking a forced case as the day-care COORDINATOR**, a role that does not hold the authority the flag represents.

That count is the whole lesson. A guard whose addition breaks nothing was already enforced somewhere; a guard whose addition breaks fifty-one fixtures is measuring how many places had been exercising a privileged action as somebody who does not hold it — **and every one of those fixtures had been green for the entire phase, asserting behaviour that the finished system does not have.** The fixtures were not "using a convenient actor". They were quietly documenting the missing check.

The same phase produced the same shape twice more, which is why it generalises rather than being a story about one flag: A5c's deposit tests asserted a refusal message that a new, tighter bound made unreachable (§2.126), and A20/A21's PACU fixtures scored patients a week in the future, which only surfaced when a clock bound was added (§2.127).

**Mechanical form.** When a close-review fix adds an authorisation or invariant check, **run the whole suite before writing the test for it, and read the failure COUNT as evidence**. Zero failures means the invariant was already held (ask what by, and whether the new check is dead). A handful means the fixtures were sloppy. Dozens means the invariant was never exercised anywhere in the system, and the fix is more valuable than its severity label suggested — say so in the close report, and check whether the same gap exists on the other routes that share the permission.

**2.126 — TWO BOUNDS ON ONE QUANTITY: WRITE THE INEQUALITY, OR ONE TEST IS CERTIFYING A PATH THAT CANNOT EXECUTE.** *(Plan 15 close, 2026-08-28 — MAJOR M2)*
A day-care deposit hold was bounded by the patient's whole advance minus everything already held (`advanceOf − Σ holds`). The review found it never checked the RECEIPT it named, so a hold could be earmarked from money that receipt did not have — and the failure surfaced hours later, on the billing desk, as an invoice that could not be issued at all. The fix added a second bound: `receipt.unallocated − holds on that receipt`.

Both bounds are correct. **But they are not independent**, and the arithmetic says which one can ever fire:

```
patient spare  = advance − Σ holds  =  Σ over receipts of (unallocated − held on that receipt)
receipt spare  = one TERM of that sum  ≤  patient spare
```

The per-receipt bound therefore always refuses first, and the patient-level one became unreachable. Nothing failed — but `A5c`, the test named for the patient-level invariant, went on passing while asserting a message the system could no longer produce. It had become a test of the new bound wearing the old one's name.

**Mechanical form.** When adding a bound to a quantity that already has one, **write the inequality between the two before writing the test.** If one dominates, say so in the surviving test's docstring and re-point it at the property (*"two encounters cannot hold the same rupee"*) rather than at a message that can no longer be emitted. Keep the dominated check — it is a cheap backstop for writes that bypass the new path — but never let a test claim to exercise it. This is §3.14's family: an assertion that passes for a different reason than its name says.

**2.127 — AN INVARIANT THAT MAKES ITS OWN FIXTURE UNCONSTRUCTABLE IS TELLING YOU ABOUT THE INVARIANT.** *(Plan 15 close, 2026-08-28 — MINOR 11)*
A PACU score carried an unchecked `occurredAt`, so the discharge rule *"two qualifying scores thirty minutes apart"* could be satisfied by two scores typed thirty-one minutes apart in one keystroke. Two bounds were added, both obviously right: a score may not be in the future, and a score may not predate the patient leaving theatre.

Together they were untestable. **A test suite runs a whole case in milliseconds**, so `wheel_out` is stamped at ~now and any score with real elapsed time between the two must be in the future — while the phase's own DD8 trigger (correctly) forbids backdating `wheel_out` to make room. The two guards, each defensible alone, left no constructable state in which a stable patient is discharged.

The temptation is to reach for a test-only clock seam in production code. The right reading is that the collision is evidence: **the upper bound is the one that carries the safety property** (a gap you have not waited for cannot be typed forward), and the lower bound's value was already covered by an existing check (the encounter must be in a bay). One was kept, one was removed, and the removal is recorded in the source with its reasoning so the next reader does not re-add it.

**Mechanical form.** When a new invariant makes an existing fixture impossible to build, **do not first weaken the fixture or add a clock seam.** Ask which of the invariants carries the property you actually wanted, and whether the other is already enforced elsewhere. Where both are genuinely needed and genuinely untestable together, that is a design finding about the pair, not a testing problem — write it down rather than routing around it.

**2.128 — THE ASSERTION BOOK TESTS WHAT THE PLAN IMAGINED; THE REVIEWER TESTS WHAT IT DID NOT.** *(Plan 15 close, 2026-08-28 — the ROI line)*
Plan 15 reached its close review with 22 mutants built and 21 killed, `pnpm verify` green, and CI green by full SHA on eight of eight commits. One fresh reviewer, at 271,994 tokens, returned **1 CRITICAL, 11 MAJOR and 19 MINOR** against that tree.

The CRITICAL is the specimen. The §269ST guard — India's ₹2,00,000 cash ceiling, counted per transaction — summed only the deposits HELD on an encounter. A tender taken at discharge is never held, so the guard could not see it: two bills on one encounter each took ₹40,000 on top of a ₹1,50,000 deposit, and each was told it was inside the limit. **The Assertion Book had a row for this guard, and a mutant, and the mutant died** — because the row asked *"is a second cash tender refused when the deposit already reaches the ceiling?"*, which is the question the plan's author thought of. Nobody had asked whether the number the guard compares against includes all the cash.

Three phases running (13, 14, 15), the reviewer has found more than the phase's own instruments, and the finding has been in the arithmetic rather than the control flow. This is not an argument for fewer mutants — the mutants are what make the tested behaviour trustworthy — but for what the reviewer is FOR, and it should be briefed accordingly.

**Mechanical form.** Brief the close reviewer to **audit the OPERANDS of every guard on a money or safety path, not the branch**: for each threshold check, ask what the compared quantity is summed from, and name one real transaction whose money the sum does not include. Put the money file first in the brief's priority order (Plan 15's did, and the CRITICAL came back in the first section of the report).

**2.129 — VERIFY IS THE EXPENSIVE UNIT, NOT THE COMMIT. FOLD EVERY CODE-COMPLETE TASK INTO THE RUN BEFORE YOU LAUNCH IT.** *(Plan 07a/07b close, 2026-08-28)*

The phase shipped twelve commits and paid for **nine full `pnpm verify` runs** — ~20 minutes of wall
clock each, plus a polling turn every time the session asked whether it had finished. Rule 12 is
what forces the cost: evidence must match the state you commit, so a tree edited after a verify
cannot cite it, and a new commit needs a new run.

Two of those runs were avoidable and one was not, which is what makes the rule mechanical rather
than a preference:

- **Avoidable.** T5's server half and its web half were both code-complete in the same session. They
  were committed separately for a good reason (each carried its own evidence) and that cost a second
  full run for zero additional verification — the second run tested a superset of the first.
- **Avoidable.** A verify was launched on T3, then T9 and T4 were written while it ran, which made
  the finished run evidence for a tree that no longer existed. It had to be discarded and re-run.
- **NOT avoidable.** The run that caught `nav-parity` parsing zero entries. That one bought a real
  defect.

The batched commit (T3+T9+T4 on one run) is the counterexample that proves the lever: three tasks,
one run, and the commit message still separates them.

**Mechanical form.** Before launching `pnpm verify`, run
`git status --porcelain` **and ask of every modified file: is this task code-complete?** If a second
task is finished and unverified, finish it into the same run. And once a verify is launched, **do
not edit the tree until it returns** — an edit mid-run silently converts the result into evidence
for a state that no longer exists, and the only honest response is to discard it and re-run.

**2.130 — POLLING A LONG RUN COSTS A FULL CONTEXT RE-READ PER POLL; BLOCK ONCE INSTEAD.** *(Plan 07a/07b close, 2026-08-28)*

An agent pays for its whole context on every tool call, so a one-line `cat .verify.exit` costs the
same as reading a file — and this phase polled its nine verify runs by hand dozens of times, *in
addition to* arming a background waiter that would have reported the same answer once.

The waiter is already the correct instrument and was already in use. The waste was polling **beside**
it, out of impatience, while the notification was pending.

**Mechanical form.** Launch the long run detached with an exit file (AGENT-RULES rule 18), arm
exactly one blocking waiter —
`until [ -f /opt/hmis/.verify.exit ]; do sleep 30; done; echo "EXIT=[$(cat /opt/hmis/.verify.exit)]"`
— and then **do work that cannot touch the tree, or nothing at all, until it fires.** If there is
genuinely nothing to do that does not touch the tree, that is the signal to fold another task into
the run (§2.129), not to check on it again.

**2.131 — A NEW REGISTRATION MOVES CENSUSES THAT A COUNT-GREP CANNOT FIND. GREP FOR A SIBLING'S NAME, NOT FOR THE NUMBER.** *(Plan 07c close, 2026-08-29)*

Plan 07c added a **thirteenth scheduler job** (`rollupUserDayFacts`) and a **sixteenth manifest**
(`deskManifest`). Both are registrations this repository deliberately makes expensive: a census
pins them so that adding one is a decision rather than a drift.

The session found the censuses the cheap way and got it wrong twice, and the reason is mechanical:

- `grep -rn "toHaveLength(12)"` found **two** job censuses — `jobs.test.ts` and
  `alerts-parity.test.ts`. It could not find the other two, because `scheduler.test.ts` and
  `test/worker-runtime.e2e.test.ts` express theirs as a **NAMED ARRAY** (`const THE_TWELVE = [...]`)
  with no count to match. `scheduler.test.ts` needs two further edits a count-grep cannot suggest
  at all: a **spy** in `spyOnTheTwelve`, and a **daily instant** in the fake-clock walk.
- The same shape repeated for the manifest: `manifests.test.ts` carries two counts *and* a key list,
  *and* a "the worker's registry differs in exactly four ways" array — and `seed-roles.test.ts`
  carries seven separate pins (per-module permission counts, the role-model grant total, the
  distinct-permission count, the reachability sum, the not-yet-modelled list, and TWO
  `granted.length` arrays in the executed V5 idempotence test).

Cost: **two of this phase's five red verify runs**, at roughly twenty minutes each, for a fix that
took under two minutes once the failure named the file.

The irony is that the censuses worked exactly as designed — each failed loudly with the received
value beside the expected one. What failed was the SEARCH for them.

**Mechanical form.** Before adding a registration, grep for an existing **SIBLING's identifier**
rather than for the count:

```
grep -rn "retentionSweep" apps/core --include=*.ts     # every job census, spy and clock walk
grep -rn '"formulary"' apps/core --include=*.test.ts   # every manifest census
grep -rn "materials.stock.read" apps/core README.md    # every permission census and README table
```

A sibling's NAME appears in every place the new one must, whatever shape that place is written in.
A count appears only where somebody happened to write a count.

**2.132 — TYPECHECK AND LINT BEFORE YOU LAUNCH THE TWENTY-MINUTE RUN. THEY COST SECONDS AND THEY RUN FIRST ANYWAY.** *(Plan 07c close, 2026-08-29)*

`pnpm verify` is `typecheck && lint && test`. One of this phase's verify launches died on a single
unused variable — a `const dateQuery = z.object(...)` left behind when a route was folded into
another — and it died in about sixty seconds, before a test ran.

Sixty seconds is cheap. What was not cheap is everything around it: the launch turn, the blocking
waiter, the notification, reading the log, the fix, and a fresh twenty-minute run. **A LIGHT phase's
unit of cost is the verify RUN (§2.129), and a run that dies in the first stage costs nearly as much
session time as one that dies in the last** — the wall clock is shorter, the turns are the same.

The phase's whole record, stated plainly, because the ratio is the lesson: **eight verify launches
for three commits. Five red.** One was a host OOM (`dmesg` named the pid; unpreventable and
correctly re-run rather than explained away). One was a known pre-existing flake. **Three were
preventable in under two minutes** — one by this rule, two by §2.131.

**Mechanical form.** Immediately before `setsid nohup … pnpm verify`, run the two stages that are
fast and deterministic, and read their exit VALUE:

```
pnpm typecheck && pnpm lint && echo "PREFLIGHT OK"
```

Then add the census suites any new registration moves (§2.131) — `jest` on three named files is
under a minute. Only then launch the run. This is not a substitute for verify; it is the cheap
prefix of it, paid before the expensive suffix.


**2.133 — A RULE APPLIED TO A LIST OF FILES YOU ALREADY KNOW IS NOT THE RULE. GREP THE TREE.** *(Plan 07c/07d deploy, 2026-08-29)*

§2.131 was written earlier the same day: when adding a registration, grep for an existing **SIBLING's
identifier** rather than for a count, because several censuses are named arrays with no number to
match. Hours later, adding a twenty-fifth role, this session ran that grep — as:

```
grep -rn 'duty_manager' apps/core/test/seed-roles.test.ts apps/core/scripts/seed-roles.ts README.md
```

**Three named files, all of which were already open.** It found nothing new, because it could not:
the search space was the answer already known. A FIFTH census went unnoticed until the verify went
red — `test/seed-staff.test.ts`'s `KNOWN_ROLE_KEYS`, which DERIVES from `ROLE_MODEL` (so it gains a
new role for free) while pinning the count by hand (so it fails). The command the rule actually
prescribes finds it first:

```
grep -rn 'duty_manager' apps/core --include=*.ts -l
```

The rule was right and the application was hollow. It is the same shape as §2.88's *"a leg must read
something that is not the thing under test"*, one level up: **a search whose scope is drawn from
what you already believe cannot correct that belief.**

**Mechanical form.** A census grep names a DIRECTORY and a glob, never a file list. If you catch
yourself typing the second path, you have stopped searching and started confirming.

**And the census count for a ROLE registration is now known and written down** — five test files
plus a production config, none of which share a shape:

| place | how it pins | grep finds it by |
|---|---|---|
| `scripts/seed-roles.ts` | the model itself | — |
| `test/seed-roles.test.ts` | 9 separate pins (counts, arrays, sums, README prose) | role name |
| `src/kernel/modules/manifests.test.ts` | 2 counts + a key list | manifest key |
| `test/seed-staff.test.ts` | a DERIVED array + a hand-pinned count | role name |
| `src/kernel/worker/scheduler.test.ts` | named array + a spy + a clock instant | job name |
| `docker/prod/prometheus/alerts.yml` | a regex alternation + an `absent()` chain | job name |



**2.134 — CHOOSE THE NARROW SUITE BY WHAT THE CHANGE CAN REACH, NEVER BY THE DIRECTORY YOU EDITED.** *(Plan 22c-A T1, 2026-08-29)*

A phase added one NOT NULL column with no default to `patients`. The session ran the two directories
it had edited — `src/kernel/db/schema` and `src/modules/patients`, 31 suites, 250 tests, all green —
and pushed. CI went RED twice, for two different reasons, both outside those directories:

- `apps/core/test/seed-roles.test.ts`, the REACHABILITY INVARIANT: the same commit declared two
  permissions and granted them to no role, which that test exists to refuse.
- three perf suites (`perf-search`, `perf-patient-search`, `perf-opd-queue`) that seed 100k–200k
  patients with hand-written `insert into patients (…) select … from generate_series`. Raw SQL, so
  the compiler cannot see them either.

AGENT-RULES §2.8 is right that the full suite belongs at the end. It does not say the narrow suite
may be picked by proximity, and proximity is what failed: a schema column touches every writer of
that table wherever it lives, and a permission touches the census wherever that lives.

**Mechanical form.** Before the narrow run, name the change's REACH and grep for it — not for the
directory:

```
# a new NOT NULL column on <table>
grep -rn "insert into <table>\|insert(<table>)" --include="*.ts" apps/core
# a new permission in a manifest
grep -rln "NOT_YET_MODELLED\|allPermissions()" --include="*.test.ts" apps/core
```

Every file that comes back joins the narrow run. Two greps, ten seconds, two red CI runs.

---

**2.135 — A REVERTED FIX MUST TAKE ITS TEST WITH IT. A TEST THAT OUTLIVES ITS DECISION DOCUMENTS THE OPPOSITE OF THE RULING.** *(Plan 22c-A, second close review, 2026-08-29)*

A close reviewer found that `POST /patients` still accepted `isConfidential` under a weaker
permission than the amendment path required. The session gated it, ran the suite, saw the gate break
eight shipped tests, and reverted — correctly, on a ruling it then spent thirty lines justifying in
the code. It left the e2e behind, still asserting `403`.

The second reviewer graded that CRITICAL and was right to. The failing assertion is the small harm;
the large one is that the test's TITLE — *"REGISTERING a confidential patient needs the same
permission as flagging one"* — now states the opposite of the ruling, in the place a future reader
looks first for the spec.

**Mechanical form.** A revert is not complete at `git checkout` of the source file. Before
committing a revert, run:

```
git diff --stat            # every file the fix touched, both directions
grep -rn "<the finding id>" --include="*.test.ts" apps
```

and for each test the fix added: DELETE it, or REWRITE it to assert the ruling you actually took.
Never leave it asserting the abandoned behaviour "so the coverage stays".

---

**2.136 — TWO FRESH REVIEWERS COST 3k/CALL AND FOUND A CRITICAL EACH; A RESUMED CHAIN COST 41k AND 112k/CALL FOR LESS.** *(Plan 22c-A close, 2026-08-29 — the measurement §2.115 asked for)*

§2.115 established that a resumed reviewer's per-call cost CLIMBS as its workload shrinks, and set
the rule *resume for MEMORY, spawn FRESH for SCOPE*. Plan 22c-A is the first phase to run the
fresh-only shape end to end and measure it against that record.

| | workload | tokens | calls | per call | found |
|---|---|---|---|---|---|
| **22c-A pass 1, FRESH** | 9 commits | 171,587 | 48 | **3,574** | 1 CRITICAL, 4 MAJOR, 8 MINOR |
| **22c-A pass 2, FRESH** | the remediation | 133,904 | 47 | **2,849** | 1 CRITICAL, 1 MAJOR, 3 MINOR |
| 13 pass 1, fresh | 8 commits | 175,209 | 38 | 4,610 | — |
| 13 pass 2, RESUMED | one 7-file diff | 205,365 | 5 | **41,073** | — |
| 13 pass 3, RESUMED | four yes/no questions | 224,081 | 2 | **112,040** | — |

**Plan 13's second pass cost 41,073 per call to do five calls of work. 22c-A's second pass cost
2,849 per call to do forty-seven.** Fourteen times cheaper per call, nine times more work, and it
returned a CRITICAL — a fix that had used `now()` (transaction-start time) where the defect needed
statement time, so the original hazard survived the remediation intact.

**The second pass is not insurance. On this evidence it is the term that pays**, and it pays most
when it is FRESH: a reviewer reviewing a remediation needs the DIFF and the findings, not the
transcript of how the first reviewer reached them. Total for both passes: 305,491 against a 458,491
review budget — **33% under, with two CRITICALs found.**

**Mechanical form.** Brief the second reviewer at the fixes, not at the phase: give it the one
remediation commit, the list of findings with what each fix CLAIMS to do, and ask for a verdict per
fix (CORRECT / INCOMPLETE / WRONG). That verdict table is what caught both defects here.

---

**2.137 — THE PRIVATE TEST DATABASE IS THE CHEAPEST FIX FOR PARALLEL-LANE CONTENTION, AND IT ERASES YOUR OWN AUDIT TRAIL. SAY WHICH DATABASE THE RUN USED.** *(Plan 17 phase 0, both close passes, 2026-08-29)*

Two lanes shared `/opt/hmis` all day. The protocol (`2026-08-26-parallel-session-protocol.md` §4) says a concurrent run's evidence is unreliable and to queue behind the other session. This phase hit the contention **four separate times** — `order_items_service_id_services_id_fk` violations in tests whose own fixture had just inserted the service, which is another run's `truncateAll` landing between the insert and the check — and one full verify came back with **105 failures, 188 of them `Exceeded timeout of 15000 ms`, across nine suites the phase does not touch**, with `orders.test.ts` taking **378 s against 27 s in isolation**. `uptime` at launch: load average **18.70**.

**Queuing was never necessary.** `test/helpers/db.ts:31-41` derives the worker database name from `TEST_DATABASE_URL`, so one env var gives a lane its own databases:

```
TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_<lane>_scratch" pnpm --filter @hmis/core exec jest …
```

`ensureWorkerDatabaseExists` creates them, `migrate()` brings them up from empty, and the contention disappears completely — suites that had been failing six at a time went 154/154 on the first isolated run. AGENT-RULES rule 7 sanctions it in as many words: *"a scratch database you create with a name that is obviously yours, use, and drop in the same task."*

**AND HERE IS THE HALF NOBODY WOULD PREDICT, WHICH COST A REVIEWER PASS TO LEARN.** The second close reviewer opened its report with a CRITICAL: migration `0045` *"has never been applied to any database on this host, so the 'full test run exit 0' evidence cannot cover the fixes it certifies."* Its evidence was real and it was thorough — every database it could see (`hmis_test_1..8`, `hmis_dev`) had `0044` as its highest applied migration, `pg_proc.prosrc` carried no `authority` clause, `order_items_cancelled_shape_ck` existed in no `pg_constraint`, and it correctly reasoned that `setupTestDb` migrates unconditionally so no run could have avoided it.

**Every observation true; the conclusion false.** The run used the override, and rule 7's *"drop in the same task"* had already removed the databases. The two obligations that make the technique safe are exactly what erase the proof it ran.

**MECHANICAL FORM — one clause, in two places:**

> When a run uses a non-default `TEST_DATABASE_URL`, NAME THE DATABASE where the evidence is claimed — in the commit message and in the phase document's mechanical-verification section.

Without it, `exit 0` is a claim about a database nobody can inspect, and an honest reviewer's only available conclusion is that the evidence is missing. **The refutation costs one command** (`jest -t "<the migration's tests>"` on a fresh isolated database, isolation line read from the output) — but the reviewer pass that raised it cost 152,552 tokens, and it spent its CRITICAL slot on a phantom.

---

**2.138 — §2.131's SIBLING-GREP CANNOT FIND A CENSUS THAT DERIVES FROM THE LIST. GREP THE LIST'S NAME.** *(Plan 17 phase 0 T5, 2026-08-29 — the third amendment to this rule in three days, and the mechanism is new rather than a re-application)*

§2.131 says: when adding a registration, grep for an existing SIBLING's IDENTIFIER, because a sibling's name appears in every place the new one must. §2.133 amended it to name a DIRECTORY AND A GLOB rather than a file list. **Both were obeyed exactly**, and the phase still missed three of five censuses.

The grep the phase document prescribed — `grep -rn 'formularyManifest' apps/core/src --include=*.ts` — returned eight lines across four files and named **two** censuses. The full verify then failed **three more**, all in `test/seed-roles.test.ts`: the per-module permission map, the reachability census (`107 declared = 91 held + 16 not yet modelled`), and a sorted literal of every unheld permission — plus four `NOT_YET_MODELLED` entries with reasons in `scripts/seed-roles.ts`.

**THE MECHANISM, AND IT IS WHY NO SIBLING-NAME GREP COULD HAVE WORKED.** §2.131's premise is that a sibling's name appears wherever the new one must. **That premise is false for a census that DERIVES from the one list instead of naming any member of it.** `seed-roles.test.ts` never writes `formularyManifest`, or `deskManifest`, or any manifest identifier at all — it reads `ALL_MANIFESTS` and counts. A grep for a NAME is structurally incapable of finding it, at any scope.

**MECHANICAL FORM:**

> When the thing you are adding is an ENTRY ON A LIST that other code derives from, grep for **the LIST's own name**, not for a sibling's:
> ```
> grep -rn "ALL_MANIFESTS" apps/core --include=*.ts | grep -v "<the file that defines it>"
> ```

That returns 34 lines across ~20 files and names all five, plus four more this phase then checked and found unmoved. **Sibling-name and list-name are two different searches, and only the second finds a derived census.** The rule now has both halves: grep the sibling for the places that NAME it, grep the list for the places that COUNT it.

---

**2.139 — `expect(spy).not.toHaveBeenCalled()` ON A FUNCTION THAT TAKES A `Db` OR `Tx` KILLS THE RUNNER WHEN IT FAILS. ASSERT ON THE ARGUMENT.** *(Plan 17 phase 0, T3's mutant run, 2026-08-29)*

A mutant run died after 92 seconds with `FATAL ERROR: Reached heap limit — JavaScript heap out of memory` and a 4 GB heap. It was not the mutant. `hasPermission(db, userId, permission, scope)` takes a drizzle handle as its FIRST argument, and when `not.toHaveBeenCalled()` FAILS, jest pretty-prints the received calls — serialising the connection pool and the whole schema graph.

**The assertion whose entire job was to fail loudly could not fail at all.** It passes silently (nothing printed) and dies on the one run that matters, which is the worst possible direction for a security assertion — this one guards "no permission lookup is ever performed on a patient credential id" (22c-A review D11).

**MECHANICAL FORM:**

```ts
// NOT: expect(spy).not.toHaveBeenCalled();
expect(spy.mock.calls.map((call) => call[1])).toEqual([]);   // the ids, not the handles
```

It prints small **and it is the sharper claim**: *no lookup was made WITH THE PATIENT'S CREDENTIAL ID*, rather than *no lookup was made at all*. Applies to any spy on a function whose parameters include a `Db`, `Tx`, pool, registry or Nest module.

---

**2.140 — A CRITICAL FIX CAN BE INCOMPLETE IN ITS OWN DIMENSION, AND THE FIX ITSELF CAN OPEN THE NEXT DOOR. THE SECOND REVIEWER IS NOT OPTIONAL.** *(Plan 17 phase 0, close pass 2, 2026-08-29 — §6's second-pass argument, with a specimen)*

Pass 1 found a confidentiality CRITICAL: the restricted-item filter filtered ITEMS and returned every HEADER, so an order whose every item was restricted came back as a real header with `items: []`, carrying `orderNo`, `placedAt`, `orderingClinicianId` and `indication` — free clinical text reading *"post-exposure prophylaxis, needle-stick, source patient unknown"*. The fix dropped such orders and nulled the indication. It was verified by a mutant, ran green, and passed CI.

**Pass 2 found the same dimension still open, twice:**

- **The header's own `status`/`closed_at` remained a deterministic channel on a PARTIALLY restricted order.** The close fires only when no item is live, so an `open` header whose every VISIBLE item is terminal proves a hidden live item exists; and because the close picks `closed` over `cancelled` only when something COMPLETED, a `closed` header whose visible items are all `cancelled` proves a hidden item ran. That is the boolean the first fix had removed for being too revealing, re-derived from two fields it left in place.
- **The first fix CREATED a counting oracle.** It filtered rows AFTER a `LIMIT` applied to the header query, so varying the caller-supplied `limit` over restricted orders at ranks 1 and 4 returned **0, 1, 2, 2, 3** — the flat spots name their exact ranks, and each hidden order is bracketed in time by its visible neighbours' timestamps. Strictly more disclosure than the field that was removed, from a knob the caller turns. It was also a plain paging bug: a screen asking for 20 silently got 17.

**THE GENERAL RULE, and it is sharper than "review the remediation":**

> When a fix REMOVES a disclosure, enumerate every OTHER field on the same response that is a function of the removed one, and every caller-supplied parameter that interacts with the filter. A filter applied at one level of a nested structure is not a filter; a filter applied after a limit is a counter.

**And the cost comparison that settles §6's second term.** Both passes FRESH: 195,491 / 40 calls = **4,887 per call**; 152,552 / 48 calls = **3,178 per call** — the second pass was CHEAPER per call than the first despite reviewing a diff, which is §2.136 confirmed on a second phase and the opposite of a resumed chain's 41k and 112k. **348,043 total against a 458,491 review term: 24% under, and the second pass found a live confidentiality leak the first pass's own fix had created.** A stop-loss that halted it would have shipped that leak.

---

**2.141 — THE STOP-LOSS'S PER-TASK TERM IS MEASURED FROM A NUMBER THAT EXCLUDES THE MAIN SESSION, SO IN A LIGHT PHASE IT BUDGETS THE ONE COST THAT IS NOT THERE.** *(Plan 17 LIMS core, stopped at the T2 boundary, 2026-08-29 — and the first in-session MEASUREMENT of main-session cost, runbook O3's open item since Plan 11e)*

`EXECUTE-METHOD-V3` §6 sets a phase's stop-loss as
`1.5 × (per-task rate × task count) + one full reviewer pass per remediation cycle`, and every LIGHT
phase since 16a has taken the per-task rate from `token-baselines.json`. **Every row in that file is
SUBAGENT tokens**, and the file says so in its own first line. In a LIGHT phase the subagents ARE
the reviewers — 16a's 181,605 is one close reviewer over nine tasks it did not write — so the rate
that gets multiplied by the task count is a REVIEW rate wearing a task rate's clothes. Plan 17's own
phase document states the bias in one sentence and then does the multiplication anyway: *"in a LIGHT
phase `subagentTokens` IS the reviewer, so this is review cost in execution clothing; main-session
cost is unmeasurable from inside."*

**THE MEASUREMENT.** Plan 17 set 730,000 from `1.5 × (20,178 × 9) = 272,403` plus a 458,491 review
term. It then spent **~482,000 tokens on TWO ROUTINE TASKS with ZERO subagents** — 66% of the whole
stop-loss, and 1.8× the entire nine-task term, before a single CRITICAL task or either reviewer had
run. Per task that is ~241,000 against a budgeted 30,267 (the 20,178 rate with its 1.5× applied):
**eight times over, and 24× the un-multiplied rate.** The two tasks delivered were the CHEAP ones:
one migration and one module skeleton, no mutants owed at either, no concurrency rows to measure.

**AND THE HALF THAT IS NEW RATHER THAN A RE-STATEMENT.** Runbook O3 has said since Plan 11e that
main-session cost is *"unmeasurable from inside"*, and every baseline note since repeats it. **It is
no longer true.** A session with a token budget can read its own remaining balance between two
points and subtract. That is not `/cost` — it includes the harness's own overhead and cannot be
attributed per task without more care — but it is a figure where there was none, and it is within
the reach of any session that chooses to take it.

**WHY THE UNDERESTIMATE IS STRUCTURAL AND NOT THIS PHASE BEING SLOW.** A LIGHT phase moves the
coding INTO the main session; the whole lane is defined by that move. So the term that scales with
TASKS is precisely the term that measures nothing, and the term that measures something (review)
scales with what the tasks got wrong. **A formula whose only measured input is the reviewer cannot
bound a lane whose defining property is that the reviewer is not doing the work.** Every LIGHT phase
that came in under its stop-loss did so on the review term alone — 14 at 458,491 against 675,000,
15 at 463,509 against 730,000, 17 phase 0 at 348,043 against 458,491 — and in each of those the
main-session spend was never in the number at all. **They were not under budget. They were
unmeasured.**

**MECHANICAL FORM — two lines, and the first costs one subtraction:**

> **(1) Every session executing a phase records its own token balance at kickoff and at each task
> boundary, and writes the deltas into CLOSE.** Three phases of that turns the per-task rate into a
> measured number instead of a borrowed one.
>
> **(2) Until that exists, a LIGHT phase's stop-loss carries a THIRD term — the main-session
> term — and it is the largest of the three.** From this phase's only data point, a ROUTINE task
> costs ~240k of main session including its share of the one-off reading; price a phase at
> `main-session term ≈ 200k × task count`, say it is a single measurement, and revise it at the next
> close. `token-baselines.json` gains a `mainSessionTokens` field so the next audit compares rather
> than guesses.

**AND THE RULE THAT FALLS OUT OF IT, WHICH MATTERS MORE THAN THE ARITHMETIC.** A nine-task
full-module build is not a LIGHT phase at the current per-task cost; it is two. Plan 17 recommends
its own re-cut at close — T3–T5 (order to accession) and T6–T9 (result to report) — because the
alternative is a stop-loss that fires at 66% through task two, which is exactly what happened.
**A lane ruling made on task COUNT without a main-session rate to multiply it by is a guess, and
§2.95's lesson — "a caveat is not a calculation" — applies to the lane decision and not only to the
ceiling.**

---

**2.148 — THE LEDGER HAS GROWN 30% SINCE THE RULE THAT BUDGETS IT WAS WRITTEN. "READ THE LEDGER" IS NOW A 106k INSTRUCTION.** *(Plan 18a T2/T3 audit, 2026-08-31 — §9.1 rule 1's own number, re-measured)*

v3 §9.1 rule 1 says *"`§2.54` in a brief causes a targeted read; `EXECUTION-LESSONS.md` causes an
**81k** one, on every turn."* **Measured today: `wc -c` is 423,035 bytes — 105,758 tokens.** The
number in the rule is 30% stale, and it drifted in the direction that makes the rule MORE important,
which is the direction nobody checks.

**This phase read NONE of it and lost nothing**, and that is the specimen rather than an aside. T2
and T3 cited `§2.137`, `§2.138`, `§2.140` and `§2.144` by number, every one of them reached through
the phase document or the handoff, and the ledger file was never opened. The saving is not
theoretical: a single brief saying "read the ledger" would have added ~106k to the context of every
turn in a two-task, ~100-turn stretch.

**The mechanical form — a check, not an intention:**

```
grep -nEi "read (the )?(ledger|EXECUTION-LESSONS)" <the brief>   # must return nothing
wc -c docs/superpowers/plans/reports/EXECUTION-LESSONS.md         # re-measure at every audit
```

**And the standing obligation this creates**: the token audit re-measures the ledger and amends
§9.1 rule 1's figure. A rule whose justification is a number that nobody re-reads decays into
folklore — which is what §2.54 is about, applied to the method document itself.

---

**2.147 — A SOURCE-CENSUS GREP INSIDE A TEST MATCHED ITS OWN PROSE AND FAILED AGAINST A CORRECT CODEBASE.** *(Plan 18a T3 A5, 2026-08-31)*

T3 A5's census asserts that no module inserts into `order_items` — the kernel's `placeOrder` is the
only writer, and a module that inserted directly would be the write phase 0 §6A.5 warned about. The
assertion ran `grep -rn 'insert(orderItems)' src/modules` and expected empty.

**It failed. The two matches were `place.ts`'s own docstring — the paragraph EXPLAINING the rule —
and the assertion's own source line.** The codebase was correct; the census was not. A census that
cannot survive being documented is a census that will be deleted by the next person who reads it,
along with the property it was protecting.

**The mechanical form:**

```
grep -rn '<pattern>' src/modules --include=*.ts \
  | grep -v '\.test\.ts:' \
  | grep -vE ':[[:space:]]*(\*|//)'
```

Exclude test files and comment lines, always. The same shape applies to every source-reading census
in this repository — `ist-clock-parity`, the manifest list-greps, and any future one.

---

**2.146 — A FIXTURE'S REQUIRED COLUMNS ARE ONE GREP. DISCOVERING THEM FROM INSERT ERRORS COST FOUR TURNS AT FULL CONTEXT.** *(Plan 18a T3, 2026-08-31)*

Writing two test fixtures, this session discovered the NOT-NULL-without-default set of
`opd_encounters` by insert failure **three times in a row** — first a missing `updatedBy`, then a
drizzle overload error that hid the real cause, then `openedBy` where `createdBy` had been guessed —
and `imaging_studies`' ABSENCE of audit columns a fourth time, in the other direction.

**Each round trip is one billed turn at the full session context.** In a LIGHT phase that is the
unit of cost §9.9 names, and four of them bought information that one command returns:

```
awk "NR>=<start> && NR<=<end>" <schema file> | grep -E "notNull\(\)" | grep -v "default"
```

Run it BEFORE writing any fixture insert, for every table the fixture touches. It returns the exact
required set — and the second direction too, because a column the table does NOT have is exactly as
expensive to guess wrong.

**The generalisation worth keeping**: an error message is a slow, expensive oracle for a fact the
source states directly. Where a schema, a union or a config file KNOWS the answer, read it once
rather than probing for it.

---

**2.145 — THE SECOND REVIEW PASS CONDEMNS A THIRD OF THE FIRST PASS'S FIXES, TWO PHASES RUNNING. BUDGET REMEDIATION TWICE, NOT ONCE.** *(Plan 17b LIMS result→report, closed 2026-08-30 — §2.140's third specimen, and the first with a RATE)*

§2.140 established that a critical fix can be incomplete in its own dimension and that the fix
itself can open the next door. It had one specimen. There are now two, and they agree:

| phase | pass 1 fixes | condemned by pass 2 | NEW defects the fixing commit created |
|---|---|---|---|
| 17a | 5 | **3** | 1 (a live confidentiality leak) |
| 17b | 13 | **4** | **2** |

**Roughly a third of a first pass's fixes are wrong, and the fixing commit reliably introduces one
or two of its own.** That is not a risk to note; it is a rate to budget. 17b's two:

- **`partial` was ONE FIELD CARRYING TWO MEANINGS** — the flag on the report row AND the
  permission to publish with unfinished items. The fix for "a completed partial stays stamped
  partial" passed `false` for the flag and silently closed the gate, so a partial report could never
  be AMENDED and the version carrying a wrong haemoglobin stayed published. **A fix that sets a
  parameter must ask what else that parameter is.**
- **A CLASS FIXED AT ONE SITE AND LEFT AT ITS SIBLING, IN THE SAME COMMIT.** "A failed query renders
  as a clinical negative" was repaired on the consult panel and left standing on the critical-call
  panel — a file the same commit rewrote — where a 401 made the red banner vanish and a bench with
  no banner looks exactly like a bench with no open critical calls.

**And a third shape §2.140 does not name: A FIX CAN BE APPLIED TO THE WRONG ONE OF TWO TWINS.** The
unlocked sibling-count race was fixed on the VERIFY side (two pathologists signing the last two
analytes — rare) and left on the ENTRY side (two technologists keying them — routine). The reviewer
found it by asking "where else does this shape exist", which is the §5 habit that also found §3.43.

**MECHANICAL FORM — three checks, each cheap, each bought by a real defect:**

> 1. **For every parameter a fix SETS, grep its name in the callee and read every use.** `partial`
>    had two, twelve lines apart.
> 2. **For every class of defect a fix closes, grep the class across the module and fix every
>    instance IN THE SAME COMMIT** — `results.data ?? []` returned four hits and three were left.
> 3. **When a fix serialises a race, name the OTHER function with the same shape.** Ask which of the
>    two is more frequent, and fix that one first.

**AND BUDGET THE REVIEW LANE AS THE LARGEST TERM.** 17b: pass 1 **238,225** / 63 calls, pass 2
**245,017** / 52 calls, and the two remediation rounds cost the main session roughly as much again —
**~965,000 for the review lane against ~645,000 for all four tasks' coding.** §2.143 amended the
formula to `review × (1 + remediation factor)` with a factor of 1.0; the measured factor here is
**~1.0 for pass 1 alone and ~2.0 once pass 2's remediation is counted.** The next stop-loss uses 2.0.

---

**2.144 — TWO LANES SPENT SIX FULL VERIFIES CALLING THE INSTRUMENT BROKEN. IT WAS ONE TEST AT 72% OF ITS DEFAULT BUDGET ON AN IDLE BOX, AND A CASCADE HID IT.** *(Plan 17a close-out, 2026-08-30 — §2.99's third specimen, and the first one nobody could see)*

`pnpm verify` on the build host failed six consecutive times across two lanes, with **11, then 15,
then 1 failing suites** as the box quietened and almost no overlap between the sets. Both lanes
independently concluded "the local verify is broken as an instrument" and fell back to CI. Both were
right about the symptom and neither had the cause.

**THE CAUSE, MEASURED IN ONE COMMAND.** `advance.test.ts`'s C1 — the only suite in all three sets —
**takes 10,847 ms on a completely idle host against jest's 15,000 ms default.** It is EIGHT rounds of
`truncateAll` + full re-seed + a real two-transaction race (§2.3: a race measured once is a race not
measured), so ~1.35 s per round is arithmetic, not waste. At 72% of budget with nothing else running,
any load at all tips it — which is exactly §2.99 and Plan 09a's nine-seconds-in-fifteen, one notch
tighter.

**AND THE CASCADE IS WHY IT LOOKED LIKE NOISE RATHER THAN A TEST.** C1's timeout killed it
mid-`seedFixture`, leaving a `patients` row behind; the NEXT test's seed then died on
`patients_pkey`. So one real fault was reported as two, the second naming a constraint unrelated to
anything, and the *set* of failures moved run to run with scheduling. **A suite that turns one fault
into N derived faults does not look like a failing test. It looks like a broken machine.**

**MECHANICAL FORM — two commands, and the first is the whole diagnosis:**

```
# 1. time the suspect ALONE on an idle box and compare to the default
pnpm --filter @hmis/core exec jest <path> -t "<the test>" --verbose   # read the (N ms)
#    > 50% of 15,000 on an IDLE host  ⇒  it will fail under any parallel load

# 2. find every fixture that can cascade: a fixed-id insert with no conflict clause
grep -n 'insert(.*).values({$' -A 3 <the suite> | grep -v onConflict
```

The repair is an explicit timeout on the ONE expensive test (120,000 ms here, ~11x measured idle —
a TIMEOUT, not a retry; assertions untouched) plus `onConflictDoNothing` on the fixture so a fault
reports once. **After it: `pnpm verify` exit 0, 305/305 suites, 2977/2977 tests, zero timeouts — the
first fully green local full verify either lane had had.**

**THE RULE:** before declaring a shared instrument broken, **time its slowest failing test alone on
an idle host.** A verify that fails differently every run is reporting scheduling, and scheduling
noise almost always has a single test sitting just inside its budget underneath it.

---

**2.143 — THE STOP-LOSS WAS RIGHT IN TOTAL AND WRONG IN EVERY TERM, AND THE TERM IT MISSES IS THE ONE THAT FIXES WHAT THE REVIEWER FOUND.** *(Plan 17a LIMS order→accession, closed 2026-08-30 — the sequel to §2.141, and the other half of the same error)*

§2.141 found the formula budgeting a REVIEWER's rate for a LIGHT phase's CODING. Plan 17a set its
stop-loss from that correction, and the correction was itself incomplete. Measured at close:

| term | budgeted | actual | |
|---|---|---|---|
| main-session (`90,000 + 3 × 330,000`) | 1,090,000 | **~794,000** | **27% UNDER** |
| task subagents (`1.5 × 20,178 × 3`) | 90,801 | **0** | no task subagent was ever spawned |
| review (two fresh passes) | 260,000 | **447,402** | **72% OVER** |
| **total** | **1,350,000** | **~1,241,000** | **92% — right to 8%** |

**A total that lands at 92% of a ceiling built from three terms that are 27% under, 100% under and
72% over is not a validated formula. It is three errors cancelling.** The phase reported "51% of
stop-loss" at its T5 boundary and that number was true and useless: it was measured before the close
review and before the remediation, which together are a third of the phase.

**THE TERM THAT DOES NOT EXIST, AND IT IS THE EXPENSIVE ONE.** The formula budgets the reviewers. It
does not budget **fixing what they find**. Pass 1 returned 2 CRITICAL + 7 MAJOR and pass 2 returned
five more; remediating twelve findings — reproducing each as a red test, repairing, re-running — was
main-session work no term names. §2.141's lesson was *the formula budgets the reviewer and not the
coder*; this phase's is **the formula budgets the reviewer and not the REPAIR**, and the repair scales
with what the review finds, which is exactly the quantity nobody can predict.

**MECHANICAL FORM — a fourth term, and it is a MULTIPLIER on the review term rather than a constant:**

```
stop-loss = main-session term
          + 1.5 × (per-task subagent rate × task count)     ← drop to 0 for a LIGHT lane
          + review term × (1 + remediation factor)
```

`remediation factor ≈ 1.0` on this phase's measurement (447,402 of review produced roughly its own
weight again in repair). **Set it from the last comparable phase's ratio, and if the lane is LIGHT,
delete the task-subagent term rather than carrying it at its old value** — 17a carried 90,801 for
agents it never spawned, which is the same shape of error §2.141 named, surviving its own correction.

**AND THE HONESTY RULE THIS BUYS.** A phase that reports a percentage of stop-loss BEFORE its close
review has reported a number that cannot be compared to any other phase's. **Report the fraction only
at CLOSE, or report it with the review and remediation explicitly named as unspent.** Plan 17a did
the latter in its §9.7 and then said "roughly three times what the phase needs" in prose one
paragraph later — the caveat did not survive the summary, which is how a wrong number reaches the
next lane ruling.

---

**2.142 — TWO LANES SHARING A CHECKOUT IS A KNOWN HAZARD; TWO LANES SHARING A *FILE* NEEDS A DIFFERENT TOOL, AND `git add <path>` IS NOT IT.** *(Plan 17 LIMS core T1/T2, 2026-08-29)*

The parallel-session protocol §3 rule 1 says *"stage explicitly, by path. Never `git add -A`."* That
rule was written for two lanes touching different FILES, and it is sufficient there. Plan 17 and
Plan 18a touched **the same four files**: `drizzle/meta/_journal.json` (one migration entry each),
`kernel/db/schema/index.ts` (one export block each), `kernel/orders/parity.test.ts` (two different
censuses in one file) and `test/helpers/db.ts` (each lane's tables in `truncateAll`). **`git add
<path>` stages a whole file**, so obeying the rule literally would have swept the other lane's
uncommitted work into this phase's commit.

**AND THAT SWEEP WAS NOT MERELY UNTIDY, IT WAS A RED `main`.** The other lane's `truncateAll` hunk
names `pcpndt_form_f` and `pcpndt_registered_persons`; their migration was on disk and UNTRACKED.
Committing the helper without the migration ships a `truncateAll` that references tables no
migration creates, which fails on the FIRST `setupTestDb` of every suite on a fresh database —
every DB test in the workspace, on CI, for everyone.

**MECHANICAL FORM — stage HEAD-plus-your-hunks as a blob, never the worktree file:**

```
git show HEAD:<path> | <apply ONLY your edit> | git hash-object -w --stdin --path <path>
git update-index --cacheinfo 100644,<sha>,<path>
```

The worktree keeps both lanes' edits; the INDEX gets yours alone; `git diff --cached --stat <path>`
confirms the hunk count before committing. Two cautions bought by doing it: pipe the content through
ONE interpreter (a heredoc inside a `$(…)` substitution silently feeds the heredoc to the wrong
stdin, which staged an empty blob and showed as **84 deletions** in `--stat` — read that stat every
time), and the committed tree then differs from the tested worktree, so **CI-by-full-SHA is the
load-bearing evidence for such a commit and the local run is corroboration.**


### 2.149 — A SPIKE ASKING "WHO BREAKS ON THIS STATE" GREPS THE WRITERS, NOT JUST THE READERS

RC-1's S2 asked whether an encounter with no queue entry breaks anything, answered it from the
READ models (`listQueue`, boards, worklists — all tolerant), and declared the deferred visit safe.
The two WRITES that key off the same `status=registered` predicate — `recordVitals` and
`abandonVisit` — both deref'd `entries[0]!` and both 500'd, which made the new state UNCLOSABLE:
the only exit was minting a token for a patient who had left. 55 green tests, a died mutant and a
clean typecheck sat on top of it; pass 1 of the close review found it (C1) in its first section.
**The mechanical form:** before declaring a new state reachable, enumerate EVERY consumer of the
predicate that gates it — `grep -rn "entries\[0\]!\|status === \"registered\"" <module>` at
directory scope — and sort the hits into readers and writers; the spike is not answered until the
writers column is empty or each writer has a stated behaviour for the new state.

### 2.150 — A FIX THAT ARMS A DORMANT GUARD OWES THAT GUARD A RE-READ, IN THE SAME TASK

RC-1 T1 undid a zod strip: `receipt.changeGivenPaise` had been silently discarded at the controller
since 07b, so the two guards behind it had NEVER RUN with a non-zero value. T1 declared the field
and shipped; the close review then found (M4) that the guard it had just armed compared change
against the WHOLE-receipt surplus with only a cash-EXISTS check — ₹1 of cash beside a card
overpayment authorised handing the card's surplus out of the drawer as change. The guard was not
wrong when written; it was wrong when ARMED, and the arming commit never re-read it. Pass 2 then
found the twin one layer up: the shipped screen defaulted the field to the whole surplus, so the
CORRECT server ceiling would have hard-failed every mixed tender from the screen's own default.
**The mechanical form:** when a change makes a dead field live (un-stripping, un-flagging,
declaring), `grep -rn "<field>" apps/` and re-read every consumer AS IF IT WERE NEW CODE in the
same task — the guard, and whatever fills the field.

### 2.151 — ON A MULTI-LANE BOX, THE FULL VERIFY IS A SLOT TO SCHEDULE, NOT A COMMAND TO RUN

Five OOM kills in one evening, two lanes, one 15 GB box: dmesg names jest workers of BOTH lanes
(20:49, 20:52, 21:12, 21:15, 21:16 — RSS 0.9–1.4 GB each). The mechanism is structural, not bad
luck: `pnpm verify`'s `pnpm -r test` runs core's jest and web's vitest CONCURRENTLY — two
independent worker pools — and a second session's queued run waits on the same load gate and joins
at the worst moment. Every red produced this way passed isolated on a byte-identical tree (the
2026-08-26 protocol's §4, measured again); web files "timing out at 5000ms" inside 92-second runs
came back at 643–948 ms isolated — a hundredfold, from contention alone.
**AMENDED the same night (the VD-1 lane's measurement, and it is the ROOT CAUSE): the slot rule is
necessary and NOT sufficient, because `apps/core/jest.config.js` sets no `maxWorkers`.** Jest
defaults to `nproc − 1` = 7 workers on this box, each ts-jest worker reaches 1.0–1.5 GB RSS, and
7 × ~1.2 GB on a 15.6 GB host with ~8 GB resident OOMs with the box otherwise QUIET of jest —
measured at 23:01: 13.9 GB used, 553 MB free, loadavg 80.84, a solo `tsc` killed alongside. **One
lane alone, holding the slot, obeying this entry as first written, still dies without `-w 2`.**
The durable fix is `maxWorkers: 2` in the shared jest config — an OWNER ruling (it slows CI and
must not change under a running suite), surfaced, not applied unilaterally.
**AMENDED AGAIN the same night (the 18a lane's specimen): THE SAME CLASS FIRES ON CI ITSELF, so
"cite CI as the instrument" carries a caveat.** CI run 33436302396 (commit 835ca2a) went red in
117 minutes against its parent's 57 with **846 of 1,016 failure blocks being 15-second hook
timeouts inside `setupTestDb` and ZERO assertion diffs** — the starvation signature without the
kill, because CI runs the same unbounded jest and the same concurrent `pnpm -r test` on a runner
where the pools throttle instead of dying. A threshold effect, not a constant: the adjacent
41a04b2 run was clean. **A red CI run whose failures are hook timeouts with no assertion diff is
the RUNNER, and the cap ruling would fix CI too — likely making it FASTER, not slower.**
**The mechanical form:** (a) before any broad run, `ps -eo pid,cmd | grep -E "jest|vitest"` and, if
another lane owns the box, MESSAGE that session and take turns — the slot is negotiated, the OOM
killer is not; (b) run the halves sequentially with the exit value read from each —
`pnpm --filter @hmis/core exec jest -w 2 …` then `pnpm --filter @hmis/web exec vitest run` —
**and the `-w 2` is load-bearing, not a preference, until the config carries the cap**; (c) cite
CI-by-full-SHA as the full-suite instrument when the box never quiets — **after reading the
failure SHAPE: hook timeouts with zero assertion diffs are the runner, not the tree.**

### 2.152 — `git commit` COMMITS THE INDEX, AND ON A SHARED CHECKOUT THE INDEX IS SHARED TOO

RC-1's ledger commit `43986ed` staged ONE file by explicit path and committed — and carried **54
lines of the 18a lane's phase doc** that the other session had staged seconds earlier. Protocol
§3.1's "stage by path, never `-A`" was OBEYED and was not enough: staging by path adds to an index
that another lane may also be writing, and a bare `git commit -m …` ships everything in it. The
sweep was visible in the output — `2 files changed, 64 insertions` against a ~15-line edit — and
went unread; the other lane found it when its own commit no-opped with "no changes added".
**The mechanical form, either of:** (a) commit WITH a pathspec — `git commit -m "…" -- <your
paths>` — which commits only those paths whatever else is staged; or (b) `git diff --cached --stat`
read IMMEDIATELY before every commit, compared against your own Files list, on any checkout another
session can reach. And in all cases: **read the commit's own stat line against the size of what you
wrote** — a 4× insertion count is the tree telling you whose work you just took.

> **AMENDED 2026-09-01 (found by the RC-2 lane, before it committed rather than after) — A PATHSPEC
> PROTECTS AGAINST A DIRTY INDEX AND NOT AGAINST A PEER'S DIRTY WORKING TREE, AND THE TWO ARE
> DIFFERENT HAZARDS.**
>
> `git commit -- <path>` commits the **working-tree** state of that path. So when two lanes edit the
> SAME file, the pathspec form — this entry's own prescription — sweeps the other lane's uncommitted
> edits into your commit, and `git diff --cached --stat` shows exactly the file you intended with
> nothing wrong at all. The stat check cannot see it either: one file, and the line count is the sum
> of two lanes' work in a file both were legitimately editing.
>
> Specimen: VD-1 T4 and RC-2 T4 both add one permission, so both touch `scripts/seed-roles.ts`,
> `opd|membership manifest.ts`, `test/seed-roles.test.ts` and `README.md`. A pathspec commit from
> either side would have carried the other's grants. **The RC-2 lane caught it by reading
> `git status` before committing and seeing the four census files already dirty — and stopped.**
>
> This entry's original specimen was staged lines in OTHER files, which by-path staging DOES catch.
> This is the case it does not, and the difference is whether the two lanes share a PATH.
>
> **The rule for a shared checkout: before committing a file a permission/census/manifest edit
> touches, `git status --porcelain <that path>` and confirm the dirt is yours. If a peer holds the
> same path, one of you LANDS FIRST and the other rebases** — that is cheaper than reasoning about
> which half of a hunk belongs to whom, and it is the only form that is safe rather than careful.

> **AND THE AMENDMENT CAME TRUE NINETY MINUTES AFTER IT WAS WRITTEN, IN THE COMMIT OF THE LANE THAT
> WROTE IT.** `a50e68a` (VD-1) committed `test/seed-roles.test.ts` with a pathspec while the RC-2
> lane held uncommitted edits in that same file. Measured after the fact:
> `git show a50e68a:apps/core/test/seed-roles.test.ts | grep -c RC2_ENROL` → **4**. Five added lines
> of the other lane's work — `RC2_ENROL_PAIRS`, its prose constant, and `membership: 8` — landed
> inside a VD-1 commit.
>
> **The author of the amendment then cleared the commit using the exact check the amendment says
> cannot see this.** The all-clear sent to the peer was *"nothing of yours is in `a50e68a`: two
> files"* — a STAT reading, and the amendment above says in its own words that the stat cannot see
> it, because it is one file and the line count is two lanes' work summed. The prescribed check —
> `git status --porcelain <that path>` **immediately before** committing — had been run early in the
> task and not again at commit time, while the peer was actively editing that file.
>
> **The consequence was worse than misattribution: main went red in a SPLIT state.** The swept
> census expected `membership.instrument.enrol` while the manifest and grants declaring it were
> still uncommitted on the other side, so anyone pulling between `a50e68a` and `15194fe` got a tree
> that could not pass.
>
> **The general form, and it is the one worth carrying: a rule you wrote is not a rule you follow.**
> Writing the amendment produced no habit at all ninety minutes later; what was needed was the
> command in the sequence, not the reasoning in the ledger. §4 of the method — *checks are scripts,
> or they are not method* — is the standing answer, and this is its specimen.

### 2.153 — A SUITE THAT FAILS TO *RUN* CONTRIBUTES NO TEST COUNTS, SO THE GREEN NUMBER STAYS GREEN

VD-1 T3's evidence run returned:

```
Test Suites: 2 failed, 33 passed, 35 total
Tests:       257 passed, 257 total
```

**Zero tests failed, and two suites were red.** A suite that dies at load — a compile error anywhere
in its import graph — never registers a test, so it contributes nothing to the `Tests:` line while
contributing a failure to the `Test Suites:` line. The two numbers are counting different things
and only one of them can see the failure.

This is the **third** distinct shape of not-a-real-red on this project, beside §2.151's two (OOM
kills naming a pid; `setupTestDb` hook timeouts with zero assertion diffs), and it is the most
dangerous of the three, because **the number a reader's eye lands on is the reassuring one.** The
cause here was `billing/billing.controller.ts:503` in a PARALLEL LANE's uncommitted work — a call
site that had grown a `feeQuote` parameter the options type had not — which took down
`advised-tests.test.ts` and `test/opd.e2e.test.ts`, neither of them in this phase's diff and
neither of them a billing file.

**The mechanical form:** when `Test Suites: N failed` disagrees with `Tests: 0 failed`, read the
`● Test suite failed to run` blocks BEFORE forming any theory about your own diff — the message
names the file and line, and on a shared checkout it is quite often another lane's. Never quote the
`Tests:` line alone as a verdict; quote both, or quote the runner's exit value.

**And the shared-checkout half, which §2.151 and §2.152 do not cover between them:** those two
govern the BOX and the INDEX. This is the **window** — the interval in which a multi-file edit is
uncompilable to everyone else in the tree. A lane typechecking at the end of a five-file thread is
correct for itself and broken for every concurrent reader. *Land a multi-file thread in one shot and
typecheck before yielding the tree.*

### 2.154 — A RACE TEST THAT HAS NEVER BEEN SHOWN TO FAIL WITHOUT ITS LOCK HAS NOT BEEN SHOWN TO MEASURE THE LOCK

VD-1 T3 built a mutant of `cancelEscalation` with the encounter-row `FOR UPDATE` removed. **The
concurrency suite passed against it.** The suite's own docstring had asserted the property it
lacked — *"Both promises are therefore started before either is awaited"* — which is true,
necessary, and **not sufficient.**

A probe against the unlocked mutant reported `settled: ["ok", "escalation_state_conflict"],
events: 1`: the unlocked code behaving perfectly, because nothing concurrent had happened.
**`pg.Pool` opens connections lazily.** Caller #1 reuses the idle connection the fixture left;
caller #2 must establish a NEW one, and that TCP-and-auth handshake is longer than the entire first
transaction. So caller #2 began its SELECT *after* caller #1 committed, read the settled state, and
lost on the ordinary state check — the right answer, reached without the lock ever being exercised.
**The connection-establishment cost sits INSIDE the window you believe you are measuring.**

Warming the pool first — `await Promise.all(Array.from({length: 4}, () => db.execute(sql\`select
pg_sleep(0.05)\`)))`, at least as many concurrent round-trips as the race has participants — moves
that cost out of the window. Mutant C then died with the damage the lock exists to prevent:

```
Expected length: 1 · Received length: 2
  two queue.escalation_cancelled events, actorId 01M1DWF41B… and actorId 01M1DWF42959…
  both restoredClass: 3, both withinMs: 3000
```

**One act, recorded twice, under two different names — with the restored class correct either way,
so nothing user-visible would ever have surfaced it.** That is why a race over an AUDIT TRAIL must
actually race: the damage is entirely in the record.

This is §2.99's sibling and it is sharper. §2.99 is *a race test that passes on an idle host*; this
is **a race test that cannot fail at all**, because the concurrency it measures belongs to the
connection pool rather than to the code. **The mechanical form, and it is two lines:** warm the pool
before the measured window, and then REMOVE THE LOCK AND CONFIRM THE TEST GOES RED. A green race
test whose mutant survives is certifying a lock it never touched.

> **A live question this leaves, recorded rather than closed:** RC-1 T3's join-queue race mutant
> died on an UNWARMED pool. That may have been the right kill or a lucky interleaving, and the two
> are indistinguishable after the fact. Not grounds to reopen a closed phase; it IS grounds for the
> next phase touching that path (RC-3) to warm the pool and re-run the mutant before trusting the
> guard. Raised by the RC-2 lane against its own predecessor's work, which is the behaviour this
> ledger exists to encourage.

### 2.155 — A CENSUS CAN LIVE IN A MARKDOWN TABLE, AND ONLY THE SIBLING GREP FOLLOWED **TRANSITIVELY** REACHES IT

§2.138 already says *grep the SIBLING for the places that NAME it, and grep the LIST for the places
that COUNT it*. VD-1 T4 added one permission and found that both greps, run exactly as written, are
still one hop short.

**Three censuses moved for one string** (`opd.vitals.history.read`):

1. `opdManifest.permissions` — the declaration. Found by writing it.
2. `test/seed-roles.test.ts`'s per-module count map, `opd: 15 → 16`. Found by the LIST grep.
3. **A permission table in `README.md`** — ticked per role, and **parsed by a hand-written parser
   inside that same test**, which throws *"this parser is stale"* when it cannot identify a table
   by its first role column. Found by NEITHER grep.

The only path to (3) is the SIBLING grep **followed into what the test it lands on actually reads**:
`grep -rn "opd.counter.flow.manage" apps/core --include=*.ts` returns `seed-roles.test.ts`; opening
that file to see why shows it PARSING A MARKDOWN FILE. No grep over `--include=*.ts` can reach a
census that lives in `README.md`, and no grep for the NEW string can reach anything at all —
**the string does not exist yet, which is the whole point of adding it.**

**The rule, and it is the correction to how §2.138's greps are usually run:** grep a sibling that
ALREADY WORKS, never the string you are adding — the censuses you are about to break are the ones
currently holding a value. Then **open what the sibling grep returns and read what those files
consume**, because a census is not always code: it can be a table in prose, a fixture, or a
generated file. The check that would have caught it mechanically is to widen the sibling grep past
the code glob:

```
grep -rn "<an existing sibling string>" . --exclude-dir=node_modules --exclude-dir=dist
```

**Corroborated across two lanes on the same day:** the RC-2 lane, adding
`membership.instrument.enrol`, had the manifest array and the count map from §2.138's greps and
did NOT have the README table, and said it would not have found it. Two independent lanes, the
same blind spot, one permission each.

> **AMENDED THE SAME DAY, AND THE AMENDMENT IS LARGER THAN THE ENTRY. THREE WAS WRONG; TEN IS THE
> MEASURED NUMBER, AND GREP FINDS NONE OF THE LAST SEVEN.**
>
> This entry shipped in `10b37d0` claiming three censuses. **That commit left `main` RED**: the
> RC-2 lane ran the suite and found SIX more stale pins, and fixing those surfaced a seventh. The
> full count for ONE permission is **ten**:
>
> | | census | how it was found |
> |---|---|---|
> | 1 | the manifest array | writing it |
> | 2 | per-module count map (`opd: 15 → 16`) | LIST grep |
> | 3 | `README.md` permission table row | SIBLING grep, followed into what the test PARSES |
> | 4 | `installedRegistry().allPermissions()` total (147) | **the run** |
> | 5 | the reachability census's declared total | **the run** |
> | 6 | its held total (132 → 133) | **the run** |
> | 7 | `opdTable.rowCount` / `cells.size` / `tablePairs` (15/15/31) | **the run** |
> | 8 | `modelPairs()` grants total (274) | **the run** |
> | 9 | `modelPermissions()` distinct total (126) | **the run** |
> | 10 | the PER-ROLE grant map (`doctor: 19`, `vitals_desk: 5`) | **the run**, on the second pass |
>
> **Seven of the ten are in `test/seed-roles.test.ts` — a file this lane had ALREADY EDITED, twice,
> to move census 2.** Editing a census file does not make its other censuses visible. Number 10 was
> missed even on the pass that was explicitly hunting for stale pins, and was read past while
> changing a number six lines away.
>
> **The distinction that actually predicts findability, and it is not scope:** a census with an
> IDENTIFIER (`ALL_MANIFESTS`, `opd.counter.flow.manage`, a table keyed by a role column) can be
> grepped. **A census that is a BARE INTEGER cannot be — there is no token to search for.** Numbers
> 4–10 are all bare integers. Widening the grep past `--include=*.ts`, which this entry originally
> prescribed, finds number 3 and none of the rest.
>
> **So the rule is not a better grep. It is: GREP TELLS YOU WHERE TO EDIT; ONLY THE RUN TELLS YOU
> WHAT YOU BROKE.** A permission/manifest/role change owes the suite that asserts its censuses
> BEFORE the commit, not after — which is §9.9 rule 6's full-verify-at-the-boundary obligation, and
> this specimen exists because this lane deferred exactly that and landed on named-but-unpaid
> evidence. **Naming a debt in a commit message does not make the tree green.**
>
> And the test NAMES carry the numbers too (*"the reachability census closes: 147 declared = 132
> held + 15"*, *"two hundred and seventy-four grants"*): move the pin and leave the name, and the
> suite passes while describing something false.
>
> **AMENDED AGAIN, SAME DAY: TWELVE, AND THE LAST TWO CHANGE WHAT THE FAILURE MODE IS.** The RC-2
> lane, landing the same kind of change an hour later, found two more that neither lane had counted:
>
> | | census | shape |
> |---|---|---|
> | 11 | `first.roles.map(r => r.granted.length)` | a bare-integer ARRAY |
> | 12 | `second.roles.map(r => r.already.length)` (the idempotence leg) | the same array, again |
>
> Every permission moves BOTH, and nothing names either.
>
> **And the failure mode is not "you miss it" — it is "you fix the WRONG ONE and believe you are
> done".** `membership_admin` is index 14 in that array, not 12; `staff_auditor` also holds two
> grants, so the first `2` is not the one that moves. The lane changed the wrong entry, the suite
> stayed red, and the diff read `+2 / -2` **with no indication which role it meant.**
>
> So the sharper statement of this entry's rule: a bare-integer census gives you **no token to grep
> AND no name to check your edit against.** The corollary that costs an extra cycle every time it is
> missed: **when a bare-integer census fails, DERIVE THE INDEX FROM THE MODEL — never pattern-match
> the value**, because the value is shared with entries that did not move.
>
> **One more instance of "seven of ten live in a file you already edited", from the other side:**
> two entries of these arrays, and `fromReadme`'s base 126 → 128, were the VD-1 lane's own
> README-table deltas, which `a50e68a` moved at the `opdTable` pins and not in these DERIVED places.
> The RC-2 lane corrected them and said so in its commit rather than absorbing them — a non-table
> permission cannot move a README-table count, so there was no honest way to present them as its
> own. **Attribution survives even when the fix is trivial; that is what keeps the record readable
> a year later.**

> **And the error message, recorded because it costs an hour cold:** that parser fails with *"could
> not identify all four permission tables by their first role column … this parser is stale"*. That
> is the parser saying it could not find a TABLE — not that your permission is wrong. A permission
> whose holders span two tables needs its row in the one the parser identifies.

## 3. Plan-authoring defects

Fix these when writing the next plan, not when executing it.

**3.1 — A task's Files list must name every file its Steps touch.** *(Plan 02, T7)*
Task 7's Files list omitted `apps/core/package.json`, but its Step 3 required adding the `@types/express` devDependency. A coder following the Files list breaks the build; a coder following Step 3 looks like scope creep to the gate. Either way the ladder burns an attempt. When compiling, reconcile the two and state the reconciliation in the brief.

**3.2 — A frozen file orphans the steps that needed it.** *(Plan 02, T6 → T8)*
A gate correction froze `apps/core/package.json` during T6, so the `"agent:create"` script the plan's T6 Step 3 required never landed — leaving `scripts/create-agent.ts` unrunnable and T12's README documenting a command that did not exist. Nobody noticed until the next pipeline was compiled. **When a gate correction freezes a file, the step it blocked becomes a carried-forward item: name it explicitly in the next task that owns that file, with the rationale, so the gate reads it as in-scope.**

**3.3 — Conditional instructions stall agents.** *(carried from Plan 02's stress test, held)*
"Add X if the compiler asks for it" produces either a stall or an unjustifiable diff. State dependencies unconditionally.

**3.5 — Order the failing-test step before implementation for e2e tasks too, or state that no red run is owed.** *(Plan 02, T7–T12)*
Unit tasks put "write the failing test" first; the e2e tasks put implementation first, so the e2e is green on its first honest run. That mismatch is what made §2.3's manufactured red states seem necessary. Either put the e2e step first, or write in the task that a red run is not required and say what evidence replaces it.

**3.6 — A task adding a boot-time DB call must audit every existing e2e suite's database wiring in the same task.** *(Plan 02, T8)*
Adding `syncPermissions` to `onModuleInit` broke `health.e2e.test.ts`, which pointed the app at the base `hmis_test` — a database nothing ever migrates, since only per-worker `hmis_test_<N>` databases are migrated. The fix belongs in the task that adds the boot call, and its brief's file list must say so. Never fix this by making the boot call swallow errors: a loud failure on missing schema is the point.

**3.7 — In this repo, relative imports in tests must be static.** *(Plan 02, T8)*
A dynamic `await import("../src/...")` runs fine under jest but fails `pnpm typecheck` with TS2835 under `nodenext`, and adding the suggested `.js` extension then breaks jest resolution. Write static top-level imports in test files.

**3.8 — Spell out the publish sequence in the brief's FINISH block, in order.** *(Plan 03, T5 — no token cost, but it produced a confusing failure mid-run)*
The compiled brief ended with *"commit with the plan's exact message, then `git pull --rebase origin main && git push origin main`"*. T5's coder ran the chain **before** committing and got `cannot pull with rebase: You have unstaged changes`. It recovered correctly (it had already pulled cleanly before writing, and origin had not moved, so the post-commit push fast-forwarded), but a brief should not need recovering from. Write the FINISH block as three numbered steps — commit, then `git pull --rebase origin main`, then `git push origin main` — never as a single chained line appended to a sentence about committing.

**3.9 — A verify-by-execution flag must name the test that proves it, in the task that owns that test.** *(Plan 03, T4 — the plan's only real authoring defect, caught by the gate)*
Plan 03's flag ④ (jsonb round-trip fidelity) said it was *"proven by T2's `toEqual(DEF_JSON)` and every `parseDefinition` call in T6–T8"* — so T4, the task that actually writes definitions to `jsonb`, carried no round-trip assertion at all, and its coder reasonably reported the flag as already satisfied elsewhere. The gate caught it and the retry added one line. **A flag discharged in a different task than the one whose code it protects is a flag nobody owns.** Name the owning task and the specific assertion.

**3.10 — A test fixture built by spreading another fixture must be re-validated against the validator.** *(Plan 03, T10 — caught only by running the e2e)*
The plan's full-lifecycle e2e built its second definition version as `DEF_V2 = { ...DEF_V1, states: [received, done], … }`. The spread carried `initialState: "open"` while the new `states` array declared only `received` and `done`, so the plan's own `defineWorkflow` correctly rejected the fixture and the migrate-to-v2 leg 400'd. The engine was right and the fixture was wrong. **A fixture that a validator in the same plan will reject is a plan defect that only execution can find** — when a plan writes a derived fixture, hand-check it against that plan's own validation rules, and list derived fixtures among the verify-by-execution flags.

**3.11 — Never assert on `JSON.stringify(...)` of a response body.** *(Plan 03, T9 — an assertion that could never pass)*
The plan's definition e2e asserted `expect(JSON.stringify(res.body.message)).toContain('initialState "nowhere" is not a declared state')`. `JSON.stringify` escapes the inner quotes, so the needle can never appear in the haystack — the test was unsatisfiable regardless of implementation, and the controller it was testing was correct. Assert against the parsed structure (jest's `toContain` does array containment on `res.body.message` directly). **A plan's test code deserves the same verify-by-execution scepticism as its implementation code**; this one typechecked and read plausibly.

**3.12 — A new table's TRUNCATE must be named in the SAME statement as the group it FKs into.** *(Plan 04, T2 — caught by execution on the first honest run)*
The plan appended `truncate table approvals, approval_types` as a **new statement placed before** the existing workflow-group statement, on the reasonable-sounding theory that emptying children first satisfies FK order. Postgres disagrees: `TRUNCATE` requires every table carrying an incoming FK to a target to be named in the **same command**, and it checks the constraint's *existence*, not row counts. `approvals.instance_id` references `workflow_instances.id`, so truncating the workflow group without naming `approvals` fails with *cannot truncate a table referenced in a foreign key constraint* — all three schema tests died at setup, before any assertion ran. The fix is one extra table name on the pre-existing statement (idempotent — the table is already empty by then). **When a plan adds a table that FKs into an existing truncate group, that group's statement must gain the new table's name; a separate earlier statement does not satisfy Postgres.** Note the second-order damage: the task's acceptance criterion said the diff would be "exactly one added line", written from the same wrong model, so the correct fix had to overrule a criterion. A criterion that encodes a *shape* the plan predicts, rather than the *property* that matters, turns a plan defect into an apparent violation.

**3.13 — A plan that asserts on the error code of a RACE LOSER must enumerate every code the shipped arbiter can produce.** *(Plan 04, T5 — the plan's most instructive defect)*
The single-winner test asserted the loser's code ∈ {`stale_transition`, `not_pending`}. Against Plan 03's **shipped** `transition`, which opens with a non-locking SELECT and throws `instance_not_active` when the instance is already `completed` (`instances.ts:82`), all three are legal and which one occurs is pure timing. The coder proved it rather than assuming: the unmodified assertion passed **1 of 5** consecutive runs. **This is §3.11 one level deeper — not an assertion that can never pass, but one that passes *sometimes*, which is worse, because a single green run certifies it.** Two further points earn their place. First, the fix *strengthened* the test: on the `instance_not_active` path the assertion bailed early, so the four downstream assertions (one winner, row status === instance state, instance completed, exactly one decision event) had never once executed — a flaky assertion had been silently skipping the assertions that carried the actual teeth. Second, the coder correctly refused the tempting repair of re-implementing arbitration in the new engine to force a deterministic loser code; arbitration belonged to the shipped engine and stayed there. **When writing a concurrency assertion, prefer asserting the invariant (exactly one winner, exactly one event) over the loser's diagnosis; if you must assert the code, trace every interleaving of the real arbiter first.**

**3.14 — AN ASSERTION WHOSE FIXTURE CANNOT SEPARATE RIGHT FROM WRONG PROVES NOTHING.** *(Consolidated 2026-08-19 from §3.14, §3.14b, §3.14c and §3.33 — the most recurrent defect class in this ledger, four specimens across three pipelines)*
The family question is always the same: **what else, besides the mechanism under test, could produce the observable this assertion looks for?** Four specimens, each a different answer, all worth keeping:

- **The fixture makes both sides identical.** *(Plan 05, T6)* The criterion required proving `guardian.authority_changed` carries the **effective** authority rather than the **stored** flags — asserted on a **10-year-old**, where the two are identical by definition. It passed against the correct implementation and would have passed against one that echoed the stored row. Fix: a `dobAged(20)` fixture whose stored flags are `dsr: true, messages: true` but whose payload is all-false — a result only a computed authority can produce.
- **The mechanism is UNREACHABLE, so something upstream produces the observable.** *(Plan 05, T10 leg 4)* The e2e claimed to prove the `requester_approver` SoD pair over HTTP by having the filing clerk approve and asserting **403** — but the same plan gives that clerk *zero* approvals permissions by design, so the route's `@RequirePermission` guard turned them away **before `assertNotSodPair` ever ran**. Deleting the entire SoD subsystem would not have failed it. Fix: a leg-scoped grant so the refusal originates from the SoD check, asserted on an SoD-**specific** signal (the message naming `requester_approver`, exactly one `sod.violation_blocked` event) — never the bare status, which two mechanisms produce identically. **A §3.14-aware stress pass caught two fixture defects the same day and missed this one, because it is a design contradiction rather than a visible fixture flaw.**
- **A second, independent mechanism in the FRAMEWORK produces it.** *(Plan 05, T13)* "Enter advances focus to the next field instead of submitting" was asserted by pressing Enter in field A and checking focus landed on field B — with **field B left empty**. So Enter triggered implicit form submission, zod rejected the empty field, and react-hook-form's default `shouldFocusError: true` focused field B for reasons entirely unrelated to the feature. Deleting the feature would not have failed the test. Focus management, default form behaviour and error handling are all silent second causes.
- **The TEST HARNESS is the second mechanism.** *(Plan 07, T14 — the pipeline's most valuable gate rejection)* `apps/web`'s `stubFetch` always answers **200** and cannot produce a 201, while twenty of the OPD module's twenty-one POST routes return Nest's default **201**. A screen branching on `res.status === 200` passes every test in this harness and **fails in production**, and no shipped test can see it. The gate refused the coder's explanatory comment on the ground that *a comment is a prediction, not evidence*, ran the spec with a genuine 201 itself, and required the stub changed. **When a stub normalises something the real server varies, every assertion downstream of it is blind to that variation** — enumerate what your doubles flatten and prove the flattened axis separately.
- **The ABSENCE case, where there is no visible thing to check.** *(Plan 07, T16 done right and T14 done wrong)* T16's public display board must show no patient identifiers, and its fixture deliberately carries `patientName: "Asha Devi"` and a UHID — fields the real `boardSnapshot` never emits — so the assertion could genuinely have failed; a gate mutant that rendered `item.patientName` **DIED**, proving it. T14's `expect(queryByText(/danger/i)).toBeNull()` was asserted against a fixture whose `dangerFlagged` inherited `false` from its factory while a comment claimed otherwise. It passed against a row that never had the thing.

**The rules.** When an assertion distinguishes A from B, hand-check that the fixture actually separates them, pick the input where a wrong implementation gives a different answer, and say so in the test name. When an assertion checks a status code, name which mechanism produced it and assert something only that mechanism emits. **For every "assert X is absent", name the fixture field that would make X appear and confirm the fixture carries it** — if nothing could ever produce X, the assertion is decoration. And note what has actually caught these: not review — an executed mutant, every time.

**3.21 — A TEST THAT CLAIMS TO OBSERVE A LOCK USUALLY DOES NOT: FOUR WAYS IT FAILS.** *(Consolidated 2026-08-19 from §3.21, §3.25, §3.28 and §3.39 — one family, four escalating specimens, every one found by building the wrong implementation rather than by reading)*
This is §3.14's question aimed at concurrency: **what else, besides the lock under test, could produce the wait or the outcome I am observing?** Four answers, each found the hard way:

- **The lock predicate matches NO ROWS — a lock that does not lock.** *(Plan 06, T4)* The plan specified `SELECT id FROM tariff_versions WHERE status = 'activated' FOR UPDATE` as the activation serializer. That predicate matches **zero rows whenever nothing has yet been activated** — precisely the state the race test constructs. It acquired nothing and serialized nothing; both racers reached the monotonicity re-check and the loser threw `effective_from_not_monotone` before ever reaching the conditional UPDATE that was supposed to arbitrate. Worse, the plan's own §3.13-aware self-review claimed the loser's code had been **"traced"** to a single value — a trace run against a serializer that does not serialize. **A stated trace is load-bearing evidence; a wrong one actively suppresses the scrutiny that would have caught the bug.** Fix: a target-row lock (`WHERE id = :versionId`) plus excluding the version being activated from the comparison. Caught only by running the test **15 times in isolation** (failure on run 4).
- **A STRUCTURAL BACKSTOP enforces the invariant the test observes, so the mechanism is never tested.** *(Plan 06.1 audit, finding A2)* T1 shipped two defences for one invariant: an ordered set lock (the mechanism) and a partial unique index (the backstop). The race test asserts the observable — one winner, one activated row, one event. **Mutants that revert the serializer to its broken shape, or delete it outright, pass 10/10 isolated**, because the index enforces the invariant either way. Three verification layers — coder 20 runs, gate 20 more, main session 40 — were all measuring something that cannot tell the two implementations apart. **When a task ships a mechanism AND a backstop for the same invariant, the mechanism needs its own test with the backstop mutated away.**
- **The OBSERVATION POINT sits inside the target's own write path.** *(Plan 06.2, T2 — the first in this file caught by an executed mutant rather than an audit)* The replacement test had an external client hold the serializer's own statement, then asserted the activation was still pending after 400 ms. But that predicate covers **the target version's own row**, and the single-winner conditional UPDATE must take an exclusive lock on that row whether or not the serializer exists. The serializer-less mutant blocks too. Measured: **Mutant A SURVIVED 5/5**, gate-reproduced 3/3, against an Assertion Book row that had called it "deterministic by design". Fix: hold a **different** row — one inside the serializer's set predicate and outside everything the target's own activation reads or writes. **Mutant A then DIED 5/5.**
- **The observer's LOCK MODE is stronger than the mechanism under test.** *(Plan 08, T6 — a gate mutant nobody asked for)* T6's test does hold a row outside the target's write path, correctly. The gate then rebuilt the M-A1 mutant (invoice `FOR UPDATE` dropped) with the outside holder taking `select … for update` instead of the shipped `for no key update` — and the observation leg **stopped discriminating**: the serializer-less mutant blocks anyway, because the stronger mode conflicts with writes the mutant still performs. **The same test, the same row, the same point in the write path, discriminates or does not depending on the lock MODE the observer takes.**

**The rule.** When a test asserts that something BLOCKS: name the specific lock you believe is blocking, **name its mode**, confirm the predicate matches at least one row in the test's own starting state, confirm the observation point is outside the target's own write path, and confirm no backstop enforces the same invariant. Then prove the whole pairing by mutating the mechanism away — never by reasoning about it. Four times now, reasoning said the test was sound and the mutant said otherwise.

**3.15 — A plan must not carry a lint directive for a rule the repo does not enable.** *(Plan 05, T4 — zero tokens, but it degraded the repo's lint output)*
The plan's perf test included `// eslint-disable-next-line no-console` above a timing log. This repo's root `eslint.config.mjs` uses only `tseslint.configs.recommended`, which never enables `no-console` (`scripts/*.ts` call `console.log` unannotated). ESLint 9 reports an **unused disable directive** as a warning, so `pnpm lint` went from pristine to `✖ 1 problem (0 errors, 1 warning)` — exit still 0, so `verify` stays green and nothing fails, which is precisely why it will rot there unnoticed. The coder correctly typed the plan verbatim, disclosed the effect, and declined to remove a line the brief told it to reproduce. **When a plan writes a lint suppression, check the repo's actual lint config first; a suppression for an unconfigured rule is itself a lint finding.**

**3.16 — A generated-artifact step must name the generator's FULL output set, not just the headline file.** *(Plan 05, T1 — §3.1 recurring, third occurrence)*
The Files list named `apps/core/drizzle/0006_*.sql`, but `pnpm db:generate` also creates `drizzle/meta/0006_snapshot.json` and rewrites `drizzle/meta/_journal.json`. The coder reasoned correctly (the same pattern is already committed for migrations 0000–0005) and disclosed the interpretation, and the gate ratified it — but a stricter gate could equally have read two unlisted files as scope creep. §3.1 has now been hit by a devDependency (Plan 02 T7), a DI token (Plan 02 T8), and a code generator's metadata. **When a step runs a generator, list every file the generator touches.**

**3.17 — A third-party API called with a placeholder argument to reach a later parameter can bind the WRONG OVERLOAD and silently discard the option.** *(Plan 05, T9 — caught by the coder, and the single most dangerous defect either pipeline produced)*
The plan's e2e bootstrap read `moduleRef.createNestApplication<NestExpressApplication>(undefined, { bodyParser: false })`. `@nestjs/testing` declares two overloads — `(httpAdapter, options?)` and `(options?)` — and its implementation dispatches on `this.isHttpServer(serverOrOptions)`. A first argument that is not an HTTP adapter is therefore **treated as the options bag**, so `{ bodyParser: false }` sitting in the second position was silently ignored, `appOptions` fell back to `{}`, and Nest installed Express's default **100 kB** json parser ahead of `configureApp`'s 1 MB one. The ~300 kB photo body would have failed. The type error (`undefined` is not assignable to the adapter parameter) was the *harmless* half; the runtime mis-binding was the real defect, and no amount of reading would have surfaced it without running the 300 kB round-trip. **This is exactly what a verify-by-execution flag is for — flag ⑩ named this construct and it fired.** When a plan passes `undefined`/`null` to skip a parameter, check the callee's overload dispatch: positional placeholders are not neutral in a function that discriminates on argument shape.

**3.18 — When a plan states a value in prose and asserts a DIFFERENT one in its own test block, the test block is what runs.** *(Plan 05, T9 — zero cost, resolved correctly by the coder)*
The plan's Interfaces block said `POST /patients/qr/verify` returns **HTTP 200** even on `ok: false` (a failed scan is a domain answer, not a transport error), and the compiled acceptance criterion repeated it — but the plan's own e2e code block asserted `.expect(201)` on all three calls to that route, which is merely Nest's POST default. Two sources said 200, one said 201, and only one of them executes. The coder resolved it toward the stated intent (`@HttpCode(200)` on the handler, three assertions changed) and disclosed it. **Reconcile a plan's prose against its own test blocks before shipping it; where they disagree, the prose is the intent and the assertion is the behaviour, and only one of them is enforced.**

**3.19 — A type error at a form boundary is often a live logic bug wearing a compiler error's clothes.** *(Plan 05, T14 — two symptoms, one cause, and the more serious symptom was invisible)*
The plan's `useForm<RegisterFormValues>({ resolver: zodResolver(registerSchema) })` failed `tsc` with TS2719 (`Type 'unknown' is not assignable to 'number | undefined'`) because `z.preprocess` makes the schema's **input** type `unknown` at `ageYears` while its output is `number | undefined`. The tempting fix is to widen the generic and move on. The coder investigated the runtime instead and found the real defect: react-hook-form's `register` never coerces, so `watch("ageYears")` returns the **string** `"10"`, and the plan's guard `typeof v.ageYears === "number"` is therefore false — **the D-31 minor-needs-guardian section would never have appeared**, and a minor could have been registered without the guardian consent the rule exists to enforce. The compiler error and the safety bug were the same mistake seen twice. **When a form's types don't line up, find out what the field actually holds at runtime before satisfying the compiler.**

**3.20 — Never assert exhaustiveness about a host environment's gaps you have not executed.** *(Plan 05, T14 — the stress pass's own error, corrected by the coder)*
The pre-pipeline stress pass caught that jsdom implements no canvas and wrote into T14's brief that the photo test "must stub **THREE** things, not two", enumerating `createImageBitmap`, `toBlob` and `getContext` as if the list were complete. It was not: jsdom implements no Blob URLs either, so once the three canvas stubs let the downscale succeed, the capture died on `URL.createObjectURL is not a function` before `onCapture` ever fired. A fourth stub was needed — and because `createObjectURL`/`revokeObjectURL` are *absent properties* rather than prototype methods, `vi.spyOn` cannot take them; they must be assigned and restored by hand. **Enumerate the host gaps you know, then say the list may be incomplete.** A brief that claims exhaustiveness about an environment nobody ran turns a helpful warning into a false guarantee.

**3.22 — A concurrency fail-first RUN BUDGET is a prediction about a race window, and predictions about race windows are what this ledger keeps catching.** *(Plan 06.1, T1 — 0 tokens, absorbed inside the original attempt)*
The plan prescribed **15** isolated pre-fix runs of the cross-version race and stated a red was expected. **15/15 passed.** The coder neither declared the evidence unobtainable nor manufactured a red: it ran 30 more and got one genuine failure — **1 in 45, ~2.2%**. The mechanism it traced: under the shipped serializer both sessions *can* commit, but only if the second session's monotonicity SELECT lands before the first commits, and in the jest harness the second activation systematically lags because the pg Pool must open a fresh physical connection for the second concurrent transaction while the first reuses an idle one. So the loser usually observes the winner already committed and refuses *legitimately* — accidentally passing. The stress test reproduced C1 on the first try only because it drove raw `pg` sessions and controlled the interleaving directly. **A prescribed run count for a race is a guess about a window nobody measured (§3.20's shape applied to time instead of environment). Prescribe a floor, require the report to state the OBSERVED rate, and authorize the coder to keep running rather than report the evidence as unobtainable.** Note the asymmetry that makes this dangerous: reproducing a race in a harness is *harder* than in the wild, so an unreproducible red is weak evidence the defect is absent — and 20/20 clean post-fix runs are correspondingly weak evidence the fix works. The partial unique index, not the run count, is what makes T1's fix structurally sound.

**3.23 — A fail-first step whose test file cannot COMPILE against shipped code produces a red that proves nothing.** *(Plan 06.1, T3 — 0 tokens, resolved correctly and disclosed)*
The plan's T3 Step 1 added both new tests in a single block, but the second imports `listRegulatedPrices`, which Step 3 creates. Deploying that exact file against pre-fix `services.ts` therefore fails the whole suite to typecheck (TS2305) on every run — a true red that says nothing whatever about the heap-order nondeterminism the step exists to demonstrate. The coder staged a reduced variant of **its own in-progress test file** (first test only), captured five genuine semantic reds against unmodified shipped code, then restored the full Step-1 file before implementing. Nothing shipped was mutated and the gate ratified it. **When a task's tests and its implementation are interdependent, split the fail-first step: the test that demonstrates the defect must be deployable, and must compile, against unmodified shipped code on its own.** Related and worth pairing with it: the same task's honesty note predicted the pre-fix code would *usually pass* the same-date test (fresh-table heap order ≈ insertion order); the observed behaviour was the opposite — because the resolver reduces to the **first** row per service, insertion order means the **stale** row wins and it failed 5/5. **An honesty note about nondeterminism is itself an unexecuted prediction; write it as a possibility, not a forecast.**

**3.24 — A hand-performed discrimination audit is a PREDICTION. Only an executed mutant is evidence — and predictions have been wrong in BOTH directions in the same plan.** *(Plan 06.1 post-ship audit — the deepest finding in this file to date)*
Plan 06.1 existed because Plan 06 ran only the derivation audit; its organizing rule added a second, the **discrimination** audit, and its 27-row Assertion Book named the killing mutant for every assertion. Two gates and a main session all checked that Book by hand and it read as sound. Executed, it is wrong twice, in opposite directions: **A6** is declared unreliable (*"fresh-table heap order ≈ insertion order, so the wrong impl CAN pass"*) and in fact kills its mutant **10/10**; **A7** is declared the load-bearing kill that compensates for A6 and in fact kills **0/10**, unit and over HTTP — its stated prediction that a `desc(effectiveFrom)`-only sort returns `[r2, r3]` is simply false, Postgres returns `[r3, r2, r1]`. Two more Book rows (A8/A23) pin the *recorded amount* but not the *comparison*, so reverting only the cap operand survives the entire suite including golden. **The discrimination audit was the fix for Plan 06's blind spot, and it inherited the blind spot: a claim about what a wrong implementation would do, made without running one.** Tripwire 21 (numbered 20 when first written; renumbered 2026-08-15 when the §2.10 interference rule was promoted to tripwire 20) now forbids the unexecuted claim. When a plan's Assertion Book names a mutant, the task that ships that assertion must BUILD it and report DIED/SURVIVED — mutation evidence is cheap (35 mutants cost one audit agent ~200k) and it is the only thing that distinguishes a test from a decoration.

**3.26 — "The ids are sortable" is not "the ids are insertion-ordered."** *(Plan 06.1 post-ship audit, finding A1 — a CRITICAL that shipped through a plan, two gates and an independent verification)*
T3 fixed a nondeterministic DPCO ceiling with `.orderBy(desc(effectiveFrom), desc(id))` and the comment *"ids are ULIDs, so descending id = last-inserted-wins."* `newId()` is `ulid()`, **not** `monotonicFactory()`: a ULID is a millisecond timestamp plus **80 bits of fresh randomness**, so two minted in the same millisecond sort by coin flip. `id DESC` is a perfectly good total order — it is just not the *insertion* order, which was the property required. Reproduced end-to-end through the shipped write path: 6 of 200 same-date corrections resolved to the **superseded** ceiling. It is safe today only because a one-row-per-HTTP-request path takes longer than a millisecond — an accident of latency, not a property of the design — and any bulk import breaks it. **Before ordering by an id, read the id generator.** And note the fix is not a one-liner: `monotonicFactory()` is monotonic *per process*, which will not survive this architecture's planned multi-process split; a database-side monotonic column (`events.seq` already does this) is the shape that does.

**3.27 — A guard must precede every write it authorizes, including the "belt" writes.** *(Plan 06.1 post-ship audit, finding B1)*
`activateVersion` performs a defensive UPDATE that marks a version `rejected` when its approval was rejected — and that write sits **above** both the approval-subject guard and the SoD guard. So a mis-bound approval (exactly the scenario the subject guard was added for) drives an unrelated healthy version to a terminal state with no un-reject path, and the drafter — the actor SoD exists to exclude from this function — can trigger it. The guard is correct; its position is not. **When adding an authorization check to an existing function, enumerate every state-changing statement in that function and confirm the check precedes all of them** — and write the test for the *rejecting* path too, not only the happy one: the shipped test covered only the granted case, which is why three reviews missed it.

**3.29 — An acceptance CRITERION can claim a proof its test cannot deliver, even when the code is right.** *(Plan 07, T6 — 0 tokens, found by a gate-built mutant nobody asked for)*
T6's criterion read: *"Test 5 shows `role_denied` with ZERO vitals rows written, **proving the registered→waiting move precedes the insert**."* The T6 gate built an unrequested **Mutant V4** — the vitals insert moved BEFORE the state move — and it **SURVIVED**. The reason is structural: the whole `recordVitals` body runs inside one `withTx`, so a `role_denied` throw rolls back *either* ordering. The zero-rows observation comes from the transaction, not from the sequence. The shipped ordering is correct (`vitals.ts:61` precedes `:67`) and is **not externally observable at all** — no test can prove it, so the criterion demanded evidence that does not exist. The gate was right to pass the task and right to invent no fix; there is nothing to fix.
**This is §3.14c applied one level up — to a *criterion* rather than to a test.** §3.14/§3.14b/§3.14c all ask "what else in the stack could produce this observable?" of an assertion someone wrote. Here the same question had to be asked of a sentence in the acceptance criteria, which no gate had previously been asked to audit: the criterion asserted a causal claim ("proving X precedes Y") that the transaction boundary makes unobservable. **Before writing "proving X" into a criterion, name what else in the stack produces the same observable.** If the answer is "the transaction", "the framework" or "the database", the criterion is describing a design property, not a testable one — state it as a code-reading obligation for the gate, never as something a test result will show. Note what caught it: not a review of the criterion, but a mutant built against a claim nobody had challenged.

**3.30 — A VERIFY-BY-EXECUTION FLAG can claim a proof that no assertion in the plan delivers.** *(Plan 07, T7 — 0 tokens, found by the gate rebuilding a mutant it was not asked to trust)*
Flag ⑪ read: *"drizzle `.for("update")` on a select compiles and serializes — T5 K19 / T7 K30 measurements."* The **compiles** half is discharged by the code building. The **serializes** half is not discharged by anything. T7's gate rebuilt Mutant P1 (the encounter-row `FOR UPDATE` dropped) and ran the version race isolated **ten times: SURVIVED 10/10**, independently reproducing the coder's 0/20. A test that passes identically with and without the lock cannot show the lock serializes anything — prescriptions test 4 pins the *outcome* (versions 1 and 2, one active row, two events), which the **unique index on `(encounter_id, version)`** already guarantees. The only evidence for "serializes" was the coder's two-transaction interleaving probe, which was scratch and was deleted, so it is now unreproducible.
**This is §3.29 one level out — and a worse place for the error to hide.** §3.29 was an acceptance *criterion* claiming an undeliverable proof; a criterion is read by one gate on one task. A **flag** is a plan-level promise that the whole plan's reviewers treat as discharged once the owning task passes, and it names its discharging assertion, which makes it look audited. Two rules: **a flag that bundles two claims ("compiles AND serializes") must name a separate discharging assertion for each**, and **a flag whose evidence is a throwaway probe is not discharged** — if the property matters, the probe is committed or re-runnable, otherwise the flag is marked declared-unproven with the structural defence named. Here the honest statement is that correctness rests on the unique index, not on the lock.

**3.31 — A fixture derived from the WALL CLOCK is a dated bomb, and it detonates on a calendar boundary rather than on a change.** *(Plan 07, T6's suite — predicted by T7's gate ~4.5 h in advance, detonated exactly as predicted)*
`registerPatient` derives `dob` from `new Date()` whenever `ageYears` is supplied (`registration.ts:68-71`), so a test that registers by `ageYears` and then asserts a **hard age against a fixed pinned instant** is only correct on the days when the two happen to agree. `vitals.test.ts` asserted `ageYearsAtRecord === 30` and `=== 3` against the pinned `2026-08-17T04:00Z`; at 00:00 UTC on 2026-08-18 the derived dob shifted a day and both became 29 and 2. Measured after the fact: **2 failed, 3 passed** — a deterministic red on `main` caused by nobody's change.
**Three things make this worth its own entry.** It was *predicted*: T7's gate computed the detonation time and wrote it into its findings, and the T7 coder had already immunised its own suite with an explicit DOB — the warning existed and still nothing acted on it, which is §2.16 again. It is **invisible to every normal signal**: the pipeline was green, CI was green, and the defect was scheduled. And the fix direction matters — the tempting repair, re-pinning the assertion to `new Date()`, trades a deterministic failure for a nondeterministic one and is strictly worse. **The rule: a fixture and the instant it is asserted against must come from the same source of truth. Derive the fixture from a constant (an explicit DOB), never from the clock the assertion is not using.** The durable fix is upstream — `registerPatient` should take `now: Date = new Date()` like every other service in this codebase, which is this plan's own Global Constraint — and it remains open. Note the blast radius is wider than the one suite: `test/helpers/opd.ts`'s `mkPatient` still defaults to `ageYears: 30`, so **the next hard-age assertion added anywhere re-arms it.**

**3.34 — A CONVENTION stated in a brief is not a tested property, and six screens can honour one while zero tests protect it.** *(Plan 07 pipeline C, T11's gate — found by an unprompted mutant that SURVIVED)*
Every brief in pipeline C carried the binding web convention *"every screen BOTH polls its read model with `refetchInterval: 15_000` AND subscribes to its realtime topics"*. All six screens implement it correctly. T11's gate neutered `POLL_MS` in a copy of the admin screen so no query carried `refetchInterval` at all, ran the shipped spec, and got **5 passed, exit 0**. Deleting the polling fails nothing. The same pipeline produced two more of these: a criterion claiming a 404 "falls back to the adult band" whose fixture ordering made the claim unprovable (T14 `V5`, SURVIVED), and three of four screen-local keyboard shortcuts with zero coverage (T15 `gateX4`, SURVIVED). In all three cases **the code is correct and the criterion was met** — what was false is the belief that any test protects it.
**Two rules.** A convention that matters must be OWNED by one task's assertion, named in that task's criteria, like any other property; repeating it in six briefs creates six implementations and zero tests. And the only way to find this class is to **build the mutant against the convention**, because it is invisible to every other signal: the suite is green, the criterion is met, the code is right, and the reviewer reading the diff sees `refetchInterval: 15_000` sitting there exactly as promised.

**A second specimen, one plan later** *(Plan 08 pipeline C, T16 — found by the discovery reviewer's convention mutant)*. The same convention, the same failure, at a bigger blast radius. Pipeline C's discovery pass built the mutant for all four billing screens (`sed '/refetchInterval: POLL_MS,/d'`) and ran each screen's own shipped spec against it: the counter (T13, which OWNS the assertion) **DIED** — `expected 1 to be greater than 1`; dues (T14) **DIED**; session (T15) **DIED**; and `billing-office.tsx` (T16), the one screen with **three** polled worklists, **SURVIVED 11/11 with all three `refetchInterval` lines deleted.** Its spec has no polling assertion at all, and `README.md` — shipped in the same commit — promises by name that the back office's worklists refresh on the convention. So: code correct, criterion met, suite green, docs asserting it, and deleting the whole thing fails nothing. Note also what the mutant proved in the OTHER direction: T14's and T15's assertions, honestly self-labelled "presence only", do in fact kill removal — they simply cannot attribute the second GET to the interval, which is exactly what their comments claim. **The structural cause is now visible: `POLL_MS = 15_000` is declared ELEVEN times across the app, so a mutant on any one screen tests only that screen and there is no single artefact whose removal fails anything.** Either lift the constant into one module and assert its consumption once, or make the polled-reads assertion a per-screen criterion with its own mutant.

**3.35 — A plan's stated DATABASE RATIONALE is an executable claim and carries §3.4's burden; this one was false and made the plan self-contradictory.** *(Plan 08, T1 — proven by execution, three times, by three different agents)*
Plan 08's Task 1 Step 5 justified its truncate design in prose: *"Postgres only requires FK-parents truncated in the same statement as their children when the PARENT is being truncated; `invoices → patients` needs `invoices` gone before `patients`, which this ordering guarantees."* **That is not how `TRUNCATE` works.** Postgres checks whether an FK constraint POINTS AT the table being truncated — constraint *existence*, never row counts and never statement order. The execution proof is unusually clean: the added billing statement at `db.ts:64-68` ran FIRST and truncated `invoices` successfully, and the very next statement, the shipped patients one at `db.ts:69`, still failed with `cannot truncate a table referenced in a foreign key constraint`, detail `Table "invoices" references "patients"`.
**The consequence is worse than a wrong sentence: it makes two of the plan's own requirements mutually unsatisfiable.** Step 1's schema writes `.references(() => patients.id)` on three billing tables; Step 5 and the acceptance criteria require *exactly ONE ADDED* truncate statement. With the FKs, the only correct fix is to fold all fourteen billing tables into the EXISTING patients statement — a modified statement, not an added one. Without the FKs, one added statement is correct and the criterion holds. The plan cannot have both, and nothing short of running it reveals that.
**This is §3.12 re-learned in the opposite direction, two plans later.** §3.12's entry already records the same Postgres fact ("a separate earlier statement does not satisfy Postgres") from Plan 04 — and Plan 08 nonetheless paraphrased it into its inverse. **Two rules. When a plan explains WHY a DDL ordering works, that explanation is a verify-by-execution flag: list it, or transcribe the documented rule verbatim instead of paraphrasing it. And when a ledger entry states a database fact, later plans should QUOTE the entry rather than restate the fact in their own words** — the paraphrase is where it inverted.

**3.36 — An acceptance criterion can be made UNREACHABLE by a design decision the same task is authorized to make.** *(Plan 08, T1 — the K1 criterion, found by the coder and upheld by two gates)*
Assertion Book row K1 and its compiled criterion demanded a specific observable: *"the apps/core suite fails in `beforeEach` with the Postgres FK-truncate error against the unextended `test/helpers/db.ts`."* Under the design that resolves §3.35 (billing carries no FK into `patients`), the billing group has zero outbound FKs and nothing outside points into it — so omitting the truncate statement produces **no FK error at all**. The criterion is not merely hard to satisfy; it is unreachable for the code that must ship, and the only way to satisfy it literally is to ship the schema that cannot work.
The honest substitute is a genuine semantic red (the billing schema suite's own truncate-proof test failing, plus `23505` duplicate-key failures its siblings inherit from un-truncated rows carried across `beforeEach`) — a different observable proving the same property. **The rule: when a task's brief leaves a design choice open, check every criterion whose OBSERVABLE depends on that choice. Write the criterion against the PROPERTY (the added truncate statement is load-bearing — removing it must break the suite) rather than the SYMPTOM (this particular Postgres error string).** This is §3.29's shape — a criterion claiming a proof its test cannot deliver — but arriving through a legitimate design decision rather than through a transaction boundary, which makes it invisible at authoring time.

**3.37 — An Assertion Book row can name the RIGHT mutant and the WRONG reason, and a coder who trusts the prose ships a non-discriminating test.** *(Plan 08, T1 — row K4, found by the T1 gate re-deriving it by hand)*
K4 predicts mutant M-T1 (`fyOf` computed from the UTC calendar date) is killed because *"Mar 31 23:59 IST lands in the next FY"*. Re-derived: `2026-03-31T18:29:59Z` is IST Mar 31 23:59:59, and its **UTC calendar date is also 2026-03-31**, so the mutant returns `"2025-26"` there — identical to correct, no discrimination whatever. The single discriminating instant is `2026-03-31T18:30:00Z` (IST Apr 1 00:00, UTC still Mar 31): correct `"2026-27"`, mutant `"2025-26"`. The mutant should still die, because the task's test file happens to assert exactly that instant — but it dies for a reason the Book does not state, and a coder who wrote its fixture from the Book's wording instead of from the derivation would have shipped an assertion with no teeth and reported a DIED it did not earn.
**This is §3.24 with the failure moved one step earlier.** §3.24 caught Books whose *predicted verdict* was wrong; here the verdict is right and the *stated mechanism* is wrong, which is harder to see because the executed result confirms the row. **When a Book row names a boundary, the row must carry the exact discriminating INPUT, not a prose description of the boundary** — "Mar 31 23:59 IST" and "the instant IST crosses into Apr 1 while UTC is still Mar 31" sound like the same sentence and are not the same test.

**3.38 — Removing an FK for a truncate-group reason silently removes REFERENTIAL INTEGRITY for every later consumer, and the task that removes it cannot test the consequence.** *(Plan 08, T1 — recorded by the T1 gate as a dormant defect, per §2.16's arming rule)*
The design that resolves §3.35 makes `invoices.patient_id`, `receipts.patient_id` and `refund_vouchers.patient_id` plain `text` with no FK. Nothing at the database layer then prevents a billing document referencing a patient id that was merged away or never existed; the mitigation becomes entirely application-level (merge-chain resolution through the patients module's public reader). **T1 cannot test any of it** — the first consumers that read those ids back are the dues worklist and the day book, tasks away. This is §2.16's "shipped dormant, armed by a later task" with the arming distance measured in pipelines rather than tasks. **When a schema decision trades a database guarantee for an application-level one, name the consuming tasks in the decision itself and book the assertion there** — a guarantee moved from the engine to the code is a guarantee that now needs a test, and the task that moved it is never the task that can write one.

**3.40 — A plan that promises an HTTP STATUS must name the file that DECIDES that status in some task's Files list.** *(Plan 08, D8 — three agents behaved correctly and the defect shipped anyway)*
D8 states the consult gate throws `OpdError("consult_gate_refused")` **(409)**. T10 added the code to `OpdErrorCode`, which its Files list named — but the status is decided somewhere else entirely: the `OPD_CONFLICT_CODES` set in `opd-masters.controller.ts`, consulted by `opdStatus`, which **no task's Files list names and which the frozen list freezes byte-for-byte**. So the gate answered 400 — "your request was malformed" — for what is a state conflict, and unlike every sibling OPD refusal. Follow the chain of correct behaviour: T10 shipped a promise it had no file to keep; T11 met a criterion demanding 409, observed 400, correctly refused to edit a frozen file, asserted the real behaviour and reported it as a plan defect; T11's mechanical check correctly failed the task on the criterion as worded **and correctly identified that no retry could satisfy its own corrections**. The ladder was then deliberately held rather than advanced, because a rung whose only outcomes are "fail again" or "violate a frozen path" is not worth spending. Fixed in one line under an owner-ratified frozen-path exception (`d3074fa`). **When a plan states a status code, grep for the code→status mapping and put THAT file in the Files list of the task that adds the code.**

**3.41 — A test helper that DROPS an optional `now` argument turns a correctly-pinned suite into a dated bomb.** *(Plan 08, T10's `daily-close.test.ts` — §3.31 recurring, one level out, and it detonated the next morning)*
`issuePaidInvoice`/`issuePaidInvoiceByTender` in `test/helpers/billing.ts` called `issueInvoice` with three arguments, so its optional `now` defaulted to `new Date()` and the suite's pinned `DAY` was silently discarded. The suite was green on the day it was authored and `2 failed / 6 passed` the next morning; T10's opus gate passed it in between. This is §3.31 one level out: there the *fixture* derived from the wall clock; here the fixture pinned the clock correctly and **the helper threw the pin away**. **A suite that pins `now` must be verified to thread it all the way down to the writer — grep the whole helper chain, never trust the top of it — and any date-sensitive suite is worth one run against a faked tomorrow before a gate sees it.**

**It also detonates in CI, on commits that change no code at all** *(Plan 08 pipeline C, 2026-08-20 — the cleanest possible demonstration)*. `apps/core/test/opd-lifecycle.e2e.test.ts` needs a free slot more than 20 minutes out, and the day's last bookable slot is 23:50 IST — its own docstring names the window — so three legs fail at `test:245 expect(slot).toBeDefined()` for the last ~30 minutes of **every** IST day. During pipeline C a **docs-only commit** (`f76f82e`: roadmap and spec prose, zero code) went **CI RED** on it, pushed 18:16:32Z = 23:46 IST; all four pipeline commits were pushed outside the window and all four are green. T14's gate hit the same thing locally at 23:22–23:30 IST, proved `git diff --stat` over `apps/core` was empty, and re-ran after midnight for exit 0. **Two consequences worth carrying: `pnpm verify` and CI are both non-deterministic in that window, so a red there is not evidence about the commit that happens to be under it; and the repo's own Global Constraint ("every clock-reading service takes `now: Date = new Date()`") is the fix this suite never received.**

**3.42 — A 403 SWEEP driven by a role-less user proves a route is guarded, never that it is guarded by the RIGHT permission.** *(Plan 08 pipeline B, T11 — found by the discovery reviewer, one pipeline before four screens land on it)*
T11's sweep iterates the 31-route table with a user holding no roles at all, and every positive-path test uses a single cashier granted **all fourteen** billing permissions at once. Between them, nothing binds a route to its specific permission: a route decorated with any existing-but-wrong permission answers 403 to the role-less user identically and passes, and the all-permissions cashier can never observe a wrong grant either. The route-to-permission map in `manifest.ts` and the controller decorators is therefore entirely unasserted — which is exactly what let `GET /billing/receipts` ship returning the **raw `receipts` row, including the Rule 114B `panNumber`**, behind `billing.invoice.read`, a permission the module's own README grants to every cashier. **A permission sweep needs a SECOND actor: one holding the OTHER role's real grants, refused on the routes that are not its own. An all-permissions fixture and a no-permissions fixture cannot, between them, test a permission MAP.**

**CLOSED 2026-08-20** *(main session, `apps/core/test/billing.e2e.test.ts` — the table-driven follow-up §2.37(a) predicted, done in the main session because `apps/core` is frozen for pipeline C)*. `ROUTES` now carries a third column — the permission each decorator names — and the role-less sweep asserts the kernel guard's `missing permission <x>` per route, so **31 of 31** bindings are asserted rather than 4. A transcribed column is only a REGRESSION PIN on its own, so two further legs read it against sources that are not the decorators: (i) the guarded set is closed over `billingManifest.permissions` — a route demanding an UNDECLARED permission is one `syncPermissions` leaves unreachable by every role forever, and `billing.credit.extend` is asserted to be the ONE declared permission no route guards; (ii) the all-fourteen cashier is swept over the same 31 routes and asserted never to be refused BY A MISSING PERMISSION — the granted direction, which no-roles and all-permissions fixtures cannot reach between them. The shaped two-actor test stays: it is still the only leg proving a REAL, NON-EMPTY grant set is admitted on its own routes.
**Three mutants, one control, each killed by a different leg.** `GET /billing/refunds` repointed `reports.read → invoice.read` (a DECLARED, WRONG permission): killed by the sweep, and **the status stayed 403 while only the message moved** — precisely the mutant the old sweep passed, which is this entry's whole claim, demonstrated. `PUT /billing/degraded` repointed to `billing.config.wriet` (UNDECLARED): killed by the sweep AND, independently, by the granted-direction leg. A 15th manifest permission guarding no route: killed by the manifest leg **alone**, the other two green. CONTROL (unmutated, byte-restored, md5 verified) 3/3 pass; full `pnpm verify` exit 0, 118 suites / 755 tests.

**3.43 — SCOPE A FIX TO THE INVARIANT, NOT TO THE REPRODUCTION. A defect found at one door usually has more than one door.** *(Plan 08 post-pipeline-B, the `advanceOf` negative-balance fix — ~380k tokens, entirely avoidable)*
The discovery review reproduced the negative-advance absorption through `markEnteredInError`, and the fix brief's Files list named that writer and its neighbours. The reviewing gate then went past its brief and reproduced the **identical harm** through `allocateReceipt` — against the already-fixed commit — because that writer guards only the invoice's outstanding and the receipt's unallocated remainder, and neither subtracts `advanceRefundedPaise`. Observed on the fixed code: `{ afterAllocate: -50000, nextAdvance: 50000, servedAdvancePaise: 50000 }`. One invariant (`advanceOf(patient) >= 0`), two doors, and the brief closed one of them while its acceptance criteria all passed. It mattered immediately: the plan's Task 13 step 1 drives exactly the unclosed door.
**The check is mechanical and takes one grep.** Before writing the Files list for an invariant fix, enumerate every WRITER of the quantity the invariant constrains. Here: `grep -n 'insert(allocations)'` returns four sites, two of them `kind: "apply"` — one is the door that was closed, one is inside `issueInvoice` and is safe **by construction**, which the follow-up then PROVED (`allocatedPaise = Math.min(receiptTotal, netPayable)`, so its net effect on the balance is `receiptTotal − allocated >= 0`; it can only RAISE an advance) rather than asserting. A fix scoped to the reproduction is scoped to wherever the reviewer happened to walk.
**Corollary, and it is the cheaper half of the lesson:** the reproduction that finds a defect tells you the defect EXISTS; it never tells you the defect's EXTENT. Ask "what else writes this?" while the brief is still a text file.

**3.44 — A GUARD ADDED TO A MONEY PATH NEEDS A NOT-OVER-BROAD CRITERION, or the fix becomes the next defect.** *(Plan 08 post-pipeline-B, both advance guards — 0 tokens, because the criterion was written in advance)*
Both fixes above refuse a previously-legal operation. A guard written slightly too wide would have refused legitimate work — a plain advance allocating onto a later invoice, an ordinary issue-with-receipt — and every mutant and every fail-first red would still have passed, because they only ever exercise the defect's own path. The brief therefore carried an explicit criterion: *"the legitimate path is unharmed — a plain advance with NO refund against it still allocates normally, and the ordinary issue-with-receipt path is untouched; both asserted."* The coder discharged it in three legs, including a partial case (100,000 banked, 40,000 refunded → refuses at 60,001, ACCEPTS 60,000) which proves the guard is a **balance check and not a "has this patient a voucher" check** — a distinction no mutant in the set would have caught. **Whenever a fix adds a refusal, write the criterion that protects what must still be allowed, and make it name a case adjacent to the refusal rather than a comfortably distant one.**

**3.45 — EVERY WRITE BUTTON IN A FOUR-SCREEN MODULE WAS RE-ENTRANT, AND ONLY A CROSS-TASK PASS COULD SEE IT.** *(Plan 08 pipeline C — found by the discovery reviewer with a probe against SHIPPED code, no mutant needed)*
Probe against the real `billing-dues.tsx`: open the dues-clear lane, type ₹300, click `clear-submit` twice before the round trip settles → `AssertionError: expected 2 to be 1` on the count of `POST /billing/receipts`. **One physical payment, two receipt rows.** `grep -rn 'submitting|isPending|busy|inFlight|disabled={'` across all four billing screens returns **nothing at all**: every write is the same bare idiom, `<Button onClick={() => void handler()}>` — `submit-invoice`, `clear-submit`, take/apply-advance, `open-submit`, `close-submit`, confirm-close, `pay-submit`, `eie-confirm-submit`, recon upload. The server offers no idempotency key on `POST /billing/invoices` or `POST /billing/receipts`, so the duplicate is a real second document: a duplicated cash receipt inflates the patient's advance and **manufactures exactly the drawer variance `44c8b86` was written to eliminate**; a duplicated invoice POST issues a second invoice number against one encounter.
**This is the class the cross-task pass exists for, and it is invisible to every other control.** No single task shipped it wrong; four tasks shipped it *the same way*, which is what a shared idiom does. Four opus gates each read one screen and each saw an ordinary React button. None of the 33 tests these commits added asserts single-submit under a double click, because "the button works" is what every screen test checks. **Two rules. When a plan ships N screens that all write money, name the in-flight guard as a CONVENTION with an owner and a mutant (§3.34) before the first screen is built — retrofitting it means touching every screen afterwards. And assert it with two SYNCHRONOUS clicks and a call count, never with a `disabled` attribute: a disabled button proves the DOM, not the handler.**

**3.46 — A HAND-OFF WRITTEN IN A SOURCE COMMENT REACHES NOBODY.** *(Plan 08 pipeline C, T14 → T16 — §2.16's shape moved inside the code, and it dropped the guard that cost ~380k tokens to add)*
`billing-dues.tsx:51` says, correctly and helpfully: *"The ledger's OTHER terminal refusal, `eie_advance_refunded`, is raised by `markEnteredInError` and is unreachable from this screen — the EIE lane lives in the back office, which owns it."* T16 then built that lane. `grep -rn 'eie_advance_refunded' apps/web/` returns **exactly one hit: that comment.** No `TERMINAL_CODES` set, no dead-end rendering, no refusal test; `billing-office.tsx:408-421` catches with `setEieError(billingErrorMessage(e))`, leaving the receipt id and reason in the form and the lane live, inviting the operator to retry a 409 that can never succeed. T14 discharged its OWN half properly — `TERMINAL_CODES` at line 54, the dead-end branch at 177, a test with a not-over-broad companion. Pipeline B §4 item 1 had been explicit that **both** refusals must render as dead ends with no remedial action, because a paid voucher is cash that physically left the drawer.
**The general rule: an invariant whose two doors land in two different tasks must be named in the RECEIVING task's Files list or criteria, never in the sending task's comment.** A comment is addressed to whoever opens that file, and the person who builds the other door never does. This is §3.43's "a defect found at one door usually has more than one door" seen from the authoring side — and note the irony that the sending task *identified the second door precisely* and still could not route the work to it.

**3.47 — THE OBVIOUS SPELLING OF A DOUBLE-CLICK TEST CANNOT SEE A SINGLE-FLIGHT GUARD: `fireEvent` FLUSHES REACT BETWEEN THE TWO CLICKS.** *(the re-entrancy fix, 2026-08-21 — caught by the mutant, which SURVIVED the first version of the test)*
The re-entrancy fix added a `SubmitButton` whose ref latch stops a second call synchronously, plus `disabled={busy}` as the affordance. The test was written the obvious way — two `fireEvent.click` calls with no await between them — and its comment asserted, plausibly, "React has not re-rendered, so the button is still enabled when the second click lands". **The mutant that deletes the latch and keeps the attribute SURVIVED it** (`Tests 1 passed | 5 skipped (6)`, exit 0).
Testing Library wraps EVERY `fireEvent` call in `act()`. React re-renders between the two clicks, `disabled` goes true, and the second click never reaches the handler — so the test passes against a component with no guard in it at all. Measured with a probe against both modules in one run: **shipped `calls=1`, latch-deleted `calls=2`, `disabled` true in BOTH.** The idiom that discriminates is two RAW dispatches inside one `act` block:
```
const click = () => button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
await act(async () => { click(); click(); });
```
**Two rules.** A test for a single-flight guard must be proved against a guard-less mutant before it is believed — a passing double-click test is exactly what a component with no guard also produces. And this belongs beside §2.34's harness facts: **`fireEvent` is not "a click without the waiting", it is a click plus an `act` flush**, which is precisely the thing a re-entrancy test must not have between its two events. The discovery review's own instruction — "assert it with two clicks and a call count, not with a disabled attribute" — was right and still not sufficient, because the obvious way to write those two clicks silently reintroduces the attribute as the thing under test.

**3.48 — A `void`-ED ASYNC IIFE TURNS A REJECTING HANDLER INTO AN UNHANDLED REJECTION, AND VITEST BILLS IT TO WHATEVER FILE IS RUNNING.** *(the re-entrancy fix, 2026-08-21 — 42 tests passed and the suite was RED)*
`SubmitButton`'s first cut wrapped the handler as `void (async () => { try { await onClick(); } finally { release(); } })()` — a `try/finally` with no `catch`. A handler that rejects therefore rejects the IIFE's promise with nobody holding it. The run reported `Test Files 5 passed (5)` / `Tests 42 passed (42)` **and exited 1**, with `Vitest caught 2 unhandled errors during the test run` and the note that it "might cause false positive tests".
**This is §2.16's `f84f1b1` shape in a new place** — all tests green, the SUITE red around them — and it carries the same attribution hazard: vitest blames the file that happens to be running when the rejection lands, so on a full run it reads as a flake in an innocent suite. Note also that it is invisible to the exit code alone if anyone reads the summary line instead of the status (§16/§17 one level out: here the SUMMARY says pass and the STATUS says fail, the opposite of the usual trap).
The fix is a `catch` that reports rather than swallows — every caller already renders its own refusal, so reaching that branch means a genuine programming error and silence would hide it. **The general rule: `void promise` and `void (async () => …)()` are not error handling, they are error DISCARDING. Any place a rejection can reach one, put a catch there, and assert the reporting** — the assertion matters because the failure mode is a red suite in someone else's file.

**3.49 — A DESIGN DECISION NEEDS A MUTANT THAT INVERTS THE DECISION, NOT ONE THAT BREAKS A LINE — AND THE TEST THAT CATCHES IT IS USUALLY THE ONE NOBODY WOULD BOTHER TO WRITE.** *(the billing idempotency fix, 2026-08-21 — six of seven tests ratified the WRONG design)*
The idempotency helper's whole design rests on one sentence: **the key is claimed BEFORE the work, not recorded after it.** Claiming first means a concurrent duplicate loses the `INSERT … ON CONFLICT DO NOTHING` and never reaches the write path; recording afterwards means both requests have already issued a document by the time anybody notices.
So the mutant was not a deleted line — it was **the same module with only that decision inverted**, and the result is the entry: **M-I1 passes SIX of the seven tests.** The sequential replay works perfectly under it (by the time the second request arrives the row exists), the hash check works, the release-on-failure works, the scoping works. It dies on the concurrency case alone, `Expected: 1 / Received: 2`.
**A suite without that one case would have certified the wrong design as green, and every reviewer reading it would have agreed** — the tests would all have been honest, discriminating tests of everything except the thing that mattered. Two rules. **When a module's correctness rests on an ORDERING or a placement, write the mutant that reorders it, not one that removes it** — removal usually breaks something obvious, inversion usually breaks exactly one thing. And **the discriminating test for a claim-before-work design is always the concurrent one**, which is also the one that looks redundant next to a green sequential test, costs the most to write, and is the first to be cut.

**3.50 — A LATENCY BUDGET ON SHARED CI HARDWARE MUST GATE ON THE FASTEST RUN, NOT THE MEDIAN. THE FIX IS THE STATISTIC, NOT THE CEILING.** *(2026-08-21 — the THIRD occurrence of a class this ledger had already recorded twice)*
`perf-opd-queue.test.ts` failed CI at `2bf324f` on *"openVisit median over 5 runs under 100 ms"* with `Received: 107.35`. The commit contained no OPD, perf, queue or encounter file, and the very next commit — which CONTAINS that same code — passed at `20.2, 19.2, 23.7, 22.3, 21.3` (median **21.3**). The failing run's five samples were `107.3, 230.0, 275.9, 59.4, 48.3`: a 5.7x spread, two of them comfortably under budget. A regression shifts a distribution; a noisy neighbour smears it.
**The minimum is the invariant.** Across those two CI runs `boardSnapshot`'s FASTEST sample moved 225.0 -> 225.8 (0.4%) while its median moved 242 -> 243 and its worst sample moved 731 -> 433; measured again on the build host, 219.6, and under full `pnpm verify` parallel load, 253.5. Contention can only ADD time — nothing makes a query faster than it is — so the minimum estimates the work the database actually does and the median estimates the load the box happened to be under. **Gate on the first; log both.**
**The tempting fix is the wrong one, and this ledger contains the proof.** Raising the ceiling is what Plan 07 did when `boardSnapshot`'s 300 ms budget broke under parallel load (§4 cost ledger, 2026-08-17): it went to 500 and **still threw a 433 ms sample in a PASSING run** — a gate loosened until it barely gates. Here, normal `openVisit` is ~21 ms against 100 ms, so the budget was never tight; absorbing the contended window would have meant a ~300 ms ceiling on a 21 ms operation. All five budgets were left EXACTLY as they were and only the statistic changed.
**And prove the loosened gate still gates**, because this makes a gate more permissive: a mutant adding a fixed 150 ms inside the measured block raises the FLOOR and dies — `Expected: < 100 / Received: 176.65`. On the recorded failing distribution, `min(107.3, 230.0, 275.9, 59.4, 48.3)` = 48.3, so the run that went red now passes with 2x headroom while a real regression still fails. **The general rule: when an assertion is flaky, ask whether you are measuring the wrong STATISTIC before you move the threshold — moving the threshold is how a gate quietly stops being one.**

**3.4 — Verify-by-execution flags belong in the plan.** *(Plan 01 lesson, honored in Plan 02 — keep)*
Hand-written matcher patterns, raw-SQL parameter binding, third-party CI action inputs, native-module installs, and third-party API surface names all typecheck while being wrong. Plan 02 flagged seven such items in its self-review and **all seven held** — zero runtime defects in the plan's own code across twelve tasks, against three in Plan 01. This is the single highest-yield planning habit found so far.

**3.51 — A ROLE MODEL THAT COVERS 39 OF 59 DECLARED PERMISSIONS IS UNDER-DETERMINED, AND ONLY COUNTING FINDS IT.** *(Plan 11d compile, 2026-08-24 — found before a brief was written, resolved by owner ruling 7)*
The plan's D3 said "ship the ACTUAL role model" and named the README's two tables as its content. Nobody had counted what those tables cover. Measured: `opd.*` 14 + `billing.*` 14 + two `approvals.*` from the tables, plus `auth.*` 6 from `seed:admin` and `ops.*` 3 from `seed:ops` = **39 of 59 declared permissions. Twenty would have been held by NOBODY**, and the plan's invariant demanded each be held or excepted while naming only three exceptions.
**The operational half is what made it a ruling rather than a note:** shipping the tables alone gives `front_office` fourteen `opd.*` permissions and **no way to register a patient**, so the OPD flow dies at step one of the very flow the plan existed to enable. The README's own prose already said `patients.register`/`read`/`update` "stay with the desk and vitals roles" — **prose, not one of the two tables the parity test reads.**
**The rule: when a plan says "ship the model", COUNT what the model covers against what the system declares, before writing a brief.** The arithmetic is one grep and it is the difference between a mechanism and a mechanism with a hole. And: **a permission model stated partly in tables and partly in prose has two sources, and the parity test will only ever read one.**

**3.52 — AN INVARIANT AND ITS EXCEPTIONS LIST MUST BE ABOUT THE SAME PROPERTY.** *(Plan 11d D1, 2026-08-24 — caught at compile by reading the two sentences next to each other)*
D1's invariant: *every declared permission is either **HELD BY AT LEAST ONE ROLE**, or named in an exceptions list.* D1's exceptions: `auth.users.manage`, `auth.roles.manage` (*declared, **guarding no route***) and `billing.credit.extend` (*checked inside the transaction, **never at a route***). **All three reasons are about guarding a route; the invariant is about being held by a role.** Under the invariant as stated **none of the three is an exception at all** — `admin` holds both `auth.*` strings and the README's own table grants `credit.extend` to `cashier`. As controls in Book row V2 they proved exactly nothing.
Both properties are real and both deserve tests — "declared but guarding no route" is what `billing.e2e.test.ts` and T4's manifest-closure leg assert, per module. **They are just not the same test.**
**The rule: read an invariant and its exception list as one sentence and ask whether the exceptions are exceptions TO THAT INVARIANT.** A list that exempts things on a different axis makes the invariant look guarded while leaving its real gaps unnamed — here, twenty of them.

**3.53 — A VERDICT COMPUTED FROM SOURCE CONSTANTS IS NOT A VERDICT ABOUT THE DATABASE, AND A SEED SCRIPT'S REPORT IS READ AS ONE.** *(Plan 11d T1, found by the DISCOVERY REVIEWER; the same defect the plan existed to abolish, inside the artefact built to abolish it)*
`seed:roles` was written to close MAJOR 4 — a permission catalog that mirrors names and grants nothing. Its own census and `READY` verdict are computed as `held = modelPermissions() ∪ GRANTED_BY_OTHER_SEEDS.flatMap(...)`, entirely from repository constants; it reads `role_permissions` only to decide `granted` vs `already` per role. **Measured on a database where only `seed:roles` had run: it claims 42 held while 33 are actually granted, and names nine strings as held that nobody holds. Giving every model role a holder was the only thing needed to reach `ready=true`.**
**The arming mechanism is another script's early return.** `seed-admin.ts` returns before every `grantPermissionToRole` on any deployment that already has an admin. So the day `authManifest` grows a permission, production can never grant it — while `heldPermissions()` counts it held immediately, **and the orphan assertion stays green because it reads the same constant.**
**The rule: a script whose transcript IS the audit record must derive its verdict from what it READ, not from what it BELIEVES was run.** Where a report depends on another script having run, that dependency is a claim to VERIFY at runtime, not to inherit. The generalisation: §2.54's "two copies of one fact drift by construction" applies to a fact and its ASSERTION as much as to two lists.

**3.54 — AN ACCEPTANCE CRITERION THAT NAMES ONE LOCATION FOR A SWEEP WHOSE RULE SAYS *EVERY* LOCATION SILENTLY DEMOTES THE RULE TO A CHECKLIST ITEM — AND THE CHECKLIST IS ALWAYS SHORTER.** *(Plan 11f T1, 2026-08-24 — caught at the phase's own close by grepping for the retired claim, remediated in `1bae1d0`)*
T1 closed a stated seam and its acceptance said: *"the F8 seam note in the script header is retired in the same commit (§2.90)"*. The executing session did exactly that, and it was not enough. §2.90's actual rule is that **a commit which changes a behaviour retires EVERY claim about it in the same commit**, and three live claims survived: `password-policy.ts`'s own *"FIVE call sites"* — in the module that OWNS the fact — `seed-staff.ts`'s *"the four other paths"*, and `password-policy.test.ts`'s account of where the per-call-site coverage lives. The roadmap still listed the seam as open. None is reachable by a test; all four would have read as true to the next person.
**The rule: when a task invokes a sweep rule, its acceptance must state the SWEEP, not an instance of it** — *"grep for the behaviour's own name and retire every claim"*, with the header named as an example rather than as the criterion. A plan that enumerates locations is asserting it already knows them all, which is the thing the sweep exists to doubt. The cheap detection is §2.90's own closing sentence, run as written: `grep` for the behaviour's name before closing, not before committing the one file you were thinking about.
**IT HAPPENED TWICE IN ONE PHASE, ON BOTH OF THE PHASE'S SWEEPS, AND THE SECOND TIME IS THE PERSUASIVE ONE.** The T1 sweep above missed three claims, then a close remediation retired those three and the phase's independent reviewer found a FOURTH (11e's own CLOSE record of the seam). Separately, T4's acceptance named two sentences to amend for §2.91 — V3 §8 and `ci-watch.sh`'s header — and a post-review grep found a THIRD standing in `EXECUTE-METHOD.md`, the v2 manual that is still in force as the HEAVY-lane document. **Every miss was a file the task's Files list did not name, and a Files list is a record of what the author remembered.** So the operational form of this rule is mechanical and takes seconds: *before closing, grep the whole repository for the retired behaviour's own name and read every hit* — not the files you edited, not the files you listed, all of them.

**3.55 — VERIFY-BY-EXECUTION MEANS READING WHAT THE PROGRAM TELLS THE OPERATOR TO DO, NOT ONLY WHETHER ITS VERDICT WAS RIGHT.** *(Plan 11f T4, 2026-08-24 — caught before the commit, at zero cost, by executing the new poller against a known-red sha and reading its output line by line)*
`ci-watch-host.sh`'s first draft read `/commits/{sha}/check-runs`, which §2.91 names, and got the VERDICT exactly right: `3eec860` RED, `00c3747` GREEN, correct exit values. It also printed `gh run view 97264648280 --log-failed` — the CHECK-RUN id, not the WORKFLOW-RUN id, so the one command it hands a person at the moment they need it **does not resolve**. Both numbers are 11 digits and neither looks wrong. `/actions/runs?head_sha=` is equally readable unauthenticated and returns `32668118868`, the id `gh run view` accepts and the one 11f's own runbook names.
**The rule: a program that emits guidance is verified only when the guidance has been read as guidance.** A green verdict from a tool proves the tool's arithmetic, not its usefulness — and the emitted-text half is exactly where §2.90's cost landed one phase earlier, in `seed-roles.ts`'s census steering an operator away from the repair. When two API surfaces answer the same question, prefer the one whose identifiers match the tool the reader will type next.

**3.56 — A RULING THAT SAYS "WARN, DO NOT ENFORCE" IS ENFORCED ANYWAY IF THE WARNING CHANNEL IS WIRED TO AN EXIT CODE. CHECK WHAT THE CHANNEL IS CONNECTED TO, NOT WHAT IT IS CALLED.** *(Plan 11f T2, found by the independent reviewer as M1 — the executing session implemented the opposite of the decision it was implementing, in good faith)*
D2 ruled that a two-full-administrator invariant is UNSATISFIABLE as code — `seed:admin` mints exactly one, so an enforcing check would refuse the very mutations that repair the state — and that what ships instead is *visibility*: the census "prints the count and warns by name when it is below two". The session put the shortfall into `seed-roles.ts`'s `problems` array, which is the census's loud channel and reads exactly like a warning list. **`problems` also feeds `ready`, and `ready` feeds `process.exitCode`** (11d added that deliberately, because a verdict nobody can see must still reach a caller). So the "visibility-only" detector made every bootstrap and all of production exit 1 for ever, on the channel a deploy checklist reads as *"confirm it exits 0"*, and `seed:roles && …` under `set -e` would abort. **The ruling said do not enforce; the implementation enforced, through a side effect two hops away.**
**The rule: when a decision distinguishes WARN from ENFORCE, the implementation must name a channel that provably cannot change a verdict — and the test asserts the verdict is IDENTICAL with and without the warning.** Naming is not enough: `problems` and `warnings` look alike at the call site and differ only in what reads them. The generalisation of §2.63(b): a signal that fires on every healthy deployment trains its reader to ignore it, and an exit code is the loudest such signal a script has.

**3.57 — A PARSER'S SILENCE MUST NOT BE A VALUE. WHEN A PROBE'S PLUMBING FAILS, EVERY DOWNSTREAM `case` DEFAULT TURNS THE FAILURE INTO A VERDICT.** *(Plan 11f T4, found by the independent reviewer as M2, with the limit MEASURED)*
`ci-watch-host.sh` passed the GitHub API body to python through an environment variable. `execve` on the build host refuses an env string at ~131 KB (fails at 132 000 bytes, succeeds at 131 000); one `workflow_run` object from this API is ~17 KB; the poller requested `per_page=20`. **At eight runs on one sha the probe dies with "Argument list too long" on STDERR — which `$(probe …)` does not capture — so it emits nothing on stdout.** `read -r concl secs id <<<""` then leaves every variable empty, the empty string falls through to the `case`'s `*)` arm, `${secs:-0} -lt 15` is true, and the watcher prints *"CI DID NOT RUN … almost always billing, a spending limit, or a blocked dispatch"* about a commit that may be red — a verdict minted by the poller's own plumbing and attributed to GitHub. Exit 2 ("undischarged") means nobody stops for it either.
**Two rules.** (a) **Never pass unbounded data through the environment**; stdin has no such limit, and the ceiling is invisible until the day the data grows. (b) **The stronger and more general one: a dispatch over parsed output must enumerate the values it understands EXHAUSTIVELY, so the default arm can mean "the plumbing broke" instead of "a value I have not met".** Converting `*)` from catch-all to fault-handler immediately exposed a real gap — `startup_failure`, a genuine GitHub conclusion the allowlist had omitted, which the catch-all had been silently absorbing. That is the point: a catch-all does not handle the unknown case, it *hides* it.

---

**3.58 — A TASK THAT MOVES A PATH SPACE MUST NAME EVERY CONSUMER OF THAT SPACE, AND THE CONSUMERS ARE RARELY ALL IN ONE PACKAGE.** *(Plan 11g T-D1, found while executing; the health gate it would have broken is the same gate this phase exists to strengthen)*
T-D1 moved the API from twelve bare prefixes to `/api/*`. Its Files list named the SPA's client, the WebSocket URL, the dev proxy, the Caddyfile, the parity test and 22 test files — everything under `apps/`, complete and correct. **Two consumers of the ORIGIN live outside `apps/` entirely**: `deploy.sh`'s step-8 gate and the README's 03:00 runbook line, both of which `curl https://<site>/health`. After the split that path falls to the SPA handler and answers **HTTP 200 with an HTML body**, which `curl -fsS` reports as success — so the deploy's own health gate would have gone green over a dead API, and the operator's 03:00 "is the hospital serving?" check would have said yes. That is §2.88's class arriving through a door §2.88 does not watch: not a list that disagreed with another list, but a CONSUMER nobody enumerated.
**The rule: for a change to an addressing scheme — a path prefix, a port, a hostname, a queue name — grep the WHOLE repository for the old address, including `docker/`, `*.md` and anything that shells out, before writing the Files list.** The Files list is generated from that grep, not from the package the code lives in. **And the repair is stronger than the re-point:** the gate now checks the BODY (a 200 carrying a document is a `die`) and asserts a SCREEN path serves the SPA, so the deploy itself is the regression test for both halves of the split. A gate that can be satisfied by the wrong service answering is not a gate.

**3.59 — A DATABASE KEY WRITTEN FROM UNAUTHENTICATED INPUT NEEDS A LENGTH BOUND AND A NAMED REAPER, AND BOTH ARE CORRECTNESS RATHER THAN HOUSEKEEPING.** *(Plan 11g T-D4, found by the independent close reviewer as MAJOR 2, with the Postgres boundary MEASURED)*
The auth-throttle table is keyed on `(kind, submitted_username)` — deliberately the SUBMITTED string, so the 429 cannot be used to enumerate accounts. Two things followed that nobody wrote down. `loginSchema` puts no ceiling on `username` (correctly: login VERIFIES a credential rather than choosing one) and the JSON body limit is 1 MB, so an anonymous caller could submit a multi-kilobyte username — and `subject` is half a composite PRIMARY KEY, where **Postgres refuses a btree index tuple over ~2704 bytes outright**. The INSERT threw, the throw escaped the login handler, and a route that answered a clean 401 answered **500 to an unauthenticated request**: a security control creating a new availability defect on the path it protects. Below that boundary, every failure against a NEW string wrote a permanent row and only a SUCCESSFUL authentication for that exact subject ever removed one, so spraying invented usernames grew the production database and its WAL archive without limit.
**The rule: when a value from an unauthenticated request body becomes part of a key, bound its length AT THE POINT IT BECOMES A KEY — not in the request schema, which may have good reasons to stay open — and answer "what deletes these rows?" in the same commit.** *"Nothing deletes them"* is a permissible answer only if it is written down and defended. Bounding at the key also fixes every path that shares the key function, which a schema bound does not.

**3.60 — A DEPLOY STEP INHERITS THE EXIT SEMANTICS OF THE PROGRAM IT RUNS, AND A "VERDICT" EXIT CODE IS NOT A "FAILURE" EXIT CODE.** *(Plan 11g T-D2, found by the independent close reviewer as MAJOR 1 — the fix for one phase's finding armed a deploy abort in the next)*
Ledger §3.53's remediation gave `seed-roles.ts` a truthful exit code: `process.exitCode = report.ready ? 0 : 1`, because a script that reported orphaned permissions and exited 0 made the deploy checklist's *"confirm it exits 0"* a check that could not fail. Correct then, and it stayed correct. **Plan 11g then put that script into `deploy.sh` under `set -euo pipefail`** — and `ready` is a statement about who HOLDS which role, which is the hospital's STAFFING. On a fresh box it is false by construction; on a running box, revoking one person's role through `/admin/users` silently arms it. Either way the deploy dies AFTER migrations have applied and BEFORE the containers are recreated. Worse, the ordering compounded it: `seed-roles`'s census counts the three `ops.*` grants `seed-ops` writes, and `seed-roles` ran first, so the verdict was false on every fresh deployment. `seed-roles.test.ts` ALREADY asserted `ready === false` in exactly that state — the fact existed, and nothing connected it to the script.
**Two rules. First: before putting a program into a script under `set -e`, read what its NON-ZERO means.** A verdict about the world is not a failure of the step, and a deploy cannot repair staffing. Run it for its effects, capture its verdict loudly, and let a gate that asks only about repairable things own the exit status. **Second: where two programs' invariants reference each other, the ORDER between them is a fact that needs a pin** — no test that executes ONE of them can see it, which is why this survived a green suite, a green `pnpm verify` and green CI. The pin is static: parse the shipped script and assert the order, the way `deploy-parity.test.ts` already parses it for restarts and rule files.

## 4. Cost ledger

| Date | Cause | Class | Cost |
|---|---|---|---|
| 2026-08-12 | Plan 02 T1 coder ran `mkdir /tmp/deleteme` as a sanity check, breaching the no-`/tmp` rule that was present in its brief | Tripwire #3, buried in prose | ~100k tokens (retry + second gate); residue needed manual operator cleanup because agents were correctly blocked from removing it |
| 2026-08-12 | Plan 02 T4 coder used the owner's local Windows working tree as scratch space; the retry that tried to clean it was blocked by the safety classifier | Tripwire #2 — **previously unrecorded**, discovered the expensive way | ~197k tokens (gate catch + escalation + third gate) |
| 2026-08-12 | Plan 02 T5 lost two gates to API 529 and the ladder re-ran the coder and escalated | Template defect §2.1 | ~168k tokens |
| 2026-08-12 | Some agent ran a bare `tsc`, leaving 128 emit artifacts that shadow `.ts` in jest resolution | Tripwire #5 — previously unrecorded | No tokens; a latent false-pass/false-fail trap for every later task, cleaned in `7284d36` |

| 2026-08-12 | Plan 02 T12 lost two gates to API 529; the ladder re-ran the coder and escalated to heavy-coder to re-verify already-committed, already-correct work | Template defect §2.1 — **the same bug recurring in the same session**, because pipeline B was already compiled from the old template when the fix landed | ~140k tokens |
| 2026-08-12 | Plan 02 T11 stripped the break-glass bypass out of `guards.ts` and its handlers out of `auth.controller.ts` **on the live server** to manufacture a red run a gate correction had demanded | Criteria defect §2.3 + missing tripwire 14 | ~111k tokens; restored, final tree provably intact, but this is the plan's most serious process failure |
| 2026-08-12 | Agents passed POSIX paths to Write/Edit on a Windows host, creating `C:\opt\hmis\...` | Tripwire 13 — previously unrecorded | negligible tokens; two stray files await manual removal |
| 2026-08-12 | Plan 02 T8's `MODULE_REGISTRY` token had to go in `tokens.ts` though the brief's file list named only `app.module.ts` | §3.1 **recurring** — predicted by this ledger and still hit, because the compile reconciled T7's instance (`@types/express`) but not T8's | absorbed in one attempt; no retry |
| 2026-08-12 | Plan 03 T4's gate correction instructed `git commit --amend` + `git push --force-with-lease` on an already-pushed, already-CI-green commit; the coder complied and the classifier flagged it | Template defect §2.4 + missing tripwire 15 — **previously unrecorded** | ~50k tokens (the retry itself was a genuine code defect and worth paying for); no data lost, history linear, both SHAs CI-green |
| 2026-08-12 | Plan 03 T2 attempted `pnpm verify > /tmp_verify_check.log`; the permission classifier blocked the write and the agent did **not** route around it, re-running with `/dev/null` instead | Tripwire #3 **working as designed** — the same breach that cost ~100k tokens in Plan 02 T1 | 0 tokens. Recorded deliberately: this is what a tripwire looks like when it holds |

| 2026-08-13 | Plan 04 T2's `truncateAll` SQL truncated a new child table in a separate earlier statement instead of naming it in the existing workflow FK group; Postgres refused and all three schema tests failed at setup | Authoring defect §3.12 — **previously unrecorded** | absorbed in one attempt, no retry. The coder fixed the minimum and disclosed it as a PLAN DEFECT exactly as briefed — the §5 habit paying off a third time |
| 2026-08-13 | Plan 04 T3 read `VERIFY_EXIT=1` off `pnpm verify \| head -30` (SIGPIPE) and had to re-run unpiped to establish the truth; T4 independently pre-empted the same trap with `${PIPESTATUS[0]}` | Tripwire 16 — **previously unrecorded**. The recorded direction is the harmless one; the dangerous direction is the silent false PASS, since `\| tail` exits 0 when verify fails | 0 tokens, no retry. Recorded because the same construct appeared in the **main session's own** first verification of the session |

| 2026-08-13 | Plan 04 T5's race test enumerated 2 of the 3 loser codes Plan 03's shipped arbiter can produce; the assertion passed 1 run in 5 and no implementation could have fixed it | Authoring defect §3.13 — **previously unrecorded**; §3.11 one level deeper (flaky, not impossible) | absorbed in one attempt, no retry. Found because the coder ran it 5 times instead of once |
| 2026-08-13 | Plan 04 T5's `decide()` used `Promise<{ status: typeof verdict }>`, which resolves to the parameter's declared union and does not narrow per call site — TS2322 on both exported wrappers | Authoring defect: the plan's TypeScript typechecked in the author's head, not in the compiler | absorbed in one attempt, no retry (2-line generic fix) |
| 2026-08-14 | Plan 05 T13's Enter-advance test left the second field empty, so implicit submit + react-hook-form's `shouldFocusError` produced the exact focus move the test asserted — the feature could have been deleted without failing it | Authoring defect §3.14c — fourth instance of the class, and the first where a *second framework mechanism* produced the same observable | ~140k tokens (retry coder + second gate). Genuine catch; the retry also built a mutant to prove the kill |
| 2026-08-14 | Plan 05 T14: `z.preprocess` made the form schema's INPUT type `unknown` (TS2719), and the same mismatch meant `watch("ageYears")` returned the STRING "10", so `typeof === "number"` was false and the D-31 minor-guardian section would never have rendered | Authoring defect §3.19 — **previously unrecorded**; a safety rule silently disabled behind a compiler error | absorbed in one attempt, no retry. Found because the coder chased the runtime instead of widening the generic |
| 2026-08-14 | Plan 05 T14's brief asserted the jsdom canvas stub list was exhaustive at THREE; jsdom also lacks Blob URLs, so capture died on `URL.createObjectURL` after the canvas stubs worked | Compile defect §3.20 — **mine**, the stress pass claiming exhaustiveness it had not executed | 0 tokens, no retry. The coder found and fixed it inside the original attempt |
| 2026-08-13 | Plan 05 T9's e2e bootstrap passed `undefined` as a positional placeholder to `createNestApplication`, which dispatches on argument shape — `{ bodyParser: false }` was silently discarded and Express's 100 kB parser would have rejected the 300 kB photo | Authoring defect §3.17 — **previously unrecorded**. Caught inside the original attempt by verify-by-execution flag ⑩, exactly as designed | absorbed in one attempt, no retry. The §5 disclose-don't-work-around habit paying off a fourth time |
| 2026-08-13 | Plan 05 T10 leg 4 claimed to prove the `requester_approver` SoD pair over HTTP, but the clerk holds no approvals permission by design, so the route guard produced the 403 and `assertNotSodPair` never ran | Authoring defect §3.14b — the third §3.14 instance in two pipelines, and the one a §3.14-hunting stress pass **missed**, because it is a design contradiction rather than a fixture defect | ~177k tokens (retry coder + second gate). The gate caught it; this is the system working |
| 2026-08-13 | Plan 05 T8's execute test created no guardian and no photo, so "guardians move to the winner" and "photos do NOT move" were never asserted — it asserted `guardianIds` length **0**, the empty case | Authoring defect, §3.14 class again | 0 tokens, no retry. Forced into the open by a compiled acceptance criterion that named both invariants explicitly — criteria doing the stress test's job at execution time |
| 2026-08-13 | Plan 05 T6's retry was blocked by the permission system partway through — it wrote the corrected test to the server but could not run tests, run verify, or commit, and stalled twice (388 s, 2446 s) before returning INCOMPLETE with the server tree left DIRTY | Host/harness failure. The ladder handled it correctly: gate #2 failed it on the uncommitted file, the escalate rung ran verify-only, landed the correction as a NEW follow-up commit (tripwire 15 held — nothing was amended), and gate #3 passed | ~116k tokens (the escalate rung + its gate). The retry itself was legitimately owed — gate #1 caught a real defect (§3.14) — so only the rung the blockage forced is prevention debt |
| 2026-08-13 | Plan 05 T4's brief pinned "6 functional tests" to `test -- search`, a jest PATH REGEX that the task's own `perf-patient-search.test.ts` also matches — unsatisfiable at task end | Compile defect §2.5 — **mine, not the plan's**; §2.3's shape in a new place | 0 tokens, no retry. The coder quoted both runs and named the narrowing regex |
| 2026-08-13 | Plan 05's six briefs each quoted a fixed baseline SHA (cc22b19) that was stale from T2 onward; four coders each wrote a paragraph reconciling it | Compile defect §2.6 — **previously unrecorded** | 0 tokens of retry, but four rounds of avoidable doubt; a more literal agent would have halted |
| 2026-08-13 | Plan 05's baseline verify was run on a foreground SSH channel; the link reset at ~10 min (exit 255) with `apps/core` five suites in, and the harness reported **exit 0** because the trailing `; echo "EXIT: $?"` wrapper had succeeded. Caught only by reading the echoed value | Tripwires 17 + 18 — **previously unrecorded**, and hit by the MAIN SESSION, exactly where tripwire 16 was found in Plan 04 | 0 agent tokens (pre-compile), ~10 min wall clock re-run detached. Recorded because the reported-PASS direction is the silent one: a dropped verify would have certified a baseline nobody measured |

| 2026-08-14 | Plan 06 T4: the plan's activation serializer `WHERE status='activated' FOR UPDATE` locked zero rows in the race test's own starting state, so the loser threw `effective_from_not_monotone` instead of the single traced value. Surfaced 1 run in 15 | Authoring defect §3.21 — **previously unrecorded**; §3.13 one level deeper, because the plan *claimed* the loser code had been traced | ~175k tokens (retry coder + re-gate). Genuine catch, worth paying for. Found only because the gate re-ran the test 15× in isolation instead of trusting the report |
| 2026-08-14 | Plan 06 T4: the coder's five "clean" race runs used `pnpm ... test -- versions.test --testNamePattern=...`, which does not isolate — pnpm injects a literal `--`, yargs stops parsing, and the pattern becomes a second PATH pattern, so the full 9-test suite ran five times | Tripwire 19 — **previously unrecorded**. A false-verification trap in the same family as 16–18: evidence you did not actually measure | 0 extra tokens (folded into the T4 retry above), but it is what let a 1-in-15 flake be reported as 5/5 clean |
| 2026-08-14 | Plan 06 T4 gate #2 passed the fix on five NON-isolating runs after gate #1 had demanded twenty isolated ones — the evidence bar dropped between two gates on the same task | Process failure: a gate weakening its predecessor's standard. Caught by main-session verification (20/20 isolated, `8 skipped, 1 passed` confirming isolation) | 0 tokens; the fix was structurally correct. Prevention: the isolation requirement now lives in the gate prompt, not only in the brief |
| 2026-08-14 | Plan 06 pipeline A: three harness STALLS (`sonnet:t4` 1513 s, `sonnet:t5` 406 s, `gate:t4#2` 227 s) were runtime-retried; the three stalled agents became **the three most expensive agents of the entire plan** (262k / 337k / 122k against peers at 86–115k and 58–101k) | Host/harness failure — prevention debt, no code produced | **~420k tokens**, the single largest cost driver of the plan and ~60% of its overrun |
| 2026-08-14 | Plan 06 pipeline B's first launch died to a network outage: one truncated response then 3× `ENOTFOUND`, exhausting MAX_INFRA; T8–T10 skipped on the dependency edge | Infrastructure. **The ladder worked exactly as §2.1 designed** — no tier promotion, no defect attempt consumed | ~134k tokens, no code, no damage |
| 2026-08-14 | That outage produced the run's most dangerous state: the dead T7 coder had **already pushed `b3d3c0b`** before its response died, leaving shipped, CI-green code **that no gate had ever seen**. A naive resume would have re-implemented it or had the gate review a report instead of the code | Process gap — **previously unrecorded**. Fix: after any infra halt, check whether the dead agent committed/pushed BEFORE resuming, and convert the task to a verify-only rung if it did | 0 wasted tokens. The rewritten verify-only rung re-derived G12 by hand, found no defect, and correctly **changed nothing** — a zero diff as a declared valid success |
| 2026-08-14 | Plan 06 T4: pipeline A's stalled coder left an unexplained LOCAL commit (`09f4ae0`) one ahead of origin; its replacement had to investigate it under tripwire 8 (never infer who did what) before proceeding | Same root cause as the row above — a dead agent's committed work outliving its report | A round of avoidable investigation; absorbed, no retry |
| 2026-08-14 | Plan 06 T5's brief asserted **no `.env` exists** on the server; `apps/core/.env` does exist (12 keys). My scout looked and reported none | Compile defect §3.20 recurring — **mine**, claiming exhaustiveness about a host environment I had not fully inspected | 0 tokens. Harmless (process.env wins over dotenv, the inline DATABASE_URL worked as briefed) and the coder disclosed it rather than adapting silently |
| 2026-08-14 | Plan 06 T8's acceptance criterion said "the four validation codes → 400"; the plan lists **five** | Compile defect — **mine**, a miscount in a criterion | 0 tokens. The coder typed the plan's five, verified they reconcile against all 22 codes with no gaps, and flagged my number — the §5 disclose-don't-work-around habit paying off a fifth time |
| 2026-08-14 | Plan 06 main session wrote the baseline verify's scratch files to `/tmp` (tripwire 3 — the rule it pastes into every brief), and later piped `git pull --rebase` into `tail`, masking a real failure behind tail's exit 0 (tripwire 16) | §226 recurring, instances **six and seven**. Both by the session that maintains this file | 0 tokens; caught only by reading output rather than assuming. Files removed, tree verified clean, pull re-run unpiped |

| 2026-08-14 | Plan 06.1 T6: a network outage (`ENOTFOUND`) killed the coder **after it had committed and pushed `c339765`**. The infra rung re-ran at the same tier, found the task's exact commit already on origin/main with exactly its three files, converted itself to a verify-only audit, re-derived both Assertion Book entries by hand, and **changed nothing** | Infrastructure. **The Plan 06 §7.4 rule firing on its first real use** — check whether the dead agent pushed BEFORE resuming | ~85k (the replacement rung). The dead agent's 103k was **not** wasted: that code shipped and is CI-green |
| 2026-08-14 | Plan 06.1 T6: three harness stalls on the replacement agent (607 s, 470 s, 219 s) | Host/harness | 0 extra tokens, ~22 min of that agent's ~30 min wall clock |
| 2026-08-14 | Plan 06.1: Plan 06's stated prevention ("the isolation requirement now lives in the gate prompt") had never been applied to `~/.claude/skills/execute/SKILL.md` | Template defect §2.7 — **previously unrecorded**; a lesson that existed only as prose in this file | 0 tokens. Found by grepping the template instead of trusting the entry, and landed before pipeline A fired |
| 2026-08-14 | Plan 06.1 T6: the compiled fail-first criterion ("manifest test observed RED before g14 existed") became unsatisfiable once the outage forced a verify-only rung; the agent declared the gap rather than fabricating it and the gate passed on the mutant walk | Compile defect §2.8 — **mine**; §2.3's shape a third time | 0 tokens. Correct behaviour by both agents; the criterion was the defect |
| 2026-08-14 | Plan 06.1: the plan's per-file count table said `contest.test` 15 (really 10) and `tariff.e2e` 7 (really 6), while every workspace rung was exact. T4's coder caught the first and refused to pad; I caught the second by measuring every suite before compiling pipeline B, so T7's unsatisfiable "9 tests" criterion never reached an agent | Authoring + compile defect §2.9 — **previously unrecorded**; §2.6 one level finer | 0 tokens of retry. The pre-B measurement pass paying for itself, as in Plans 05 and 06 |
| 2026-08-14 | Plan 06.1 T1: the plan prescribed 15 isolated pre-fix race runs and expected a red; the window opened **1 in 45**. The coder ran 30 more rather than declare the evidence unobtainable or manufacture a red state | Authoring defect §3.22 — **previously unrecorded** | 0 tokens of retry, absorbed inside the original attempt |
| 2026-08-14 | Plan 06.1 T3: the fail-first test file imported a function its own Step 3 creates, so the pre-fix run failed to TYPECHECK rather than failing on the defect; the coder staged down its own in-progress file to get a semantically informative red | Authoring defect §3.23 — **previously unrecorded** | 0 tokens, disclosed and gate-ratified |

| 2026-08-15 | **Plan 06.1's post-ship audit found 2 CRITICALs, 4 MODERATEs and 11 MINORs in a plan that had passed 7/7 with zero gate rejections** — a non-monotonic id generator under a "deterministic" ordering fix (§3.26), a race test that cannot see whether its own lock exists (§3.25), a guard positioned after the write it authorizes (§3.27), and an Assertion Book whose claimed kills are wrong in both directions when executed (§3.24) | The gate report's own §6 predicted exactly this: *"a zero-catch run is not proof the gates were sharp — it means they were never seriously tested"* | ~493k tokens (2 opus auditors + 1 scout). **The highest-yield tokens spent in the project so far**: two CRITICALs in the money path, found before Plan 08 was authored against them |
| 2026-08-15 | Two audit agents running concurrently corrupted each other's test measurements through shared `JEST_WORKER_ID` databases | Process defect §2.10 — **previously unrecorded** | ~2 lost experiment rounds, re-run; no wrong conclusion shipped |

| 2026-08-15 | **Plan 06.2 T2: the CRITICAL A2 fix was itself non-discriminating.** The plan's contention test held the serializer's own set-lock statement, whose predicate covers the target version's own row — which `activateVersion`'s single-winner UPDATE must lock anyway — so the serializer-deleted mutant blocked too and SURVIVED 5/5. The coder halted and refused to commit; the gate reproduced SURVIVED 3/3, ruled it a plan defect, and the retry moved the held row to a second version. Mutant A then DIED 5/5 | Authoring defect §3.28 — **previously unrecorded**; §3.21/§3.25's family, third variant. Found by an EXECUTED mutant, which is the entire point of the plan | ~185k tokens (gate rejection + retry coder + second gate). **The catch of the run and worth every token** — the alternative was shipping a second blind A2 test and needing a Plan 06.3 |
| 2026-08-15 | Plan 06.2's brief said "a required-DIED mutant that SURVIVES is a CHAIN HALT" with no branch for *the plan's TEST is wrong* vs *the shipped CODE is wrong*; T2's only file was the test, so the fix was in-scope all along and the halt cost a round trip | Compile defect §2.12 — **mine**. §2.3's family: a rule correct in one direction, unconditional in both | folded into the ~185k above; the rule still fired in the correct direction |
| 2026-08-15 | Plan 06.2 `gate:t6#1` died on `API Error: ENOTFOUND` after 733 s. The ladder re-judged the SAME coder report with a fresh gate, no coder re-run, no tier promotion; T6 had already pushed before the gate started, so the §7.4 hazard never arose | Infrastructure. **§2.1 working, fourth consecutive plan** | 71,695 tokens, no code, no damage. ~72k of the 0.3–0.5M contingency consumed |
| 2026-08-15 | Plan 06.2: two gate agents left `.gate-verify.log` / `.gate-verify.exit` scratch in `/opt/hmis`, and the halted T2 attempt's `.plan-06-2-t2-halt/` directory (18 files) survived the whole run because four later agents each correctly judged it "not mine to clean" | Prevention debt — tripwire 4 is written at coders and the **gate prompt never repeats it**; and a halt directory has no owner | 0 tokens. Fix: add tripwire 4 to the gate prompt; the main session clears halt residue after reading the report |

| 2026-08-15 | Plan 07 T2: the plan's D8 header said **seventeen** P1 event names, its own bullet list contained **eighteen**, and `events.ts` needs **19** `defineEvent` calls (18 + `qr.signature_failed`). The coder disclosed the discrepancy and shipped the correct 19 rather than deleting an event to hit the stated number | Authoring defect — a count stated in prose contradicting the plan's own list, §2.9's family applied to a catalog instead of a test count | 0 tokens, no retry. **The §5 disclose-don't-work-around habit paying off an eighth time.** Corrected in four prose spots before pipeline B; one stale "seventeen" deliberately left in T2's code block because it matches the shipped source comment and `events.ts` is frozen |
| 2026-08-15 | Plan 07 T3: **verify-by-execution flag ③ FALSIFIED** — the plan claimed drizzle's `Tx` is NOT assignable to `Db`. It IS. T3 probed it and then added a deliberate type error to prove the probe file was actually in `tsc`'s scope before trusting the negative result | Authoring defect caught exactly as designed — the plan pre-authorised either outcome ("the Db-first/`…InTx` split holds either way"), so the split shipped unchanged | 0 tokens, no retry. **Recorded because later briefs must not repeat the claim as fact.** The probe-the-probe move is the right pattern for any negative typecheck result |
| 2026-08-15 | Plan 07 T3 built `registration.mutantD.ts` inside `modules/patients/` — a FROZEN directory — because the mutant block says "beside the source". Never committed, deleted before counting, tree clean | Compile defect §2.14 — **previously unrecorded**; two rules in the same brief contradicting each other | 0 tokens. Resolved by stating that frozen-path rules govern COMMITTED changes only; the next agent could as easily have resolved it by skipping the mutant |
| 2026-08-15 | Plan 07 T6's coder skipped fail-first entirely under the §2.8 fallback, reading four dead session-limit rungs as "a prior attempt already shipped the artifact" — but they shipped nothing, so the precondition was false and fail-first was owed. The gate discharged the fallback itself (rows re-derived, three mutants rebuilt); no remediation was possible without rewriting pushed history | Compile defect §2.13 — **mine**; §2.8's own escape hatch with an unauditable trigger condition | 0 tokens. Fix: the fallback may be invoked only by NAMING THE COMMIT that contains the artifact |
| 2026-08-15 | Plan 07 T6: the acceptance criterion claimed test 5 proved the state move precedes the vitals insert. The gate built an unrequested **Mutant V4** (insert moved first) and it **SURVIVED** — both bodies run in one `withTx`, so the zero-rows result comes from the transaction, not the ordering. The shipped order is correct and simply not observable | Authoring defect §3.29 — **previously unrecorded**; §3.14c applied to a CRITERION rather than a test | 0 tokens, task passed. **The catch of pipeline A, and it came from a mutant nobody asked for** |
| 2026-08-15 | Plan 07 T6: four consecutive rungs killed by the session usage limit, plus ~1 h of wall clock waiting for the reset | Host/harness failure — prevention debt, no code produced | **59,170 tokens** and ~1 h. The ladder did not promote the tier or consume a defect attempt (§2.1 holding, fifth consecutive plan) |
| 2026-08-17 | The T6 gate's V4 discovery had **nowhere structured to live**: `VERDICT_SCHEMA` has no field for a finding that does not fail the task, so it survived only as prose buried in a `tests.ran` string and was nearly lost | Template defect §2.7's family — **previously unrecorded**. A pipeline that can only record violations silently discards everything else its gates learn | 0 tokens. Fixed before compiling B: optional `findings[]` on the verdict, a `gatePrompt` clause telling gates to use it, **and the report-assembly line that propagates it** — the schema addition alone would still have dropped it on the floor at `results[t.id]` |
| 2026-08-17 | The main session wrote its detached server-pull scratch to **`/tmp`** — tripwire 3, the rule it pastes verbatim into every brief | §344 recurring, instance **eight**, again by the session that maintains this file | 0 tokens; files removed immediately, server tree confirmed clean. Recorded because the count itself is the finding: eight instances means the tripwire block is genuinely not part of the main session's own habits, and no amount of writing it down for agents has changed that |

| 2026-08-18 | Plan 07 pipeline B's FIRST launch died in 140 ms with `AGENT_FOR is not defined`: compiling by splicing head + new TASKS + tail dropped the one-line `AGENT_FOR` constant that sat in the seam. `node --check` passed (it is a ReferenceError, not a syntax error) and the brief-render harness passed (it only evaluated the file's head region, never `runTask`) | Compile defect §2.15 — **mine, previously unrecorded**. A pre-flight that does not RUN the code path cannot vouch for it | 0 tokens, 0 agents, ~2 min. The dependency edges worked perfectly — T8/T9/T10 skipped rather than running against a broken T7. Fixed by a dry-run harness that executes the whole script with stubbed hooks and asserts 4/4 `done`; the same harness confirmed the new `findings` field propagates end-to-end |

**Plan 07 pipeline A totals (T1–T6): 16 pipeline agents (12 completed, 4 killed by the session usage limit) + 1 pre-compile measurement scout, 2,086,381 subagent tokens (pipeline 2,031,710 / scout 54,671), ~4h01m of wall clock across six sequential tasks.** **6 of 6 tasks passed on the first rung — zero gate rejections**, the second plan in the series with none. Verify went 69 suites/396 tests → **84/483** in `apps/core`; contracts 3/7 and web 11/37 untouched; CI green on all six commits matched by SHA; exactly one migration (`0010_silent_victor_mancha`), in T1, as specified; frozen paths byte-untouched; zero residue. Per task including its gate: T1 213,941 · T2 285,662 · T3 359,655 · T4 398,045 · T5 348,418 · T6 366,819 — **mean 329k**, ~10% above the plan's 300k backend estimate and well above 06.2's 246k. The rise is real work, not waste: twelve tables, two concurrency cores and 25 Assertion Book rows with their mutants.
| 2026-08-17 | Plan 07 T10 rung 1: the plan's `boardSnapshot` perf budget of **300 ms** is unachievable — it held isolated (median 250) and broke under full-suite parallel load (median 310). The gate measured 1 failure in 3 full runs on an 8-core host faster than a typical CI runner, rejected the task, and issued five precise corrections; the retry raised the ceiling to 500 ms with the measured distribution and changed nothing else | Authoring defect §15 — a CI-enforced perf ceiling authored from an ISOLATED measurement and then enforced under parallel load, the second plan running where this has happened | **~475k tokens** (rung-1 coder + gate + retry). A genuine catch and worth paying for: the alternative was a permanently flaky CI gate |
| 2026-08-17 | Plan 07 T10: `gate:t10#2` died on `API Error: ENOTFOUND` after consuming 92,440 tokens, and its three infra retries died immediately at 0 tokens each. MAX_INFRA exhausted ⇒ T10 returned `failed: infrastructure: gate unavailable` — **with its retry commit `2b7c436` already pushed and never reviewed**. The main session detected the §7.4 hazard from the run's own logs, confirmed the push, and dispatched a standalone gate that PASSED it 13/13 | Infrastructure. **§2.1's ladder working correctly** — no tier promotion, no defect attempt consumed, no coder re-run — and Plan 06 §7.4 (check whether the dead agent pushed before resuming) firing on its second real use | 92,440 wasted + 97,033 for the replacement gate. No code lost, no work redone |
| 2026-08-17 | Plan 07 T8→T9: the realtime tail's shutdown race shipped DORMANT in T8 (poll() early-returns before any pool access when no router is registered) and was ARMED by T9's router registration in all fourteen AppModule e2e suites. T9's own commit `f84f1b1` went **CI-RED** (`Cannot use a pool after calling end on the pool`, all 524 tests passing, the suite failing at teardown); T10's retry lost 1 of 5 verify runs to it in a different suite | Process defect §2.16 — **previously unrecorded**. Both gates flagged it and T9's gate explicitly asked for a follow-up before T10; the recommendation had no owner and evaporated | 0 tokens inside the pipeline, but one red CI commit, ~1-in-5 verify noise for two tasks, and a whole remediation task afterwards. §3.2's shape one level out: a frozen file orphaned the fix, not just the step |
| 2026-08-18 | Plan 07: `vitals.test.ts` went deterministically RED at 00:00 UTC (`ageYearsAtRecord` 30→29, 3→2) because `registerPatient` derives `dob` from the wall clock. T7's gate PREDICTED it 4.5 h in advance, computed the detonation time, and the T7 coder had already immunised its own suite — and still nothing acted on it until the main session found it post-pipeline | Authoring defect §3.31 — **previously unrecorded**; §2.16 again, a warning routed to nobody | 0 tokens inside the pipeline; folded into R1. Notable as a defect that no green pipeline and no green CI could have surfaced, because it was *scheduled* |
| 2026-08-17 | Plan 07 T7: **verify-by-execution flag ⑪ FALSIFIED in its second half.** The flag claims `.for("update")` "compiles AND serializes"; the gate rebuilt Mutant P1 and the version race SURVIVED **10/10**, independently reproducing the coder's 0/20. Correctness rests on the unique index on `(encounter_id, version)`, not on the lock | Authoring defect §3.30 — **previously unrecorded**; §3.29 one level out, and a worse hiding place because a flag reads as audited once its owning task passes | 0 tokens, task passed. Found only because the gate rebuilt a mutant rather than accepting a reported number — and recorded only because the verdict schema now HAS a `findings` field |
| 2026-08-18 | Plan 07 R1: the acceptance criterion prescribed capturing an unhandled rejection with "an installed-and-removed process listener". `jest-environment-node` SANDBOXES `process`, so the listener is inert; the coder proved it with a throwaway probe (0 deliveries, listenerCount 1) and moved the load-bearing capture to a gated `Db` wrapper at the source | Compile defect §2.17 — **mine, previously unrecorded**. §3.20's shape applied to an INSTRUCTION rather than a fact | 0 tokens, no retry. Prescribing an inert mechanism is worse than prescribing none: a less careful agent satisfies it literally and ships a test that observes nothing |
| 2026-08-18 | The main session left its own scratch (`.mainv.sh/.log/.exit`) in `/opt/hmis` after a baseline measurement — tripwire 4. The prescribed FINISH uses `git add -A`, so R1's coder would have swept them into its commit and broken its own exactly-three-files criterion. The coder found them, deleted them, and disclosed it **without inferring who created them** (tripwire 8 honoured) | §344 recurring, instance **nine**, and the second main-session scratch failure in one session (the `/tmp` breach was instance eight) | 0 tokens; caught by an agent, not by me. Recorded because it nearly corrupted a commit whose whole point was a three-file diff |

**Plan 07 pipeline B totals (T7–T10): 13 pipeline agents (9 completed, 4 killed by one ENOTFOUND window) + 1 pre-compile scout + 1 standalone replacement gate, 1,920,199 subagent tokens (pipeline 1,717,187 / scout 105,979 / replacement gate 97,033), ~4h05m of pipeline wall clock.** **3 of 4 tasks passed on the first rung**; T10 took two rungs and the extra one was a genuine gate catch. Per task including its gates: T7 392,330 · T8 335,074 · T9 422,482 · T10 567,301 — **mean 429k**, up sharply from pipeline A's 329k, and the rise is concentrated entirely in T10 (a rejection plus a dead-gate window). Verify went 84 suites/483 tests → **93/535** in `apps/core`, exactly the plan's ladder target at every rung; contracts 3/7 and web 11/37 untouched; exactly one migration for the whole plan (`0010`, T1) with `drizzle/` byte-untouched across all of B; frozen paths clean across the entire range; zero residue.
**Remediation R1** (owner-authorized, outside every Files list): 2 agents, **229,003 tokens**, ~47 min, passed first rung, three files, `apps/core` → 93/536. It closed both defects the gates had surfaced and nobody owned.
**Session total 2,149,202 tokens; Plan 07 to date ≈ 4.24M of a 5.2–6.8M budget with pipeline C (six UI tasks) outstanding** — tracking to the midpoint.
**CI by SHA: six of seven commits green; `f84f1b1` (T9) is red and stays red**, because the defect that reddened it was fixed two commits later — a historical fact worth stating plainly rather than papering over. Every commit from `b378df1` onward is green, including HEAD.
**The headline is that pipeline B produced no code defect a gate rejected on correctness grounds — its one rejection was an unachievable PERF BUDGET the plan authored from an isolated measurement — and that every remaining finding came from a gate building something nobody asked it to build.** T7's gate rebuilt P1 and falsified a flag; T10's gate #1 built a FrameStream mutant and confirmed a criterion that *is* genuinely proven; R1's gate rebuilt the pre-fix tail and killed it. **The `findings` field added to the verdict schema before this pipeline fired is what let four of those survive into the report instead of dying in a transcript** — it was added because the T6 gate's V4 discovery nearly did, and it repaid the change on its first run.

**Every one of pipeline A's five findings was a PREDICTION that execution falsified** — a catalog count, a type-assignability claim, a fail-first precondition, a criterion's causal claim, and a frozen-path rule that could not be obeyed as written. None was a code defect; none cost a retry; four of the five were disclosed by coders rather than caught by gates. That is the sixth consecutive plan in which the failure locus sits in what the plan *claimed* rather than in what the coders *built*, and the third in which the sharpest finding came from building the wrong implementation and watching it pass.

**Plan 06.2 totals: 15 pipeline agents (14 completed, 1 killed by ENOTFOUND) + 1 pre-compile measurement scout, 1,531,628 subagent tokens (pipeline 1,478,505 / scout 53,123), 3h10m35s of pipeline wall clock across six sequential tasks.** **5 of 6 tasks passed on the first rung; the single rejection (T2) was a genuine plan defect.** Verify went 68 suites/383 tests → **69/396** in `apps/core`; contracts 3/7 and web 11/37 unchanged; CI green on all six commits matched by SHA; frozen paths byte-untouched across the whole range with `modules/tariff/index.ts` byte-identical and all 14 golden fixtures unchanged; exactly one migration (`0009_huge_joshua_kane`), in T1, as specified. **Zero harness stalls — the first pipeline in the series with none.** Calibration was 1.4–2.1M / 2.5–3.5h; actual **1.53M and 3h11m — inside both bands, ~7% under the stated midpoint, the second consecutive plan to land inside its own estimate.** Per task including its gate: 181k–368k, mean 246k, up from 06.1's 204k — the rise is the mandatory mutant builds, which the plan predicted at 10–20% on the heavier tasks and which cost about that.

**The executed-mutant rule was tested on its first run and it fired.** Plan 06.1 passed 7/7 with zero gate catches and a post-ship audit then found two CRITICALs in it; §3.24 concluded that a hand-performed discrimination audit is a prediction. Plan 06.2 made every named mutant a build-and-run obligation — and the very first CRITICAL fix it applied that rule to, the A2 replacement, rested on a **false prediction that two authoring passes, a stress pass and my compile review all read as sound** (§3.28). Nineteen Assertion Book rows, nineteen executed verdicts; eleven of the mutants were independently rebuilt by gates rather than accepted from a report. **But "19/19 executed" is not "19/19 killed":** one required-DIED row died only after its test was corrected, and K2 SURVIVED 10/10 by design — the plan authorised that in advance, the coder measured it instead of engineering a kill, and the gate reproduced it. Those two facts are now written down as measurements rather than assumed away, which is the whole value of the Book. **The pairing that produced the catch: a coder briefed to disclose plan defects rather than work around them (it halted a chain instead of quietly tuning a lock statement until the mutant died — the failure mode that would have hidden this forever), and gates that rebuild mutants instead of reading about them.**

**The failure locus stayed off the code, and the remaining cost is now almost entirely the plan's own predictions.** Plan 06 produced one code defect and five process failures; Plan 06.1 produced no code defect that reached a gate; Plan 06.2 produced **no code defect at all** — its one rejection was an authoring defect in a *test*, its other findings were a compile defect of mine and one outage. Three plans running, the thing that breaks is a claim about what a wrong implementation would do. Tripwire 21 is the only instrument that has ever caught one.

**Plan 06.1 totals: 15 pipeline agents (14 completed, 1 killed by a network outage), 1,429,168 subagent tokens (pipeline A 784,339 / pipeline B 644,829), ~3h16m of pipeline wall clock across seven tasks.** **7 of 7 tasks passed on the first rung — zero gate rejections, the first plan in the series with none.** Verify went 68 suites/360 tests → **68/383** in `apps/core`; CI green on all seven commits; frozen paths byte-untouched across the whole range (only `g09` changed and only `g14` was added among fourteen fixtures); exactly one migration, in T1, as specified; lint stayed at zero problems.

**The calibration was 1.3–1.9M and the actual was 1.43M — inside the band, 5% under the stated midpoint, after Plan 05 ran 42% over and Plan 06 ran 56–76% over.** The difference was not luck: an outage and three stalls still happened. It is that **Plan 06's instruction to budget an explicit infrastructure contingency rather than hope stalls away was actually applied** — 0.3–0.5M reserved, ~85k consumed. Two plans of overrun ended the moment the estimate stopped pretending the harness is reliable. Per task including its gate: 165k–278k, mean 204k, against Plan 06's observed 130–200k clean-task rate.

**Zero gate catches is the headline and also the thing to be careful about.** Three things earned it: the Assertion Book did the gate's hardest work at authoring time (every assertion arrived with its derivation *and* its named killing mutant already computed, so the §3.14 class had no room to form); the plan's own defects were caught by **coders** who were briefed to disclose plan defects rather than work around them (§2.9, §3.22, §3.23 all came from coders or from the pre-compile measurement, never from a gate); and the pre-B measurement pass killed the one erratum that would have bitten. But a zero-catch run is not proof the gates were sharp — it means they were never seriously tested. The single place a gate's judgment *was* tested (T6's declared missing fail-first evidence, §2.8) it passed a task with an acknowledged evidence gap. That was the right call against the alternative of fabrication, and it is recorded here precisely so a clean scoreboard does not bury it.

**The failure locus moved again, and this time it left the code entirely.** Plan 06 produced one code defect and five process failures. Plan 06.1 produced **no code defect that reached a gate at all** — its five findings are two of mine (a compile criterion, a count erratum), two of the plan's (a run budget, a fail-first ordering), and one infrastructure outage. Four of the five cost nothing, because they surfaced through disclosure rather than through failure. **The §5 "report a plan defect instead of silently working around it" habit is now, on this evidence, the highest-yield line in this file after the tripwire block itself: it has converted authoring defects into ledger entries at zero retry cost in six consecutive plans.**

**Plan 06 totals: 26 pipeline agents + 3 scouts, 2,788,668 subagent tokens (pipeline A 1,738,375 / pipeline B halted launch 134,257 / pipeline B 773,451 / scouts 142,585), ~6h29m of pipeline wall clock across ten tasks.** **9 of 10 tasks passed on the first attempt**; the single retry (T4) was a genuine gate catch. Verify went 54 suites/269 tests → **68/360** in `apps/core`; CI green on all eleven commits; frozen paths byte-untouched across the whole plan; exactly one migration, in T1, as specified; lint stayed at zero problems throughout.

**The calibration was 1.5–1.7M and the actual was ~56–76% over — but almost none of the overrun was work.** ~420k went to three harness stalls, ~134k to a network outage, ~175k to the one genuine gate catch. Strip the stalls and the outage and the run lands near 2.09M, ~25% over. **The per-task model is sound** — a clean task cost 130–200k including its gate, against the ~160k Plan 04 baseline the estimate was built on. What the estimate did not model is infrastructure failure, and on this evidence that is now the largest single line item in a pipeline's budget. **Budget future plans at the clean-task rate plus an explicit infrastructure contingency, rather than pretending stalls are rare.**

**The shape of failure moved again, and this time it moved off the code entirely.** Plan 03's defects were in test code; Plan 04's in the plan's own code blocks; Plan 05's split between plan defects and my compile defects. Plan 06 produced **exactly one code-level defect in ten tasks** (§3.21) — and five process failures that between them cost more than three times as much as that defect did. The engine, the golden suite, the 17-route surface and the lifecycle proof all landed first-attempt. **The bottleneck is no longer the quality of the plan or the coders; it is the reliability of the harness and the discipline of the verification chain.**

**Two things held that were designed to hold, and both deserve to be named.** First, **§2.1's ladder fix** did its job under real infrastructure failure: four dead agents in a row produced a clean halt with no tier promotion and no consumed defect attempt, and the dependency edges stopped T8–T10 from running against an unfinished T7. Second, **the §3.14 golden-suite guarantee survived contact with execution** — thirteen fixtures, every expected value hand-derived from the plan's Fixture Book, both gates re-deriving samples by hand, an inline mutant proving the harness kills a no-exemption implementation, and **no halt event needed because engine and Book agreed everywhere**. The halt rule was armed the entire time; T7's verify-only rung re-derived G12 by hand rather than by re-running the engine and said so explicitly. A guarantee that is never tested is a guarantee nobody can trust; this one was tested by construction at every gate.

**The stress pass paid for itself a second time, and more clearly than in Plan 05.** Before compiling pipeline B, a scout verified every surface B consumed against what A had **actually committed** rather than what the plan predicted, and four brief-level defects were fixed before firing: an acceptance criterion that was **literally unreachable** (T10's `ok:true` requires all four D-8 caps seeded, which the plan's setup did not say), the g12 sort-order trap (the gap is in the middle, not the tail), a harness variant that would have failed the TypeScript build without a matching branch, and an error-code set I had assumed closed that is open by construction. None cost a retry, because none reached an agent.

**Plan 04 totals: 17 agents, 1,278,905 subagent tokens (pipeline A 607,273 / pipeline B 627,309 / signature scout 44,323), ~1h47m of pipeline wall clock across eight tasks.** Zero infrastructure failures. Zero retries — **8/8 first-attempt gate passes, the first plan in the series with no retry of any kind.** The plan's ~1.3M calibration was accurate to within 2%.

**The shape of failure moved again, and it is worth naming.** Plan 02's defects were in implementation; Plan 03's were all three in *test* code; Plan 04's three were also all in the plan's own code blocks (§3.12 a helper's SQL, §5.2 an implementation signature that does not compile, §3.13 a flaky assertion) — but **none of them reached the gate.** Every one was caught, fixed minimally, and disclosed inside the *original* attempt by a coder briefed to report plan defects rather than work around them. That is the §5 habit converting authoring defects into ledger entries at zero retry cost, and it is now the single highest-yield thing in this file after the tripwire block itself.

**The one new hazard: evidence you did not actually measure.** Tripwire 16 exists because `pnpm verify | tail -N` reports *tail's* exit status — a silent false PASS — and `| head -N` reports a false FAIL via SIGPIPE. It was found the harmless way (a false fail) but the same construct had already appeared in the **main session's own** first verification of the session. A verification ritual that can silently certify a failing build is worse than no ritual.

**Plan 05 pipeline A totals: 16 agents, 1,315,927 subagent tokens, ~2h46m wall clock across six sequential tasks.** Zero infrastructure failures of the API-529 kind; one harness permission block (T6 retry). **5 of 6 tasks passed on the first attempt**; T6 took three, of which one rung was a genuine gate catch worth paying for (§3.14) and one was forced by the permission block. Verify went 45 suites / 208 tests → 53 / 256; CI green on all seven commits; frozen paths untouched; exactly one migration generated, in T1, as specified.

**The shape of failure moved again, and this time it moved onto ME.** Plan 03's defects were in the plan's test code; Plan 04's were in its own code blocks but caught inside the original attempt; Plan 05 pipeline A produced **three plan defects and two compile defects, and the compile defects were both mine** — a criterion pinned to a jest path regex the task's own file would match (§2.5), and a stale baseline SHA repeated in six briefs (§2.6). Neither cost a retry, but both made correct agents spend tokens proving they were correct. The ledger has been auditing plan-authoring for four plans; **the compile step had never been audited at all, because the main session writes the briefs and then reads the reports about them.** Both new entries exist to close that loop.

**Plan 05 pipeline B totals: 10 agents, 1,027,012 subagent tokens, ~1h39m wall clock across four sequential tasks.** Zero infrastructure failures. **3 of 4 tasks passed on the first attempt**; T10 took two, the extra rung being a genuine gate catch (§3.14b). Verify went 53 suites / 256 tests → 57 / 276; CI green on all five commits; frozen paths untouched; no new migration; lint back to **zero problems** after T7 removed the dead directive §3.15 recorded.

**A stress pass is worth running, and is not a substitute for the gate.** Before compiling pipeline B this session's main loop ran a scout-verified stress pass over T7–T10 and fixed four defects up front — two of them §3.14 fixture defects (a "frozen patients" test name with no frozen assertion; an "unknown patients" name with no unknown assertion), a test count no correct implementation could satisfy, and the carried-forward lint cleanup. **It still missed T10's §3.14b**, and it could not have found T9's §3.17 overload mis-binding, which only a 300 kB request could reveal. The division of labour that actually held: **the stress pass catches what reading can catch, verify-by-execution flags catch what only running can catch, and the gate catches what neither did.** Removing any one of the three would have shipped a defect this pipeline.

**1M-row perf evidence at scale (the plan's required post-pipeline-B measurement — parked here for the Plan 05 gate report).** Same query set and `generate_series` seed shape as T4's CI suite, run once on the server in a suite-managed test database, budgets removed so the run reports rather than gates, nothing committed. Seed: **1,000,000 rows in 13.2 s**. **Phone-prefix search median-of-5: 6.4 ms** (6.4 / 7.0 / 6.2 / 6.3 / 6.4) against the 300 ms CI budget — ~47× headroom. **`getPatient` median-of-5: 1.6 ms** (3.3 / 2.0 / 1.5 / 1.6 / 1.4) against the 100 ms budget — ~62× headroom. Both paths stay index-served at 5× the CI seed size: the phone predicate plans as `Bitmap Heap Scan / BitmapOr / Bitmap Index Scan ×2`, the name predicate as `Index Scan` — **no Seq Scan on `patients` in either**. The 200k CI gate is therefore a floor with room to spare, not a ceiling the design is pressed against.

**A ledger the main session writes for agents but does not apply to ITSELF.** Twice this session the main loop broke a rule already in this file: it read a wrapper's exit status as a command's verdict (which became tripwires 17–18), and it chained `git pull --rebase` ahead of `git commit` in one line — **exactly §3.8**, recorded for a coder in Plan 03 and hit here by the session that wrote it down. Both cost ~nothing, and both were caught only because the output was read carefully rather than assumed. Together with §2.5/§2.6 this is now a pattern with four instances: **the tripwire block is pasted into briefs and never into the main session's own habits.** Read §1 and §3.8 before running the session's own git and verify commands, not just before compiling someone else's.

**Plan 05 pipeline C totals: 14 agents, 1,641,194 subagent tokens, ~2h57m wall clock across six sequential tasks.** Zero infrastructure failures — every dependency range resolved, the shadcn registry answered, and Vite/Vitest ran under pnpm's denied build scripts exactly as flag ⑫ predicted. **5 of 6 tasks passed on the first attempt**; T13 took two, the extra rung being a genuine gate catch (§3.14c). Verify ended green across **three** workspaces: contracts 3 suites/7 tests, apps/web 11 files/37 tests, apps/core 54 suites/269 tests. `apps/core` and `packages/contracts` were byte-untouched for the whole pipeline, and each root file changed in exactly its authorized task's commit.

**PLAN 05 COMPLETE — all 16 tasks, three pipelines: 40 pipeline agents, 3,984,133 subagent tokens, ~7h22m of pipeline wall clock, plus ~365k for six scouts and the 1M-row perf run. 13 of 16 tasks passed first-attempt; all three retries were genuine gate catches, none was process waste.** The plan's own calibration was 2.5–2.8M, so the actual came in **~42% over** — worth recording rather than rounding away. The overrun is concentrated in pipeline C's screen tasks (T15 and T16 cost 229k and 236k against a ~160k/task assumption), which suggests **UI tasks with many small files and stubbed network calls cost meaningfully more than backend tasks with one service and one suite** — calibrate the next UI plan upward rather than repeating this estimate.

**The defect classes across the whole plan, in one line each:** pipeline A produced three plan defects and two compile defects (§2.5, §2.6 — the first audit of the compile step); pipeline B produced an overload mis-binding no reading could catch (§3.17), a prose-vs-assertion contradiction (§3.18), and an unreachable-mechanism assertion (§3.14b); pipeline C produced the sharpest teeth-less assertion yet (§3.14c), a safety rule silently disabled behind a type error (§3.19), and a false exhaustiveness claim in my own brief (§3.20). **Four of the eleven are instances of one class — an assertion that passes for the wrong reason — and it is now unambiguously the thing this project gets wrong most often.**

**Open item carried forward (not fixed, deliberately):** `qr.test.ts` builds its tampered payload as `payload.slice(0, -2) + "xx"`, which only differs from the real base64url HMAC when the signature does not already end in `xx` — roughly **1 CI run in 4096** will see the "tampered" payload verify successfully and fail the suite. The T9 coder found it, judged rewriting another task's shipped assertion out of scope, and flagged it rather than silently changing it — the correct call. It is a §3.13-class latent flake (passes almost always) and should be made deterministic in the next task that legitimately owns `qr.test.ts`.

**Plan 02 totals: ~605k of 2,770,639 subagent tokens (22%) spent on process and infrastructure rather than code.** Pipeline A ~465k of 1,258,193 (37%); pipeline B ~140k of 1,512,446 (9%) — the improvement came from the tripwires being hoisted to the top of every brief, not from luck. Across twelve tasks only **two** retries were genuine code defects (T6's missing `revokeTerminalSessions` assertion, T9's first attempt), which is exactly what the gate exists to catch and worth paying for twice.

**Plan 03 totals: 24 agents, 1,651,636 subagent tokens (pipeline A 767,045 / pipeline B 884,591), ~2h16m of pipeline wall clock across ten tasks.** Zero infrastructure failures — no API 529, no dead agent, nothing skipped. **Zero process-caused retries.** Both of the two retries in ten tasks (T4, T8) were genuine code defects the gate caught, against Plan 02's two-in-twelve. Measured against Plan 02's ~605k of 2.77M (22%) lost to process, Plan 03 lost **~0%**: the only process failure (§2.4's force-push) consumed no extra agent, because it happened inside a retry that was legitimately owed.

**What that improvement was bought with, precisely:** the tripwire block at the top of every brief (Plan 02's finding, applied from task one this time rather than mid-run), the ladder fix that stops infrastructure from advancing the rung, and briefs that point at the committed plan on the server instead of restating its code. Three of those were already in the ledger before this plan started — **the ledger paid for itself in one plan.**

**The new shape of failure: Plan 03's implementation code was defect-free, and all three of its defects were in its TEST code** (§3.9 a flag discharged in the wrong task, §3.10 a derived fixture the plan's own validator rejects, §3.11 an assertion that can never pass). Plan 02's lesson was to run the implementation before believing it; Plan 03's is that **a plan's test blocks get less scrutiny than its implementation blocks and need the same verify-by-execution treatment** — they typecheck, they read plausibly, and two of these three were unsatisfiable against a correct implementation.

**The two lessons this ledger most wants its next reader to absorb:** a rule that is written down but buried still gets broken (§1 exists as a *top-of-brief block* for that reason), and a fix that lands after a pipeline is compiled does not protect that pipeline (T12 hit the 529 bug ~4 hours after it was fixed). When a template fix lands mid-run, patch the persisted script and resume rather than letting the run finish on the old ladder.

---

| 2026-08-18 | Plan 07 pipeline C's FIRST launch was rejected in milliseconds with `Identifier 'brief' has already been declared`: re-cutting pipeline B's shared blocks took three lines too many and carried the head of `brief()` into the `finish()` fragment, so the script declared it twice. **`node --check` passed** (sloppy script mode allows a duplicate top-level function declaration) **and the §2.15 dry-run passed 6/6 with 114 content assertions** (the later declaration silently wins, and it was the correct one, so all six rendered briefs were right) | Compile defect §2.18 — **the converse of §2.15**: a pre-flight running the code in a different PARSE MODE than the harness cannot vouch for it | **0 tokens.** Caught before any agent ran. A module-parse probe now exists and was proved to discriminate by appending a duplicate and watching it fail; its first version was inert |
| 2026-08-18 | Pipeline B's `HALTS` block was defined and **never referenced by `brief()`** — B's four agents received the halt conditions only through scattered inline mentions in their own task bodies. Found while reusing B's script to compile C | Compile defect §2.19 — §2.7 one level down: the prevention was in the SCRIPT but not in the ARTIFACT the agent reads | **0 tokens, no known harm.** C's dry-run now asserts each block's marker text appears in every RENDERED brief |
| 2026-08-18 | Plan 07 T14: the coder stubbed the vitals success as `status: 200` with the comment *"Nest's real 201 — the harness never branches on the exact 2xx code"*. `stubFetch` can only ever answer 200, and 20 of the module's 21 POSTs return 201, so a screen branching on `res.status === 200` would pass every test and fail in production. The gate rejected the **comment as a prediction**, re-ran the spec against a genuine 201 itself, and required the stub changed | §3.32 — §3.14c pointed at the test harness rather than the application | **Gate rejection, one retry rung.** Landed as `ce2d104`, test file only, 2 insertions / 2 deletions. The brief's own HTTP-status section is what the gate quoted |
| 2026-08-18 | Plan 07 T14: `expect(within(rowAdult).queryByText(/danger/i)).toBeNull()` was asserted against a fixture whose `dangerFlagged` inherited `false`, while a comment claimed both fixtures carried the flag — a vacuous absence assertion. Caught in the same verdict; the gate then rebuilt mutant V4 to prove the fix was non-vacuous rather than reading the diff | §3.33 / §3.14 recurring — the absence half of "hand-check that the fixture separates them" | Included in the T14 rejection above. T16's parallel absence assertion was done RIGHT and a gate mutant proved it |
| 2026-08-18 | Plan 07 T16: the plan requires *"Hindi/English labels both shown"* on the waiting-room display; every label went through a single `t()`, so the TV rendered one language. The gate failed it against the plan text and flagged that `getByRole('button', {name:'Start'})` would stop matching once the button carried both languages | Plan requirement silently dropped — caught by a gate reading the plan, not the diff | **Gate rejection, one retry rung.** Landed as `7705590`. The gate's correction 8 required the coder to *rule on* the no-rooms edge case rather than change behaviour silently — §2.16 working as intended |
| 2026-08-18 | Plan 07 pipeline C: three gate-built mutants nobody asked for **SURVIVED** — `refetchInterval` neutered (T11, the 15 s polling convention is unasserted in all six screens), a stale-age leak (T14, the "falls back to the adult band" criterion is unprovable given the fixture ordering), and three of four consult shortcuts deleted (T15). Code correct in all three; the EVIDENCE was overstated | §3.34 — a convention stated in six briefs creates six implementations and zero tests | **0 tokens beyond the gates' own budget.** All three survived into the gate report via the `findings` field; each has a named one-line fix |
| 2026-08-18 | Plan 07 pipeline C: `${PIPESTATUS[0]}` (tripwire 16's prescribed remedy) is a **bash-ism**, and `/bin/sh` on this host is dash — a detached `setsid nohup sh -c` wrapper dies with `Bad substitution` and destroys the run. Secondary: `pkill -f <vitest path>` matches the SSH command's own command line and kills the session | Tripwire 16's remedy is shell-dependent — previously unrecorded | Negligible tokens; both hit and worked around by agents. **Spawn detached work with explicit `/bin/bash -c`, or write each run's exit code to its own file** |
| 2026-08-18 | Plan 07 T13 found two untracked scratch files (`.web-base.log`, `.web-base.exit`) already in `/opt/hmis` when it started. The mandated finish step is `git add -A`, which would have swept them into the commit and broken the clean-tree criterion | Prevention debt — the FINISH block's `git add -A` is unsafe in a tree any earlier agent may have littered | 0 tokens; the coder deleted them and disclosed it. **The durable fix belongs to the brief: name explicit paths, or require a `git status` check before `git add -A`** |
| 2026-08-18 | Plan 08 pipeline A T1 attempt 1 generated `0011`, let the suite's `migrate()` apply it into all seven per-worker databases, then deleted the file when the attempt unwound — leaving 14 orphan tables, 3 orphan FKs into `patients` and a phantom `__drizzle_migrations` row. **`origin/main` itself went RED on the build host**, with no commit anywhere containing the cause | Template defect §2.20 — a migration is an irreversible host mutation with no rollback path in the ladder | ~934k tokens, 0 of 6 tasks delivered; every remedy the rules allow was simultaneously closed |
| 2026-08-18 | Plan 08 T1 Step 5 paraphrased a Postgres `TRUNCATE` rule into its inverse — the identical fact §3.12 already records from Plan 04 — making the plan's own Step 1 schema and Step 5 truncate requirement mutually unsatisfiable. Proven by execution: the billing statement truncated `invoices` first and the patients statement still failed | Plan-authoring defect §3.35 (§3.12 **recurring**, inverted in the paraphrase) | Inside the ~934k above; requires an owner design ruling before `0011` can be regenerated |
| 2026-08-18 | Plan 08 K1's acceptance criterion demanded the FK-truncate error as its fail-first observable; the design ruling that resolves §3.35 removes the only mechanism that produces it, making the criterion unreachable for the code that must ship | Plan-authoring defect §3.36 (§3.29's shape, reached through a legitimate design choice) | 0 extra tokens — the coder found it and both gates upheld the substitution |
| 2026-08-18 | Plan 08 Assertion Book row K4 named the right mutant with the wrong discriminating instant (`Mar 31 23:59 IST` has UTC calendar date Mar 31, so the UTC-date mutant agrees there); the mutant still dies only because the test file happens to assert the one instant that does discriminate | Plan-authoring defect §3.37 (§3.24 one step earlier — right verdict, wrong stated mechanism) | 0 tokens, found by the T1 gate re-deriving the row by hand |
| 2026-08-18 | Plan 08 pipeline A compile: `node --check` on the `.js` script — the template's prescribed first pre-flight — returned **exit 0 on a genuine syntax error** (raw newline inside a single-quoted string). The same construct in a 3-line file exits 1. The template's top-level `return` is what disables the check | Template defect §2.22 (§2.18's third finding) | 0 tokens — caught by a negative control before launch; the §2.18 module-parse probe was the load-bearing one |
| 2026-08-18 | Plan 08 pipeline A: the compiled brief asserted a baseline measured green minutes earlier, which T1 attempt 1 falsified inside the same run; every later brief carried a false premise stated as fact above the goal | Compile defect §2.21 (§2.6 one level deeper — the *green*, not just the SHA, has a shelf life) | 0 extra tokens; flagged by the T1 gate as a finding |
| 2026-08-18 | Plan 08 pipeline A, **what worked**: `gate:t1#1` died on an API server error and the ladder re-judged the SAME coder report rather than re-running the coder (§2.1 firing correctly, no tier promotion, no defect attempt consumed); and a compile-time wave-stall break stopped T2–T6 from launching against an undelivered T1 | Protections paying for themselves under total failure — §2.23 | Saved roughly a second pipeline's budget; recorded because it is invisible when it works |
| 2026-08-19 | Plan 08 pipeline A run 2: **6/6 done, every task on rung 1** — no retry, no escalation. 12 agents, 2.45M tokens inside a 2.2–2.6M budget. Independent verify exit VALUE 0, `apps/core` 110/665 exactly on the recomputed ladder, all six commits CI-green by SHA, frozen-path audit clean, server tree clean | Ruling R5 + a repaired host + re-measured baselines | The contrast with run 1 (~934k, 0/6) is the entry: run 1 died on a plan defect only execution could find |
| 2026-08-19 | Plan 08's R5 amendment corrected the ladder SECTION but left twelve per-task `Step N: Run to pass` lines and twelve acceptance lines carrying the old counts; four separate gates independently reconciled and reported it | Authoring defect §2.24 — a partial amendment | 0 tokens lost, four findings' worth of words; fixed repo-wide before pipeline B |
| 2026-08-19 | Plan 08 T1's compiled FROZEN-PATH block said `kernel/**` is byte-frozen with exactly two exceptions and 'nothing else in kernel, ever', while T1's own Files list required CREATING two new files inside kernel | Compile defect §2.25 — two hand-maintained lists of one fact | 0 tokens; the gate resolved and recorded it rather than failing the task |
| 2026-08-19 | Plan 08 T2's gate had its first M-B01 mutant die at `TS2532` under `noUncheckedIndexedAccess` — a typecheck error, not an assertion failure. A DIED recorded from that run would have proven nothing | §2.26 — §3.23's shape applied to mutants, where it is more dangerous | 0 tokens; caught by the gate on itself; now a standing evidence rule (quote expected vs received) |
| 2026-08-19 | Plan 08 assigned SQL readers to `settlement.ts` while T2's own purity sweep lists that file as pure — mutually exclusive, and rediscovered once per consuming task (T5, then T6) | Plan-authoring defect §2.27 | 0 tokens; both coders reported it instead of relaxing the purity test, both gates ratified, standing resolution recorded |
| 2026-08-19 | Plan 08 T6's gate rebuilt the M-A1 lock-observation leg with `select ... for update` instead of the shipped `for no key update` and watched it STOP discriminating — same row, same write path, different lock MODE | §3.39 — the fourth member of the §3.21/§3.25/§3.28 family | 0 tokens, unprompted; the deepest finding of the run |

**Plan 07 pipeline C totals (T11–T16): 16 pipeline agents (16 completed, 0 errors, 0 skipped) + 1 pre-compile measurement scout, 3,349,975 subagent tokens (pipeline 3,254,687 / scout 95,288), ~6h06m of wall clock across six sequential tasks, 1,173 tool calls. 6/6 gate-passed, `halted: []`. Two gate rejections (T14, T16), both landing as new follow-up commits. One harness stall (`opus:t13`, no progress at 1032 s) retried the SAME rung with the tier unchanged — §2.1 correct. Zero infrastructure deaths, unlike pipeline A (4 rungs killed by the session usage limit) and pipeline B (4 killed by one ENOTFOUND window), so this is a clean measurement of the work itself.**
**Mutation evidence: 22 mutants built and run — 14 required by the Assertion Book (K39–K52), ALL DIED under two independent builds each, every one rebuilt by its gate rather than accepted from the coder's report; 8 unprompted gate mutants, 5 DIED and 3 SURVIVED. Not one verdict in the pipeline was a hand-walk.**
**CI green on all eight pipeline-C commits, matched by SHA. `pnpm verify` exit 0. Final: `apps/core` 93/536 UNCHANGED and byte-frozen across the whole pipeline, `packages/contracts` 3/7 UNCHANGED, `apps/web` 21 files / 80 tests — every ladder rung hit exactly.**

**PLAN 07 TOTAL: 48 agents + 3 scouts, ≈7.59M subagent tokens, ≈15h wall clock, 16/16 tasks gate-passed, 24 commits, one migration. Against a budgeted 5.2–6.8M this is ~12% above the ceiling, and the entire overrun is pipeline C: budgeted ~1.8M, actual 3.35M — 86% over, against a note that had ALREADY calibrated UI work upward after Plan 05 ran 42% over on the same class.** The honest read is that **web screen tasks cost ~550k each, not 300k** — many small files, stubbed network calls and mutant obligations — and two consecutive plans have now under-predicted them. Budget the next web pipeline at 550k per screen task.

**A caution recorded by three of C's six gates independently: the fail-first evidence in this pipeline was structurally weak.** Every red run quoted was an import-resolution error (`Failed to resolve import "./opd-desk"`, `Tests: no tests`) — real output, honestly produced by a genuine test-first order, and it satisfies the criterion as written. But **zero assertions ran**, so it proves only that the module was absent, never that any assertion discriminates. For new-screen tasks all of the discrimination evidence is carried by the Assertion Book, not the red run. A brief wanting assertion-level red must say so explicitly.


| 2026-08-19 | Plan 08 pipeline B's own compile commit `36592a6` added its pre-flight script under `docs/`, `pnpm lint` failed on it, and T7–T10 each shipped and passed an opus gate with CI **RED** | Template defect §2.33 — the checklist's CI item is unrunnable from the build host (`gh` absent, repo private), so no reviewer has ever actually run it | 0 tokens; four commits CI-red for two days, fixed by `d2d8371`. The billing code was never at fault — **the pipeline broke the build with a file it added to document itself** |
| 2026-08-20 | Plan 08 T10 shipped `daily-close.test.ts` green on the day it was authored; the helper dropped the pinned `now`, and it was `2 failed / 6 passed` the next morning | Authoring defect §3.41 (§3.31 recurring, one level out) | 0 agent tokens; one main-session repair commit (`d2d8371`) |
| 2026-08-20 | Plan 08 D8 promised the consult gate refuses with 409; the code→status mapping lives in a byte-frozen file that no task's Files list names, so it answered 400 | Authoring defect §3.40 — **previously unrecorded**. T10, T11 and T11's checker all behaved correctly and it shipped anyway | ~150k (T11's mechanical check — correctly spent: it found the gap and ruled that no retry could fix it). One ladder rung deliberately **not** spent on an impossible correction |
| 2026-08-20 | Plan 08 pipeline B's T12 mechanical checker wrote its scratch to the build host's `/tmp` | Tripwire 3 breached again — but §2.32, and **not the agent's fault**: `mechanicalPrompt` renders no rules pointer, and the pre-flight's shared-block assertion excludes checks by construction | 0 tokens; the agent removed its own scratch and disclosed it |
| 2026-08-20 | Plan 08 pipeline B: every agent — and the main session — was DENIED permission to `rm -rf` its own local mirror. **Root cause found afterwards: `"Bash(rm -rf *)"` is a standing DENY rule in the owner's `~/.claude/settings.json`** — not classifier caution, and deny beats allow, so no allow rule can re-enable it | Rule 22(f) told every agent to do something the host forbids outright, and each one spent part of its report explaining a failure that was never its fault | 0 tokens, no contamination (local scratch, never git-operated, outside `/opt/hmis`). **FIXED in the artifact, per §2.7:** 22(f) now says leave the mirror alone — the scratchpad directory is auto-deleted with the job — while still requiring plain `rm -f` for server-side scratch. The deny rule was left exactly as the owner wrote it |
| 2026-08-20 | Plan 08 pipeline B: the `Workflow` tool was blocked by the permission classifier, so the main session drove the waves through the Agent tool with the rendered briefs passed by file path | Host/harness. Same briefs, same ladder, same review split; sequencing held by the main session | 0 tokens of rework. Recorded because the resume path — seed the shipped waves, re-run the pre-flight, dispatch by hand — is now a known-good fallback |
| 2026-08-20 | Plan 08 pipeline B discovery review: ONE opus pass over eight commits found two **measured** money defects (a negative `advanceOf` that silently eats the patient's next advance, −10,000p reproduced; an EIE-blind `sumCashTendersPaise` that manufactures a −50,000p variance and locks the cashier out of counter work), a dormant defect keeping seven shipped OPD tests green for a billing reason, a **surviving** mutant on a duplicated fee branch (14/14), a PAN exposure behind a cashier-visible permission, and a silent one-of-N tender match in recon | **§2.31's replacement working exactly as designed** — every one of these is cross-task and structurally invisible to a per-task gate | ~219k tokens, the single highest-value agent of the pipeline. This is the entry that justifies the v2 review split |


| 2026-08-20 | Plan 08 post-pipeline-B: the owner ordered the discovery review's two money defects fixed before pipeline C. `44c8b86` shipped the EIE advance guard + the session cash filter, CRITICAL-tier with 3 mutants (M-E2, the discriminating one, rebuilt from scratch by the gate and killed at the assertion) and a measured race | The method working as designed on a defect the method itself surfaced | ~215k coder + ~131k gate. Both defects had been reproduced by execution before a line was written, so there was nothing to hand-walk |
| 2026-08-20 | That fix's GATE went past its brief and reproduced the IDENTICAL harm through `allocateReceipt`, a writer the Files list never named — on the already-fixed commit: `{ afterAllocate: -50000, nextAdvance: 50000 }`. One invariant, two doors, brief closed one | Authoring defect §3.43 — **mine**, and previously unrecorded. The plan's Task 13 drives the unclosed door | ~182k (the follow-up `7769c4b` + its verification). Avoidable by one grep for every writer of the constrained quantity while writing the Files list |
| 2026-08-20 | Both advance fixes correctly REFUSED to floor `advanceOf` at zero, against the discovery review's own written recommendation, because a floor clamps the negative without stopping the absorption (the next advance recomputes positive and the floor never bites) | Judgement, recorded because the *recommended* fix was the wrong one and only the arithmetic shows it | 0 tokens. The reasoning lives in the source docstring, not only in a report |
| 2026-08-20 | `7769c4b`'s coder hit a conflict between its harness's standing "add a Co-Authored-By trailer" instruction and the brief's "commit message EXACTLY as given" (repo convention: `feat`/`fix` commits carry no trailer). It resolved toward the brief, amended the UNPUSHED commit, and checked `origin/main` immediately before amending | Correct handling of a genuine instruction conflict, disclosed rather than silently chosen. Verified independently: `git branch -r --contains 4f72e98` is empty, so rule 15 held | 0 tokens. Recorded because the next agent will hit the same conflict and should resolve it the same way |

## 5. What is working — do not "improve" these

- **Opus gate per task.** It caught the `/tmp` breach, the local-tree pollution, and a real test gap that four green suites hid. Every one of pipeline A's productive findings came from the gate, not the coder.
- **Criteria attributable to the task itself.** Plan 01 lost an entire pipeline to a criterion asserting a co-tenant stack's health. Plan 02 had zero such failures.
- **Briefs that point at the committed plan** rather than restating its code. The plan is on the server; agents type its exact blocks. No transcription drift appeared in twelve tasks.
- **One task per wave when tasks share files.** Zero merge conflicts across twelve sequential tasks on shared `auth.module.ts` / `guards.ts` / `auth.controller.ts`.
- **Independent main-session verification** (`pnpm verify` + CI observation) after each pipeline, never trusting agent self-reports alone.
- **Landing a template fix BEFORE compiling the next pipeline.** Plan 02 learned this the expensive way (T12 hit the 529 bug four hours after it was fixed, because pipeline B was already compiled). Plan 03 applied it: tripwire 15 and the gate-prompt fix landed between pipelines A and B, so B's briefs carried them. Cost: one extra docs commit. Do this every time.
- **Proving a test has teeth by building a MUTANT, not by mutating the shipped file.** Plan 05's T13 retry had to show its corrected Enter-advance assertion actually kills a wrong implementation. It created a separate `form-kit.mutant.tsx` + its own spec rather than temporarily breaking the real component — and when a `cp` that would have overwritten the shipped `form-kit.tsx` was blocked by the permission classifier, it did **not** route around the block. That is §2.3's manufactured-red-state problem solved properly: a mutant beside the source proves the same thing as a mutant in place, and leaves nothing to restore.
- **Agents that report a plan defect instead of silently working around it.** T9 and T10 each hit an unsatisfiable plan fixture, fixed the minimum, and disclosed exactly what and why — which is how §3.10 and §3.11 exist to be fixed at authoring time. Keep briefing "report it as a plan defect in your interpretations field — do not silently redesign it"; it converts a one-off workaround into a durable authoring lesson.
- **The pre-flight's §2.54 probe, executed rather than asserted.** Plan 09's pre-flight parses the PLAN's own fenced Files lists and compares them to the pipeline script's `files` arrays, per task, both directions. On its first run it caught `appsky/core/.../instruments.test.ts` — one transposed character in a path that resolves nowhere. Under §2.25 the generated frozen block would have FORBIDDEN the correct path and permitted the nonexistent one, and the coder would have obeyed the brief, correctly, while the work did not happen. That is §2.54's own specimen, caught before a brief shipped, by a probe that costs nothing to run. **Keep this probe in every compiled pipeline.**
- **A gate that goes PAST its brief.** `44c8b86`'s reviewer checked every criterion, passed the task — and then probed a writer the Files list never named, reproducing the same money defect one door over (§3.43). A reviewer confined to the brief would have certified a half-fixed invariant, correctly. Budget for the reviewer that asks "where else does this happen?" and record what it finds even when the verdict is pass.

---

## ARCHIVE — entries whose enabling mechanism no longer exists

Run at every phase close under [`../../EXECUTE-METHOD-V3.md`](../../EXECUTE-METHOD-V3.md) §5, no
ruling required. **Entries are struck IN PLACE and listed here rather than physically moved**, and
that is a reading of the rule rather than a liberty with it: briefs, gate reports and plan
documents compiled earlier cite these entries BY NUMBER, and the rule-6 pattern the rule invokes
exists precisely so a reader following a citation finds out what happened instead of finding a gap.
The bodies stay where they are, above, as the record. An entry nobody can attach to a live
mechanism is weight, not memory — but an entry nobody can FIND is worse.

**Third pass: 2026-08-27, Plan 14 close.** One entry archived, one CONSIDERED AND KEPT — and the second half of that is the more useful record, because the archive rule's failure mode is retiring a live rule on the strength of a dead specimen.

- **§2.28** — *"THE SSH TAX: on a remote build host, code NAVIGATION becomes the largest single cost in the pipeline."* *Archived: its enabling mechanism was a build host reached over SSH from a separate authoring machine, and its entire prescription was rule 22's mirror — which [`../../EXECUTE-METHOD-V3.md`](../../EXECUTE-METHOD-V3.md) §8 removed and AGENT-RULES strikes in full at rules 13 and 22(a)–(g). Sessions now read and write `/opt/hmis` natively; the 42-round-trips-per-agent measurement describes a topology nobody can reach. **Its surviving general half — "a process can grow a dominant cost that none of its own instruments measure; break cost down by tool call at least once per plan" — is not lost, it is INSTITUTIONALISED**: v3 §9's context accounting and the `token-audit` skill are that lesson turned into machinery, which is the "a stronger entry absorbed it" clause of the archive rule rather than a repeal.*

- **§2.38 — CONSIDERED AND KEPT.** *"An amendment that leaves its own contradiction standing costs every later agent a paragraph."* Its SPECIMEN is dead — rule 22(f) versus §5 step 0, both struck with the mirror — and on a first pass that reads like an archive candidate. **It is not.** The machinery §2.38 describes is not the mirror; it is any document amended in one clause and left stating the old behaviour in another, and this very phase hit it twice: `errors.ts`'s F5 paragraph still cited `not_in_transit` after M8 removed the code, and the phase document carried a duplicated `### 6.6` heading. Both were fixed in the same commit as the amendment, which is exactly what §2.38 prescribes. **The rule for the archive pass this establishes: archive on the MECHANISM, never on the specimen — a dead example does not make a live rule dead, and the entries most worth keeping are the ones whose specimen aged out first.**

**Second pass: 2026-08-26, Plan 09 close.** One entry, and it is archived because a TOOL appeared, not because a rule was repealed.

- **§2.33** — *"The CI item of the mechanical checklist is UNRUNNABLE from the build host, and four commits shipped CI-red because of it."* *Archived: the enabling mechanism was an unauthenticated build host with no way to ask GitHub anything. [`pipelines/ci-watch-host.sh`](../../pipelines/ci-watch-host.sh) removed it — the repository is public, the unauthenticated API answers over plain `curl`, and §2.91 already amended the claim in place. Plan 09 is the proof it is dead rather than dormant: its gates and its mechanical checker were told to run that script themselves, and they did, per commit, with the exit VALUE read from a file. The successor claim — that job LOGS still need a credential, so a RED is a verdict you report and not one you diagnose — lives in §2.91 and stays live.*

**First pass: 2026-08-24, Plan 11f close.** Both entries below were bought by the two-host
topology — authoring on Windows, evidence on the build host, the tree carried between them by rule
22's mirror. [`../../EXECUTE-METHOD-V3.md`](../../EXECUTE-METHOD-V3.md) §8 moved authoring ONTO the
build host on 2026-08-23, and AGENT-RULES rule 13 and all of rule 22(a)-(g) are struck with it.
There is no mirror to contaminate and no Windows-side write to rewrite line endings, so neither
defect has a mechanism left to recur through. Plan 11f is the first phase executed end-to-end under
the new topology and hit neither.

- **§2.40** — a shared session scratchpad meant each "fresh" mirror pull inherited every earlier
  agent's scratch, and it produced a false accusation of rule-breaking. *Archived: rule 22 is
  struck and there is no mirror. What survives is general and is already stated where it still has
  machinery — a positive observation from a COPY is not evidence about the original, which is
  §2.88's "a leg must read something that is not the thing under test" pointed the other way.*
- **§2.79** — CRLF from Windows-side writes shipped as whole-file rewrites, whose `--stat` is
  indistinguishable from a rewrite of somebody else's work. *Archived: authoring happens on Linux,
  in the checkout. Its second-order lesson — a whole-file diff defeats the per-commit
  `--stat`-against-the-Files-list check — is preserved by that check itself, which every close
  including this one runs.*

### 2.156 — INLINE RECON IS THE CHEAPEST INSTRUMENT IN THE LIGHT LANE, AND RC-2 PRICED IT: ~60k FOR THE ANSWER RC-1 PAID 400k TO GET

**Specimen, two adjacent phases in the same series, same lane, same task count.**

| | RC-1 | RC-2 |
|---|---|---|
| recon | 3 Task-tool agents — web 184k, core 153k, design 63k = **400,000** | inline greps in the main session ≈ **60,000** |
| what recon produced | refuted 2 plan premises, found a live money defect by reading | refuted 2 plan premises (T1, T5), found a live money trap by reading |
| subagent tokens, total | 716,000 | **0** |
| total vs stop-loss | 1.15M / 1.70M (67%) | ~420k / 1.50M (28%) |

**The two recon outcomes are the same class and the price differs by 6.7×.** RC-2's inline recon refuted
`feeQuote` → `previewInvoice` → `priceDraftWithBenefits` (the counter quote already ran the whole
Plan 09 contest — T1 was a one-line door, not a feature) and `loadInstances` never filtering on
`kind` (package v0 was a proof, not a build), and it found the `external_rmp` writer trap. RC-1's
400k bought the equivalent.

**Why the gap is structural rather than luck.** A recon subagent pays its whole context on every
call and cannot share the main session's already-loaded context; it must be *told* what to read,
which is Lever 1 re-billed per agent. Eight targeted greps in the main session cost eight tool
results against a context that is already warm.

**MECHANICAL FORM — the test for which lane recon belongs in:**

> Recon goes to a subagent ONLY when its answer needs more context than it returns. A question
> answerable by `grep -rn <symbol>` and reading one function returns less than it costs to brief an
> agent to find it. **Spawn recon when you need a REPORT (a survey across many files whose
> conclusion is short); grep inline when you need a FACT.** RC-1's three agents answered "what
> exists in web / in core / in the design" — genuinely surveys. RC-2 needed nine facts and greps
> returned all nine.

**Honesty rule 5.2 applies and is stated rather than skirted:** LIGHT moves cost into the main
session, which no session can measure from inside. RC-2's ~420k is *reconstructed* (and its own
measurement is discontinuous — the context refreshed mid-phase). Until the owner runs `/cost`, the
6.7× is suggestive of the mechanism, not a settled number. **What IS settled is the subagent column:
716,000 versus 0, measured on both sides.**

### 2.157 — A CHEAP PHASE WITH AN UNRUN REVIEW LANE IS NOT A CHEAP PHASE; IT IS AN UNPRICED ONE

RC-2 closed at ~28% of stop-loss. **720,000 of the 1,500,000 was the review term, and it was not
spent because the reviewers were never run** — this session was constrained from spawning agents.
Reporting 28% without that sentence attached would be the "cheap phase that shipped a defect"
failure (honesty rule 5.3) in advance of knowing whether it did.

**The base rate is the argument.** Every phase since 09a has had its independent reviewers find a
CRITICAL or MAJOR over a tree that was ALREADY green: 09a two passes, 474,771 tokens, the only
reason the phase was correct; 17a 2 CRITICAL + 12 MAJOR with **3 of pass 1's 5 fixes themselves
defective**; RC-1 pass 1 found 1 CRITICAL + 4 MAJOR against 55 green tests, a died mutant and clean
typecheck/lint, and pass 2 found the M2 fix INCOMPLETE plus a new screen regression. **Green is not
evidence of reviewed; it is the state in which reviewers have historically found the worst defects.**

**MECHANICAL FORM:**

> A phase whose review lane did not run reports its cost as `spent / (stop-loss − review term)`,
> and its CLOSE carries the debt as a NAMED OPEN ITEM in the owner's hands — never as a footnote and
> never silently. **A percentage that flatters by omission is a false record**, which is the same
> failure as a census kept green by making the record false (§2.155-era).
> RC-2's honest line: **~420k of the 780,000 coding term (54%), with the 720,000 review term unspent
> and unrun.**

### 2.158 — WHEN A SUITE IS RED TODAY AND WAS GREEN YESTERDAY WITH NO DIFF BETWEEN, MOVE THE CLOCK BEFORE ELIMINATING ANYTHING ELSE

**Specimen, 2026-09-01.** Five `src/modules/radiology/` suites went red on `main` overnight with no
commit touching that module. Two lanes spent about an hour on it. The RC-2 lane ran four
eliminations and killed four hypotheses cleanly:

| eliminated | how |
|---|---|
| the `maxWorkers: 2` ruling | isolated run red at `-w 7` too — identical 5 suites / 12 tests |
| co-tenancy with other suites | red with only that directory running |
| cross-suite DB leakage | red on a virgin database; the suite truncates per test |
| either lane's uncommitted work | reproduced on two different trees |

**All four were correct and none of them could have found it.** The cause was a CALENDAR BOMB:
`placeOrder` stamps `placed_at = input.placedAt ?? new Date()` — the REAL wall clock — while the
24-hour duplicate window is computed from the test's FICTIONAL `now`. Placements spaced 25 fictional
hours apart agree with reality only while the wall clock sits behind `NOW + seq*25h − 24h`. The
suites' `NOW` is `2026-08-31T06:00Z`; `NOW + 26h` is `2026-09-01T08:00Z`. Green all of 08-31, red
all of 09-01, no diff between.

**THE GAP IS IN THE ELIMINATION METHOD, NOT IN HOW CAREFULLY IT WAS APPLIED.** Every experiment
above held the wall clock constant *by running now*. A calendar bomb reproduces perfectly,
deterministically, in isolation, on a virgin database, at every worker count — it is
indistinguishable from an order-dependence bug to any experiment conducted entirely today.
**"Reproduces deterministically in isolation" feels like it rules out environmental causes and
specifically does not rule out the date.**

**MECHANICAL FORM — one run, and it goes straight there:**

> A suite red today, green yesterday, with `git log -- <that path>` showing nothing in between: **the
> first experiment is to move the clock, not to vary topology.** `faketime`, or re-run with the
> suite's own `NOW` shifted forward a day, BEFORE isolating, before changing worker counts, before
> suspecting a neighbour. If the red moves with the date, it is a clock defect and no amount of
> isolation will show it.

**And the defect class it points at, which is the owning lane's F28 and worth more than the
diagnosis:** *a test that mixes a fictional clock for its assertions with the real clock for its rows
is not deterministic — it is merely not failing yet, and it detonates on whoever runs it next rather
than on whoever wrote it.* Grep for `?? new Date()` in any writer a fixture calls with a fictional
instant; that is where the two clocks meet.

### 2.159 — THE PHASE DOCUMENT BECAME THE EXPENSIVE THING TO READ, AND THE HANDOFF IS WHAT REPLACED IT

**Measured at Plan 18a's close, on the tree as it then stood:**

| a session is told to read | bytes | ~tokens |
|---|---|---|
| `EXECUTION-LESSONS.md` (this file) | 455,200 | **113k** |
| the 18a phase document | 218,327 | **54k** |
| `EXECUTE-METHOD-V3.md` | 49,632 | 12k |
| `AGENT-RULES.md` | 26,563 | 6k |
| **the T5 HANDOFF** | **12,277** | **3k** |
| total if all are opened | 761,999 | **190k**, re-billed on every call |

**§2.148's rule worked and the phase document quietly took its place.** This lane never opened the
ledger — it cited §2.137/§2.138/§2.140/§2.144/§2.151/§2.152 by NUMBER through the phase document and
the handoff, exactly as 9.1 rule 1 asks. But **the phase document is now 54k and growing by roughly
a task per commit**: 18a's grew from ~120k bytes at T5 to 218k by the close, because every task
appends its findings and its verification block to the one file every successor is pointed at.

**THE SESSION THAT EXECUTED T5–T9 WAS SEEDED FROM A 3k HANDOFF AND NEVER READ §0–§4.** It cost 3k
to start work instead of 54k, and nothing was verified less: the handoff named the seams, the traps,
the rulings and the verify discipline, and pointed at §5's own task section and §9.2 for the rest.
That is an **18× reduction in the cost of starting**, on the one read every successor pays.

**MECHANICAL FORM — three parts, and the third is the one that decays:**

1. **Every task boundary in a multi-task phase ends with a HANDOFF**, not with a pointer at the
   phase document. 3–15KB: the state in one paragraph, the commits, the seams the next task builds
   on, the traps, the rulings, the verify commands, the open findings with owners.
2. **The successor's prompt names the handoff FIRST and says which sections of the phase document
   are NOT needed** — 18a's said *"you do NOT need §0–§4"* and the session obeyed it.
3. **Measure the phase document at every close** (`wc -c`) and record it. A phase document over
   ~50k tokens has stopped being a plan a successor reads and become an archive a successor greps —
   and the handoff is what a successor should read instead.

### 2.160 — READING BEAT TESTING AT THE CLOSE, SIX TIMES, AND THE CONTRACT PASS IS THE CHEAPEST INSTRUMENT IN THE SET

**Plan 18a's close found SIX defects after the suite was green — under 3,315 passing tests and
THIRTY mutants of which twenty-eight died. Not one of the six had a failing test.**

| found by | defects | cost |
|---|---|---|
| reading §6's CONTRACT clause by clause against the code | **F39, F40** | **~10 minutes** |
| reading the diff | F42, F43, F41 | ~20 minutes |
| the full workspace verify | F44 (1 of 3,315) | ~45 min of box time |

**What the CONTRACT pass found is the argument.** F39: the envelope item was completed at
ACQUISITION where the contract and DD4 both say PUBLISH — so a doctor's order read DONE while the
study sat unread in the radiologist's queue. F40: the second-factor freshness was re-implemented
alongside the kernel's `secondFactorFresh`, against a module-local 15 minutes, while `AuthGuard`
compared `cfg.secondFactorWindowMinutes` on the same request — two owners of one rule, free to
disagree about a single signature.

**Neither was reachable by any test that existed or that a reasonable author would have written**,
and the reason is the same for both: **every assertion that touched them checked a state where the
correct and incorrect behaviours AGREE.** F39's tests all read the item after a publish; F40's
fixture and the shipped default were both 15.

**MECHANICAL FORM:** a phase whose plan carries a CONTRACT section (§6, "what downstream inherits")
must, as a named close step, **read that section clause by clause against the shipped code and record
the confirmation with any deviations**. It is prose against code, it needs no box time, no database
and no agent, and at 18a it returned two real defects in ten minutes. **Put it BEFORE the close
review, not after** — it is the cheapest instrument in the set and it hands the reviewer a shorter
list.

**The corollary, from F25:** T1's Form F trigger froze a row the design required to be completed
once, making every PCPNDT scan permanently unacquirable — and T1's own suite stayed green through
it **because it only ever tried the FORBIDDEN direction.** *A constraint test that does not also try
the PERMITTED direction is half a test.*

### 2.161 — THREE SELF-INFLICTED LOSSES ON A SHARED BOX, EACH WITH A ONE-LINE FIX

Named because all three cost real clock at 18a and all three are mechanical.

1. **A full verify was launched, then files were edited under it and targeted suites were run against
   the SAME database.** Both results became worthless and ~45 minutes of box time was thrown away.
   **Fix: a full verify takes its OWN database (`TEST_DATABASE_URL=..._<phase>_verify`) and the tree
   is FROZEN until it lands — no edits, no other runs.**
2. **`pkill -f <pattern>` killed the invoking shell**, because the shell's own command line contains
   the pattern. AGENT-RULES 20 warns about this for `pgrep -af` and it bites identically for `pkill`
   and for `pgrep -c -f` in an until-loop guard — a peer lane's job spun **seven and a half hours**
   on `until [ $(pgrep -c -f jest-worker) -eq 0 ]`, a condition it made false by existing.
   **Fix: never match a bare literal. `pgrep -c -f "[j]est-worker"`, or `ps -eo cmd | grep -c
   '[j]est-worker'`, and kill by PID read from a listing you looked at.**
3. **The Bash tool's working directory persists between calls**, so a `cd` inside one command silently
   relocates the next. At 18a this produced `Can't find meta/_journal.json` (jest run from
   `src/modules/radiology`) and several `FAIL ./mut-*.test.ts` runs whose output was an instrument
   error rather than a verdict — six wasted turns across the session.
   **Fix: every command that runs a tool with a relative-path dependency begins with an absolute
   `cd`. Treat `cd X && <tool>` as the default shape, not a precaution.**

### 2.162 — UNIT MUTANTS CANNOT REACH ASSEMBLY DEFECTS, AND RC-3 PUT NUMBERS ON IT

**THE RULE. Killing a mutant in a component proves the component. It says nothing about the screen
that mounts it, and "the screen that mounts it" is where the money defects live.**

**THE SPECIMEN, RC-3 (the registration counter's seat), 2026-09-01.** Thirteen rule-21 mutants were
BUILT, each APPLIED TO THE TREE AND RUN, and all thirteen DIED. Typecheck clean, lint clean, 36
tests green, a full web suite of 67 files / 432 tests green. Two independent close reviewers then
returned **3 CRITICAL and 12 MAJOR** (deduplicated across the passes).

**Every CRITICAL was in the ASSEMBLY, and not one was reachable by any of the thirteen mutants:**

| the defect | where the mutants were |
|---|---|
| The seat handed `quote={null}` into its own quote panel, so the entire benefits contest had no consumer on the screen | inside `QuotePanel`, which every test handed a quote DIRECTLY |
| `useQuote` held a quote with no lifetime, so patient B was shown patient A's bill, A's chips and A's review-window reason (PHI) under B's name | inside `useQuote`'s fetch, which no test drove through a SECOND patient |
| The seat hard-coded `issued={null}`, so "Collect ₹400" rendered on an encounter that had already been paid | inside `counterExit`, unit-tested as a pure function with `issued` passed in by hand |

The common shape is one sentence: **each component was tested exhaustively and never once reached
through the screen that mounts it.** That is §2.160's diagnosis — every assertion that touched the
defect checked a state where right and wrong agree — arriving through composition rather than
through a fixture.

**THE MECHANICAL FORM.** For any phase that ASSEMBLES already-shipped components into a screen
(every wiring phase, and every phase whose §1 finding is "rails with no consumers"), the assertion
book must contain at least one test that drives the **assembled artifact through a full cycle of its
own domain**, not a single state. At a counter that is TWO PATIENTS, not one: take A, act, clear,
take B, and assert that nothing of A's survives. Grep the test file before close:

```
# every render of the top-level screen — if this is 0 or 1, the assembly is unasserted
grep -c "renderWithProviders(<${SCREEN}" ${SCREEN_TEST}
# and the components it mounts, rendered directly — if this dwarfs the number above, the
# suite is testing the parts and trusting the whole
grep -c "renderWithProviders(<${CHILD}" ${SCREEN_TEST}
```

RC-3's numbers before the review: two renders of the screen (both with the same single patient and
a FREE quote — the one branch where the priced path is irrelevant) against fourteen direct renders
of its children.

---

### 2.163 — REVERT THE FIX AND RE-RUN, OR THE TEST YOU JUST WROTE MAY NOT BE A TEST

**THE RULE. A remediation test that passes proves nothing. Only a remediation test that FAILS
against the original defect proves anything. Restore the defect, run, and watch it go red.**

**THE SPECIMEN, RC-3's close, 2026-09-01 — three checks in one session that could not fail, none of
them caught by reasoning, all three caught by running the revert.**

1. **A mutant cleanup that deleted the task.** `git checkout -- apps/web/src/router.tsx` reverted a
   mutant *and* discarded that task's uncommitted route mount — and the suite went straight back to
   green, because the census the mutant kills reads the router and the reverted router is innocent.
   A green run over a tree that had lost half a task, with nothing in the output saying so.
2. **A remediation test with no prior state to corrupt.** It stubbed a fee-quote that always fails
   and asserted no panel rendered — but with no prior SUCCESS there was never a stale quote to leave
   standing, so it held whether or not the `catch` cleared anything. It was rewritten to drive
   success-then-failure, which is the only sequence that distinguishes them.
3. **A consumer test that grepped the source.** It asserted the screen file contained
   `bg-background`; stripping the seat root's classes left it green, because the utility still
   appeared on the search input. It asserts the RENDERED element's `className` now.

**These three sit beside §2.158's calendar bomb and the `pkill`/`ps` blindness of the same week.
The family is one question:** *what would this check report if the thing I am looking for were
absent?* If the answer is "the same", it is not a check.

**THE MECHANICAL FORM, and it is cheap — seconds per fix.** For every close-review fix:

```
cp <file> /tmp/fix.orig          # NEVER `git checkout` — a revert is a write, and a write to a
                                  # file with uncommitted work is a deletion you did not type
<restore the original defect>
<run the suite>                  # MUST be red, and red in the test you just wrote
cp /tmp/fix.orig <file>
<run the suite>                  # MUST be green again
```

Record the pair in the commit message as `R<n> <what was restored> ... N failed / M passed`. RC-3's
close carries eleven such pairs. Two of them found the test rather than the code.

---

### 2.164 — AN APP-BOOTING E2E IMPORTS EVERY MODULE, SO ONE LANE'S BROKEN CONTROLLER BLOCKS EVERY LANE'S e2e

**THE RULE. In a shared checkout, a peer's in-flight compile error in ANY module makes every
top-level e2e in the repository unrunnable — not merely the ones that touch their code.**

**THE SPECIMEN, 2026-09-01.** The 18a lane, mid-remediation on 13 CRITICAL findings, cleared the
RC-3 lane to take the box: *"neither imports anything under `modules/radiology` or `modules/pcpndt`,
and ts-jest compiles per entry graph, so my broken files are not in yours."* True for
`src/modules/opd/fee-status.test.ts`, which ran and passed 11/11. **False for
`test/billing.e2e.test.ts`**, which stands up the whole Nest app:

```
FAIL test/billing.e2e.test.ts
  ● Test suite failed to run
    src/modules/radiology/radiology-schedule.controller.ts:128:31
      error TS2554: Expected 3 arguments, but got 2.
```

**The app IS the entry graph.** A module-scoped unit test compiles a subtree; an e2e that calls
`Test.createTestingModule` with the root module compiles everything the application imports.

**THE MECHANICAL FORM.** Before clearing a peer for a slot, or accepting one:

```
# whose files are dirty, and does the workspace compile at all?
git status --porcelain | grep -v '^??'
pnpm --filter @hmis/core exec tsc --noEmit 2>&1 | grep -E '^src/' | sed 's/(.*//' | sort -u
```

Then attribute by directory rather than assuming — `grep -E "^src/modules/(billing|opd)/"` returning
EMPTY is what makes "none of these are mine" a measurement instead of a hope. And state the
consequence out loud: **while any module fails to compile, `test/*.e2e.test.ts` is not an available
instrument for anybody**, which matters most to the lane whose findings need an e2e to prove.

### 2.165 — A TWO-FILE EDIT HAS A WINDOW, AND A PEER'S FULL PASS CAN COMPILE ONE SIDE OF IT

**THE RULE. A full workspace pass measures a TREE, and a shared checkout does not hold still. Before
launching one, ask who is EDITING, not only who is running — and land any edit that spans files as
one write where you can, in one commit always.**

**THE SPECIMEN, 2026-09-01 (RC-4 close, 18a close).** The 18a lane asked the RC-4 lane whether it was
*running* anything, was told no, and launched its closing full pass. Thirty seconds later RC-4's
close-review remediation wrote `opd/queue.ts` (which imports `joinQueueInTx`) and then
`opd/encounters.ts` (which exports it). The pass compiled the first file before the second existed:

```
FAIL src/modules/lab/interlock.test.ts · partners/sources.test.ts · radiology/acquisition.test.ts
  src/modules/opd/queue.ts:12:24 - error TS2724: '"./encounters"' has no exported member named 'joinQueueInTx'
```

Three suites in unrelated modules were dead, for the reason §2.164 gives: a per-suite compile of an
import graph that crosses the edit. **The window was one tool call wide and it was enough.** The
18a lane's pass was unattributable and had to be relaunched over a still tree — 45 minutes.

**Why the two questions feel like one, and are not (the 18a lane's half of this entry):** running is
visible in `ps`; editing is visible nowhere. No command either lane could have run at 21:30 would
have shown a half-finished two-file extraction — and the window is invisible to its AUTHOR too, who
cannot see that a peer's run is mid-flight through three unrelated suites. The checkout has no way
to express "I am halfway through a thought". **The only instrument for it is the message sent before
the write.** And the day's tally makes the point from the other side: of the five real defects the
two lanes found on 2026-09-01, **four were found by the OTHER lane's instrument** — a stale event
pin by a full pass, a controller drift by a typecheck, a migration's statement order by an e2e, and
this window by a full pass.

**THE MECHANICAL FORM.** (1) The question before a full pass is *"is anyone about to edit `apps/core`
or `apps/web`?"* — running is the lesser half of the hazard. (2) The two halves of a cross-file edit
go in ONE commit; a bisect that lands between them reproduces the failure. (3) When you are the
editor and a peer is measuring, say so BEFORE the write, not after.

### 2.166 — A REVERT THAT STAYS GREEN MEANS THE ROAD IS UNBUILT, NOT THAT IT DOES NOT EXIST — BUILD IT BEFORE YOU DELETE THE GUARD

**THE RULE. When a revert pair stays green, you have learned that no fixture reaches the guard. You
have NOT learned that nothing can. "Unreachable by construction" is a claim about the whole system
and a revert only measures the suite. Build the road — from OTHER modules' writers, not only your
own — before deleting the guard, and if you cannot build it, keep the guard and say why.**

**THE SPECIMEN, 2026-09-01 (RC-4 close, R37 → pass 2 N1).** The settle hook's new join carried
`if (status !== "settled" && status !== "credit") return;`. Removing it changed nothing in 14
tests. One attempt to construct the road (a part-paid deferred visit, then the allocation reversed)
was refused by the money itself — an invoice cannot be issued part-paid without a credit block — and
from that ONE refused road the close concluded *"a leaving via needs money that was covering the fee,
which would already have joined the visit; unreachable by construction"*, deleted the guard, and
wrote the sentence into the code. **The pass-2 reviewer built the road in ten minutes from a
different module: a LAB invoice against the deferred visit** (arriving via, fee still `unsettled`,
returned by the A-b guard), **then its receipt voided** (leaving via, fee still `unsettled`, the
direction check no longer stops it) — four guards pass and an UNPAID token is minted in the one lane
whose purpose is that none is. Test written, R46 red at exactly that line, guard restored.

**What went wrong was not the revert; it was what the green revert was taken to mean.** The
reasoning searched the hook's OWN module for writers and found none; the writer was in `billing`
(`markEnteredInError`, `reverseAllocation`, credit notes), which fires the hook for ANY invoice on
the encounter, fee or not. §9.7's operand question — *"name one real transaction whose money that
sum does not include"* — was the instrument, and it was asked of the wrong sum.

**Why it matters:** the RC series has now had six checks that could not fail (R21, R26, R27, R37,
and RC-3's three), every one found by a revert, none by reasoning — and R37 is the first where the
correct response to the green revert was NOT to delete the check. The revert is the instrument; the
guard's *reason for existing* is what it measures; and when the reason is "nothing can arrive", the
next question is *from which module*.
