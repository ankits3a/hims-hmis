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
```

---

## 2. Pipeline template defects

Project-agnostic — fixed in `~/.claude/skills/execute/SKILL.md`, so every future project inherits the fix rather than re-learning it.

**2.1 — Infrastructure failure must never consume a defect attempt or escalate the tier.** *(Plan 02, T5, ~168k tokens)*
Two consecutive gate agents died on `API Error: 529 Overloaded`. The template treated a dead gate identically to a gate that said *no*: it re-ran the **coder**, then escalated to heavy-coder, then gated again — three agents to re-verify work that was already correct and already committed. Fixed: a dead gate now re-gates **the same coder report** without re-running the coder; a dead coder retries the **same rung** of the ladder. Neither advances the ladder, and neither promotes the tier. Infra retries are capped separately so a genuinely unavailable model still halts the chain.

**2.2 — Retries need a verify-only mode.** *(Plan 02, T4 and T5)*
When a gate's corrections say *"the code is correct — do not re-implement, just prove it"*, the retry prompt still said "the files are in the state the last attempt left them; apply every correction." Both coders then had to manufacture fail-first evidence for already-shipped code: one created and dropped a throwaway database (`hmis_t4_failfirst`), the other temporarily relocated `identity.ts` out of the tree. Both were honest about it and both gates accepted the labelled reconstructions — but the pipeline invited state mutation nobody asked for. Fixed: the gate now sets `retry_mode: "verify-only" | "reimplement"` on its verdict, and a verify-only retry is told explicitly not to rewrite code, not to fabricate a red run by mutating shipped state, and to say so plainly when a legitimate fail-first run is impossible.

---

## 3. Plan-authoring defects

Fix these when writing the next plan, not when executing it.

**3.1 — A task's Files list must name every file its Steps touch.** *(Plan 02, T7)*
Task 7's Files list omitted `apps/core/package.json`, but its Step 3 required adding the `@types/express` devDependency. A coder following the Files list breaks the build; a coder following Step 3 looks like scope creep to the gate. Either way the ladder burns an attempt. When compiling, reconcile the two and state the reconciliation in the brief.

**3.2 — A frozen file orphans the steps that needed it.** *(Plan 02, T6 → T8)*
A gate correction froze `apps/core/package.json` during T6, so the `"agent:create"` script the plan's T6 Step 3 required never landed — leaving `scripts/create-agent.ts` unrunnable and T12's README documenting a command that did not exist. Nobody noticed until the next pipeline was compiled. **When a gate correction freezes a file, the step it blocked becomes a carried-forward item: name it explicitly in the next task that owns that file, with the rationale, so the gate reads it as in-scope.**

**3.3 — Conditional instructions stall agents.** *(carried from Plan 02's stress test, held)*
"Add X if the compiler asks for it" produces either a stall or an unjustifiable diff. State dependencies unconditionally.

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

**Total preventable: ~465k of Plan 02 pipeline A's 1,258,193 subagent tokens (37%).** Only one of pipeline A's five retries — T6's missing `revokeTerminalSessions` assertion, ~134k — was a genuine code defect, which is exactly what the gate exists to catch and worth paying for twice.

---

## 5. What is working — do not "improve" these

- **Opus gate per task.** It caught the `/tmp` breach, the local-tree pollution, and a real test gap that four green suites hid. Every one of pipeline A's productive findings came from the gate, not the coder.
- **Criteria attributable to the task itself.** Plan 01 lost an entire pipeline to a criterion asserting a co-tenant stack's health. Plan 02 had zero such failures.
- **Briefs that point at the committed plan** rather than restating its code. The plan is on the server; agents type its exact blocks. No transcription drift appeared in twelve tasks.
- **One task per wave when tasks share files.** Zero merge conflicts across twelve sequential tasks on shared `auth.module.ts` / `guards.ts` / `auth.controller.ts`.
- **Independent main-session verification** (`pnpm verify` + CI observation) after each pipeline, never trusting agent self-reports alone.
