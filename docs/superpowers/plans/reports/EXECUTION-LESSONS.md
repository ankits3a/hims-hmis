# Execution Lessons — the pipeline's own defect ledger

**What this is.** The durable memory of *how the pipeline itself fails*. Gate reports record what shipped; this file records what it cost to ship it, and what must never cost that again. It is committed to the repo deliberately: it survives sessions, and agents on the build server can read it.

**Binding rule for every session.** Before compiling any pipeline for this repo, read this file and paste **§1 Tripwires verbatim at the TOP of every task brief** — above the goal, not buried in a prose paragraph. A rule an agent skims is a rule an agent breaks: the `/tmp` breach below happened while the prohibition sat as clause five of a nine-line block.

**Write path.** Every gate report ends with a Lessons section; its entries are appended here the same session. No separate ritual.

**Pruning.** Entries carry their cost. Retire one only when the mechanism that made it necessary is gone — never because it looks obvious in hindsight. Obvious-in-hindsight is exactly what gets skipped and re-learned.

---

## 1. Tripwires — paste this block verbatim at the top of every task brief

```
HARD RULES (violating any one of these fails the task regardless of code quality):
1.  Build and test ONLY on the server, over SSH: root@62.238.106.231, checkout /opt/hmis.
2.  NEVER write, edit, or run any git command against the local Windows checkout
    C:\Users\ankit\hmis. It is the owner's docs working copy, not a build environment.
    If you discover you have written there, report it and LEAVE IT EXACTLY AS IT IS —
    do not delete, revert, stash, or clean it. It is not yours to clean.
3.  /opt/hmis is the ONLY writable path on that host. NO writes to /tmp, ever, for any
    reason — not even a throwaway sanity check.
4.  Keep any scratch file under /opt/hmis and delete it before committing.
5.  NEVER run a command that emits compiled JavaScript into the source tree (bare `tsc`,
    `tsc -b`). Typecheck only via the repo's own `pnpm typecheck` / `pnpm verify`, which
    pass --noEmit. Jest resolves .js before .ts, so stale emit silently shadows sources.
6.  Never read, stat, list, or reference /opt/InsForge or any insforge-* container — not
    even read-only. It is an unrelated co-tenant stack on the same host.
7.  Create no docker container. Create and drop no database by hand; the test suite
    manages its own per-worker databases.
8.  The owner may be working on the same host from the same IP and SSH key. Never infer
    from logs, timestamps, or file mtimes who did what. Report only what you yourself did.
9.  Guard every apt invocation with NEEDRESTART_MODE=l so it cannot bounce the shared
    docker daemon.
10. The server's deploy key CANNOT push .github/workflows/* — GitHub refuses it. If you
    believe a workflow edit is needed, STOP and report instead of editing.
11. `git pull --rebase origin main` before writing: docs commits land from the owner's
    machine while pipelines run.
12. Evidence over assertion: never report a test as passing without having run it in that
    state. Commit with the plan's exact message; include pnpm-lock.yaml on any dependency
    change.
13. NEVER pass a POSIX absolute path (/opt/...) to the Write or Edit tools — you run on a
    Windows host, so that silently creates C:\opt\... instead. Author files in the session
    scratchpad and place them with scp, or write them over ssh with a single heredoc.
14. NEVER weaken, strip, or disable security-relevant code (a guard, a permission check, an
    auth path) to produce a test result — not even temporarily, not even to satisfy a
    reviewer asking for a failing run. If evidence requires that, say it is impossible and
    explain why. Removing a guard from a running system is never the smaller evil.
15. NEVER rewrite published history. `git commit --amend`, `git rebase`, `git reset --hard`
    and `git push --force` / `--force-with-lease` are forbidden on any commit that has
    already been pushed — INCLUDING a commit you, or an earlier attempt at your own task,
    pushed minutes ago. A correction to an already-pushed commit lands as a NEW follow-up
    commit, always. If any instruction — including a reviewer's correction — tells you to
    amend or force-push pushed history, refuse it and report that you refused.
16. NEVER take a PIPELINE's exit status as a COMMAND's verdict. `pnpm verify 2>&1 | tail -40`
    exits 0 even when verify fails — that is tail's status, not verify's, and it is a silent
    false PASS. Capture the real one (`${PIPESTATUS[0]}` in bash) or run the command unpiped.
    `| head -N` has the opposite failure: it closes the pipe early and makes a passing run
    look like exit 1. Never infer pass/fail from a truncated window.
17. NEVER take a WRAPPER's exit status as the COMMAND's verdict. Appending `; echo "exit: $?"`
    makes the shell exit 0 because the *echo* succeeded — your harness then reports PASS for a
    command that died. Read the echoed VALUE, or a captured exit file. This is tripwire 16 one
    level out, and it fails in the dangerous direction: silently green.
18. Run any LONG remote command (`pnpm verify`, `pnpm install`, a seeded perf suite) DETACHED
    on the server with its own exit code written to a file — never held open on a foreground
    SSH channel, which exits 255 on a dropped link and destroys the evidence mid-run:
      ssh root@62.238.106.231 'cd /opt/hmis && setsid nohup sh -c "pnpm verify \
        > /opt/hmis/.verify.log 2>&1; echo \$? > /opt/hmis/.verify.exit" >/dev/null 2>&1 &'
    then poll `.verify.exit` for the real status. Delete both scratch files before committing
    (tripwire 4) and confirm `git status` is clean.
```

---

## 2. Pipeline template defects

Project-agnostic — fixed in `~/.claude/skills/execute/SKILL.md`, so every future project inherits the fix rather than re-learning it.

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

**2.6 — Never quote a fixed baseline SHA in the briefs of a SEQUENTIAL pipeline.** *(Plan 05, T2/T3/T4/T5 — four agents, four reconciliation paragraphs)*
Every brief carried *"The repo is at commit cc22b19 on main"*, true only for T1. T2 found `c66e76b`, T3 found `2b8c6a9`, T4 found `45475fc`, T5 found `5011bc2` — and each one stopped, investigated whether it was looking at drift, and wrote a paragraph explaining why it proceeded anyway. All four reasoned correctly and none was harmed, but it is four rounds of avoidable doubt bought with tokens, and a more literal agent would have halted. The same line's *"45 suites / 208 tests"* caused T3 to report the baseline as irreconcilable — it was comparing its per-workspace `apps/core` count against a repo-wide total, and the two do reconcile exactly. **In a sequential pipeline, state the baseline as "the previous task's commit, i.e. current `origin/main`" and give test counts per workspace, or omit the numbers.**

---

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

**3.14 — An assertion whose fixture makes both sides identical proves nothing.** *(Plan 05, T6 — the run's only genuine gate catch, and the deepest finding since §3.13)*
Task 6's criterion required proving that `guardian.authority_changed` carries the **effective** authority (computed) rather than the **stored** flags. The plan's test asserted exactly that — on a **10-year-old**, where effective authority and stored flags are by definition identical. The assertion passed against the correct implementation and would have passed just as green against an implementation that simply echoed the stored row. It had no teeth. The gate caught it and the retry added a `dobAged(20)` fixture whose stored flags are `dsr: true, messages: true` but whose event payload is all-false — a result only a computed authority can produce. The same test block also never called `effectiveGuardianAuthority` with a **non-active** guardian, leaving the `status !== "active"` branch entirely unasserted while three other paths carried it.
**This is §3.11 and §3.13 one level further on.** §3.11 was an assertion that can never pass; §3.13 was one that passes sometimes; this is one that **always** passes, for the wrong reason. It is the hardest of the three to see, because a green suite is exactly what it looks like. **When writing an assertion that distinguishes A from B, hand-check that the fixture actually separates them — pick the input where a wrong implementation would produce a different answer, and say so in the test name.** A corollary the gate applied correctly: "the sweep returns 0 on a second run" is a weaker claim than "the sweep emits no further events"; assert the observable, not just the return value.

**3.15 — A plan must not carry a lint directive for a rule the repo does not enable.** *(Plan 05, T4 — zero tokens, but it degraded the repo's lint output)*
The plan's perf test included `// eslint-disable-next-line no-console` above a timing log. This repo's root `eslint.config.mjs` uses only `tseslint.configs.recommended`, which never enables `no-console` (`scripts/*.ts` call `console.log` unannotated). ESLint 9 reports an **unused disable directive** as a warning, so `pnpm lint` went from pristine to `✖ 1 problem (0 errors, 1 warning)` — exit still 0, so `verify` stays green and nothing fails, which is precisely why it will rot there unnoticed. The coder correctly typed the plan verbatim, disclosed the effect, and declined to remove a line the brief told it to reproduce. **When a plan writes a lint suppression, check the repo's actual lint config first; a suppression for an unconfigured rule is itself a lint finding.**

**3.16 — A generated-artifact step must name the generator's FULL output set, not just the headline file.** *(Plan 05, T1 — §3.1 recurring, third occurrence)*
The Files list named `apps/core/drizzle/0006_*.sql`, but `pnpm db:generate` also creates `drizzle/meta/0006_snapshot.json` and rewrites `drizzle/meta/_journal.json`. The coder reasoned correctly (the same pattern is already committed for migrations 0000–0005) and disclosed the interpretation, and the gate ratified it — but a stricter gate could equally have read two unlisted files as scope creep. §3.1 has now been hit by a devDependency (Plan 02 T7), a DI token (Plan 02 T8), and a code generator's metadata. **When a step runs a generator, list every file the generator touches.**

**3.14b — The §3.14 audit must also ask whether the claimed mechanism is REACHABLE, not just whether the fixture separates.** *(Plan 05, T10 leg 4 — the run's only genuine gate catch, and the instance a §3.14-aware stress pass still missed)*
The lifecycle e2e claimed leg 4 "proves the `requester_approver` SoD pair over HTTP" by having the clerk who filed the merge attempt to approve it and asserting **403**. But the same plan deliberately gives the clerk *zero* approvals permissions — that is the design, and correctly so. A clerk with no `approvals.requests.decide` is turned away by the route's `@RequirePermission` guard **before `assertNotSodPair` ever runs**, so the 403 proved the permission guard and the SoD check was never exercised. The assertion passed for the wrong reason, and deleting the entire SoD subsystem would not have failed it. The fix: a mid-leg-4, leg-4-only grant of an approvals-decider role to the clerk so the refusal originates from the SoD check, asserted against the SoD-**specific** signal — the response message containing `requester_approver` and exactly one `sod.violation_blocked` event — never the bare status code, which two different mechanisms produce identically.
**Why this matters more than §3.14 itself:** a stress pass run the same day, explicitly hunting §3.14 instances, caught two of them (T7's frozen-patient branch, T8's unknown-patient branch) and **missed this one**, because those were *fixture* defects visible in the test block while this is a *design* contradiction spanning the permission model and the claim. **When a test asserts a status code, name which mechanism produced it and assert something only that mechanism emits.** Three instances in two pipelines makes this the most recurrent defect class in the ledger.

**3.17 — A third-party API called with a placeholder argument to reach a later parameter can bind the WRONG OVERLOAD and silently discard the option.** *(Plan 05, T9 — caught by the coder, and the single most dangerous defect either pipeline produced)*
The plan's e2e bootstrap read `moduleRef.createNestApplication<NestExpressApplication>(undefined, { bodyParser: false })`. `@nestjs/testing` declares two overloads — `(httpAdapter, options?)` and `(options?)` — and its implementation dispatches on `this.isHttpServer(serverOrOptions)`. A first argument that is not an HTTP adapter is therefore **treated as the options bag**, so `{ bodyParser: false }` sitting in the second position was silently ignored, `appOptions` fell back to `{}`, and Nest installed Express's default **100 kB** json parser ahead of `configureApp`'s 1 MB one. The ~300 kB photo body would have failed. The type error (`undefined` is not assignable to the adapter parameter) was the *harmless* half; the runtime mis-binding was the real defect, and no amount of reading would have surfaced it without running the 300 kB round-trip. **This is exactly what a verify-by-execution flag is for — flag ⑩ named this construct and it fired.** When a plan passes `undefined`/`null` to skip a parameter, check the callee's overload dispatch: positional placeholders are not neutral in a function that discriminates on argument shape.

**3.18 — When a plan states a value in prose and asserts a DIFFERENT one in its own test block, the test block is what runs.** *(Plan 05, T9 — zero cost, resolved correctly by the coder)*
The plan's Interfaces block said `POST /patients/qr/verify` returns **HTTP 200** even on `ok: false` (a failed scan is a domain answer, not a transport error), and the compiled acceptance criterion repeated it — but the plan's own e2e code block asserted `.expect(201)` on all three calls to that route, which is merely Nest's POST default. Two sources said 200, one said 201, and only one of them executes. The coder resolved it toward the stated intent (`@HttpCode(200)` on the handler, three assertions changed) and disclosed it. **Reconcile a plan's prose against its own test blocks before shipping it; where they disagree, the prose is the intent and the assertion is the behaviour, and only one of them is enforced.**

**3.4 — Verify-by-execution flags belong in the plan.** *(Plan 01 lesson, honored in Plan 02 — keep)*
Hand-written matcher patterns, raw-SQL parameter binding, third-party CI action inputs, native-module installs, and third-party API surface names all typecheck while being wrong. Plan 02 flagged seven such items in its self-review and **all seven held** — zero runtime defects in the plan's own code across twelve tasks, against three in Plan 01. This is the single highest-yield planning habit found so far.

---

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
| 2026-08-13 | Plan 05 T9's e2e bootstrap passed `undefined` as a positional placeholder to `createNestApplication`, which dispatches on argument shape — `{ bodyParser: false }` was silently discarded and Express's 100 kB parser would have rejected the 300 kB photo | Authoring defect §3.17 — **previously unrecorded**. Caught inside the original attempt by verify-by-execution flag ⑩, exactly as designed | absorbed in one attempt, no retry. The §5 disclose-don't-work-around habit paying off a fourth time |
| 2026-08-13 | Plan 05 T10 leg 4 claimed to prove the `requester_approver` SoD pair over HTTP, but the clerk holds no approvals permission by design, so the route guard produced the 403 and `assertNotSodPair` never ran | Authoring defect §3.14b — the third §3.14 instance in two pipelines, and the one a §3.14-hunting stress pass **missed**, because it is a design contradiction rather than a fixture defect | ~177k tokens (retry coder + second gate). The gate caught it; this is the system working |
| 2026-08-13 | Plan 05 T8's execute test created no guardian and no photo, so "guardians move to the winner" and "photos do NOT move" were never asserted — it asserted `guardianIds` length **0**, the empty case | Authoring defect, §3.14 class again | 0 tokens, no retry. Forced into the open by a compiled acceptance criterion that named both invariants explicitly — criteria doing the stress test's job at execution time |
| 2026-08-13 | Plan 05 T6's retry was blocked by the permission system partway through — it wrote the corrected test to the server but could not run tests, run verify, or commit, and stalled twice (388 s, 2446 s) before returning INCOMPLETE with the server tree left DIRTY | Host/harness failure. The ladder handled it correctly: gate #2 failed it on the uncommitted file, the escalate rung ran verify-only, landed the correction as a NEW follow-up commit (tripwire 15 held — nothing was amended), and gate #3 passed | ~116k tokens (the escalate rung + its gate). The retry itself was legitimately owed — gate #1 caught a real defect (§3.14) — so only the rung the blockage forced is prevention debt |
| 2026-08-13 | Plan 05 T4's brief pinned "6 functional tests" to `test -- search`, a jest PATH REGEX that the task's own `perf-patient-search.test.ts` also matches — unsatisfiable at task end | Compile defect §2.5 — **mine, not the plan's**; §2.3's shape in a new place | 0 tokens, no retry. The coder quoted both runs and named the narrowing regex |
| 2026-08-13 | Plan 05's six briefs each quoted a fixed baseline SHA (cc22b19) that was stale from T2 onward; four coders each wrote a paragraph reconciling it | Compile defect §2.6 — **previously unrecorded** | 0 tokens of retry, but four rounds of avoidable doubt; a more literal agent would have halted |
| 2026-08-13 | Plan 05's baseline verify was run on a foreground SSH channel; the link reset at ~10 min (exit 255) with `apps/core` five suites in, and the harness reported **exit 0** because the trailing `; echo "EXIT: $?"` wrapper had succeeded. Caught only by reading the echoed value | Tripwires 17 + 18 — **previously unrecorded**, and hit by the MAIN SESSION, exactly where tripwire 16 was found in Plan 04 | 0 agent tokens (pre-compile), ~10 min wall clock re-run detached. Recorded because the reported-PASS direction is the silent one: a dropped verify would have certified a baseline nobody measured |

**Plan 04 totals: 17 agents, 1,278,905 subagent tokens (pipeline A 607,273 / pipeline B 627,309 / signature scout 44,323), ~1h47m of pipeline wall clock across eight tasks.** Zero infrastructure failures. Zero retries — **8/8 first-attempt gate passes, the first plan in the series with no retry of any kind.** The plan's ~1.3M calibration was accurate to within 2%.

**The shape of failure moved again, and it is worth naming.** Plan 02's defects were in implementation; Plan 03's were all three in *test* code; Plan 04's three were also all in the plan's own code blocks (§3.12 a helper's SQL, §5.2 an implementation signature that does not compile, §3.13 a flaky assertion) — but **none of them reached the gate.** Every one was caught, fixed minimally, and disclosed inside the *original* attempt by a coder briefed to report plan defects rather than work around them. That is the §5 habit converting authoring defects into ledger entries at zero retry cost, and it is now the single highest-yield thing in this file after the tripwire block itself.

**The one new hazard: evidence you did not actually measure.** Tripwire 16 exists because `pnpm verify | tail -N` reports *tail's* exit status — a silent false PASS — and `| head -N` reports a false FAIL via SIGPIPE. It was found the harmless way (a false fail) but the same construct had already appeared in the **main session's own** first verification of the session. A verification ritual that can silently certify a failing build is worse than no ritual.

**Plan 05 pipeline A totals: 16 agents, 1,315,927 subagent tokens, ~2h46m wall clock across six sequential tasks.** Zero infrastructure failures of the API-529 kind; one harness permission block (T6 retry). **5 of 6 tasks passed on the first attempt**; T6 took three, of which one rung was a genuine gate catch worth paying for (§3.14) and one was forced by the permission block. Verify went 45 suites / 208 tests → 53 / 256; CI green on all seven commits; frozen paths untouched; exactly one migration generated, in T1, as specified.

**The shape of failure moved again, and this time it moved onto ME.** Plan 03's defects were in the plan's test code; Plan 04's were in its own code blocks but caught inside the original attempt; Plan 05 pipeline A produced **three plan defects and two compile defects, and the compile defects were both mine** — a criterion pinned to a jest path regex the task's own file would match (§2.5), and a stale baseline SHA repeated in six briefs (§2.6). Neither cost a retry, but both made correct agents spend tokens proving they were correct. The ledger has been auditing plan-authoring for four plans; **the compile step had never been audited at all, because the main session writes the briefs and then reads the reports about them.** Both new entries exist to close that loop.

**Plan 05 pipeline B totals: 10 agents, 1,027,012 subagent tokens, ~1h39m wall clock across four sequential tasks.** Zero infrastructure failures. **3 of 4 tasks passed on the first attempt**; T10 took two, the extra rung being a genuine gate catch (§3.14b). Verify went 53 suites / 256 tests → 57 / 276; CI green on all five commits; frozen paths untouched; no new migration; lint back to **zero problems** after T7 removed the dead directive §3.15 recorded.

**A stress pass is worth running, and is not a substitute for the gate.** Before compiling pipeline B this session's main loop ran a scout-verified stress pass over T7–T10 and fixed four defects up front — two of them §3.14 fixture defects (a "frozen patients" test name with no frozen assertion; an "unknown patients" name with no unknown assertion), a test count no correct implementation could satisfy, and the carried-forward lint cleanup. **It still missed T10's §3.14b**, and it could not have found T9's §3.17 overload mis-binding, which only a 300 kB request could reveal. The division of labour that actually held: **the stress pass catches what reading can catch, verify-by-execution flags catch what only running can catch, and the gate catches what neither did.** Removing any one of the three would have shipped a defect this pipeline.

**Open item carried forward (not fixed, deliberately):** `qr.test.ts` builds its tampered payload as `payload.slice(0, -2) + "xx"`, which only differs from the real base64url HMAC when the signature does not already end in `xx` — roughly **1 CI run in 4096** will see the "tampered" payload verify successfully and fail the suite. The T9 coder found it, judged rewriting another task's shipped assertion out of scope, and flagged it rather than silently changing it — the correct call. It is a §3.13-class latent flake (passes almost always) and should be made deterministic in the next task that legitimately owns `qr.test.ts`.

**Plan 02 totals: ~605k of 2,770,639 subagent tokens (22%) spent on process and infrastructure rather than code.** Pipeline A ~465k of 1,258,193 (37%); pipeline B ~140k of 1,512,446 (9%) — the improvement came from the tripwires being hoisted to the top of every brief, not from luck. Across twelve tasks only **two** retries were genuine code defects (T6's missing `revokeTerminalSessions` assertion, T9's first attempt), which is exactly what the gate exists to catch and worth paying for twice.

**Plan 03 totals: 24 agents, 1,651,636 subagent tokens (pipeline A 767,045 / pipeline B 884,591), ~2h16m of pipeline wall clock across ten tasks.** Zero infrastructure failures — no API 529, no dead agent, nothing skipped. **Zero process-caused retries.** Both of the two retries in ten tasks (T4, T8) were genuine code defects the gate caught, against Plan 02's two-in-twelve. Measured against Plan 02's ~605k of 2.77M (22%) lost to process, Plan 03 lost **~0%**: the only process failure (§2.4's force-push) consumed no extra agent, because it happened inside a retry that was legitimately owed.

**What that improvement was bought with, precisely:** the tripwire block at the top of every brief (Plan 02's finding, applied from task one this time rather than mid-run), the ladder fix that stops infrastructure from advancing the rung, and briefs that point at the committed plan on the server instead of restating its code. Three of those were already in the ledger before this plan started — **the ledger paid for itself in one plan.**

**The new shape of failure: Plan 03's implementation code was defect-free, and all three of its defects were in its TEST code** (§3.9 a flag discharged in the wrong task, §3.10 a derived fixture the plan's own validator rejects, §3.11 an assertion that can never pass). Plan 02's lesson was to run the implementation before believing it; Plan 03's is that **a plan's test blocks get less scrutiny than its implementation blocks and need the same verify-by-execution treatment** — they typecheck, they read plausibly, and two of these three were unsatisfiable against a correct implementation.

**The two lessons this ledger most wants its next reader to absorb:** a rule that is written down but buried still gets broken (§1 exists as a *top-of-brief block* for that reason), and a fix that lands after a pipeline is compiled does not protect that pipeline (T12 hit the 529 bug ~4 hours after it was fixed). When a template fix lands mid-run, patch the persisted script and resume rather than letting the run finish on the old ladder.

---

## 5. What is working — do not "improve" these

- **Opus gate per task.** It caught the `/tmp` breach, the local-tree pollution, and a real test gap that four green suites hid. Every one of pipeline A's productive findings came from the gate, not the coder.
- **Criteria attributable to the task itself.** Plan 01 lost an entire pipeline to a criterion asserting a co-tenant stack's health. Plan 02 had zero such failures.
- **Briefs that point at the committed plan** rather than restating its code. The plan is on the server; agents type its exact blocks. No transcription drift appeared in twelve tasks.
- **One task per wave when tasks share files.** Zero merge conflicts across twelve sequential tasks on shared `auth.module.ts` / `guards.ts` / `auth.controller.ts`.
- **Independent main-session verification** (`pnpm verify` + CI observation) after each pipeline, never trusting agent self-reports alone.
- **Landing a template fix BEFORE compiling the next pipeline.** Plan 02 learned this the expensive way (T12 hit the 529 bug four hours after it was fixed, because pipeline B was already compiled). Plan 03 applied it: tripwire 15 and the gate-prompt fix landed between pipelines A and B, so B's briefs carried them. Cost: one extra docs commit. Do this every time.
- **Agents that report a plan defect instead of silently working around it.** T9 and T10 each hit an unsatisfiable plan fixture, fixed the minimum, and disclosed exactly what and why — which is how §3.10 and §3.11 exist to be fixed at authoring time. Keep briefing "report it as a plan defect in your interpretations field — do not silently redesign it"; it converts a one-off workaround into a durable authoring lesson.
