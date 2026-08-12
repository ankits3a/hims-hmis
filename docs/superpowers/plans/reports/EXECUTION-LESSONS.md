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

**Plan 02 totals: ~605k of 2,770,639 subagent tokens (22%) spent on process and infrastructure rather than code.** Pipeline A ~465k of 1,258,193 (37%); pipeline B ~140k of 1,512,446 (9%) — the improvement came from the tripwires being hoisted to the top of every brief, not from luck. Across twelve tasks only **two** retries were genuine code defects (T6's missing `revokeTerminalSessions` assertion, T9's first attempt), which is exactly what the gate exists to catch and worth paying for twice.

**The two lessons this ledger most wants its next reader to absorb:** a rule that is written down but buried still gets broken (§1 exists as a *top-of-brief block* for that reason), and a fix that lands after a pipeline is compiled does not protect that pipeline (T12 hit the 529 bug ~4 hours after it was fixed). When a template fix lands mid-run, patch the persisted script and resume rather than letting the run finish on the old ladder.

---

## 5. What is working — do not "improve" these

- **Opus gate per task.** It caught the `/tmp` breach, the local-tree pollution, and a real test gap that four green suites hid. Every one of pipeline A's productive findings came from the gate, not the coder.
- **Criteria attributable to the task itself.** Plan 01 lost an entire pipeline to a criterion asserting a co-tenant stack's health. Plan 02 had zero such failures.
- **Briefs that point at the committed plan** rather than restating its code. The plan is on the server; agents type its exact blocks. No transcription drift appeared in twelve tasks.
- **One task per wave when tasks share files.** Zero merge conflicts across twelve sequential tasks on shared `auth.module.ts` / `guards.ts` / `auth.controller.ts`.
- **Independent main-session verification** (`pnpm verify` + CI observation) after each pipeline, never trusting agent self-reports alone.
