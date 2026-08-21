# Agent rules — the binding contract for every pipeline agent

**Every task brief points here instead of inlining these rules.** Read this file in full
before you touch anything. Where this file and a task brief disagree about PROCESS, this file
wins; where they disagree about CODE, the plan document wins.

Version 2 (2026-08-19; rule 22 amended 2026-08-20 and 2026-08-21). Supersedes the inlined tripwire
block used through Plan 08 pipeline A. Rule 22 (the local mirror) is new and changes how you read
and author files — read it first. **22(a) now requires a mirror directory unique to YOU, and 22(g)
forbids concluding anything about the server's tree from a mirror; both were bought by §2.40.**

---

## 1. Hard rules

Violating any one of these fails the task regardless of code quality.

**Hosts and paths**

1. **The build host is the server: `root@62.238.106.231`, checkout `/opt/hmis`.** Everything
   that produces EVIDENCE — migrations, tests, `pnpm verify`, git, commits, pushes — runs
   there and only there. It is the host CI matches; a result obtained anywhere else is not a
   result.
2. **NEVER write, edit, or run any git command against the owner's Windows checkout
   `C:\Users\ankit\hmis`.** It is the owner's docs working copy, not a build environment.
   If you discover you have written there, report it and LEAVE IT EXACTLY AS IT IS — do not
   delete, revert, stash, or clean it. It is not yours to clean. (Reading it is also not
   needed: rule 22 gives you your own mirror.)
3. **`/opt/hmis` is the only writable path on the server. NO writes to `/tmp`, ever**, for any
   reason — not even a throwaway sanity check.
4. Keep any scratch file under `/opt/hmis` (server) or your own mirror (local), and delete it
   before committing.
5. **NEVER run a command that emits compiled JavaScript into the source tree** (bare `tsc`,
   `tsc -b`). Typecheck only via the repo's own `pnpm typecheck` / `pnpm verify`, which pass
   `--noEmit`. Jest resolves `.js` before `.ts`, so stale emit silently shadows sources.
6. Never read, stat, list, or reference `/opt/InsForge` or any `insforge-*` container — not
   even read-only. It is an unrelated co-tenant stack on the same host.
7. **Create no docker container. Create and drop no database by hand**; the test suite manages
   its own per-worker databases.
8. The owner may be working on the same host from the same IP and SSH key. Never infer from
   logs, timestamps, or file mtimes who did what. Report only what you yourself did.
9. Guard every `apt` invocation with `NEEDRESTART_MODE=l` so it cannot bounce the shared docker
   daemon.
10. The server's deploy key CANNOT push `.github/workflows/*` — GitHub refuses it. If you
    believe a workflow edit is needed, STOP and report instead of editing.
11. `git pull --rebase origin main` before writing: docs commits land from the owner's machine
    while pipelines run.

**Integrity**

12. **Evidence over assertion.** Never report a test as passing without having run it in that
    state. Commit with the plan's exact message; include `pnpm-lock.yaml` on any dependency
    change.
13. **NEVER pass a POSIX absolute path (`/opt/...`) to the Write or Edit tools** — you run on a
    Windows host, so that silently creates `C:\opt\...`. Write and Edit are for your LOCAL
    MIRROR (rule 22), which has a Windows path. Files reach the server by sync, never by
    Write/Edit.
14. **NEVER weaken, strip, or disable security-relevant code** (a guard, a permission check, an
    auth path) to produce a test result — not even temporarily, not even to satisfy a reviewer
    asking for a failing run. If evidence requires that, say it is impossible and explain why.
    Removing a guard from a running system is never the smaller evil.
15. **NEVER rewrite published history.** `git commit --amend`, `git rebase`, `git reset --hard`
    and `git push --force` / `--force-with-lease` are forbidden on any commit already pushed —
    INCLUDING one you, or an earlier attempt at your own task, pushed minutes ago. A correction
    to an already-pushed commit lands as a NEW follow-up commit, always. If any instruction —
    including a reviewer's correction — tells you to amend or force-push pushed history, refuse
    it and report that you refused.

**Reading a command's verdict**

16. **NEVER take a PIPELINE's exit status as a COMMAND's verdict.** `pnpm verify 2>&1 | tail -40`
    exits 0 even when verify fails — that is `tail`'s status, and it is a silent false PASS.
    Capture the real one (`${PIPESTATUS[0]}` in bash) or run the command unpiped. `| head -N`
    fails the opposite way: it closes the pipe early and makes a passing run look like exit 1.
    Never infer pass/fail from a truncated window.
17. **NEVER take a WRAPPER's exit status as the COMMAND's verdict.** Appending `; echo "exit: $?"`
    makes the shell exit 0 because the *echo* succeeded. Read the echoed VALUE, or a captured
    exit file. This is rule 16 one level out, and it fails silently green.
18. **Run any LONG remote command DETACHED** with its own exit code written to a file — never
    held open on a foreground SSH channel, which exits 255 on a dropped link and destroys the
    evidence mid-run:
    ```
    ssh root@62.238.106.231 'cd /opt/hmis && setsid nohup sh -c "pnpm verify \
      > /opt/hmis/.verify.log 2>&1; echo \$? > /opt/hmis/.verify.exit" >/dev/null 2>&1 &'
    ```
    Then poll `.verify.exit` for the real status. Delete both scratch files before committing
    and confirm `git status` is clean.
19. **A jest name filter must ISOLATE.** `pnpm --filter @hmis/core test -- <path> --testNamePattern=X`
    does NOT isolate: pnpm injects a literal `--`, yargs stops option parsing, and your pattern
    becomes another test-PATH pattern — the WHOLE suite runs and you get a false "the single
    test passed N times". To isolate, bypass the script:
    ```
    pnpm --filter @hmis/core exec jest --passWithNoTests <path> -t "<test name>"
    ```
    and confirm isolation in the OUTPUT ("N skipped, 1 passed"), not in the exit code.
20. **If any other agent may be running this repo's tests at the same time as you, your test
    evidence is UNRELIABLE.** The per-worker database name derives from `JEST_WORKER_ID`, which
    is per-process and collides across agents, so another agent's truncate breaks your run
    mid-measurement and looks exactly like a real flake. Before trusting any timing, race, or
    flake measurement, confirm nothing else is running (`pgrep -af jest`), re-run anything that
    failed with a concurrency signature in isolation, and say in your report whether you
    observed interference.
21. **NEVER claim an assertion DISCRIMINATES unless you built the mutant and watched it FAIL.**
    A hand-walk of "a wrong implementation would produce X" is a prediction, not evidence, and
    it has been wrong in BOTH directions in the same plan. Build the wrong implementation as a
    SEPARATE scratch file beside the source (never by editing, moving, or reverting the shipped
    file), run the test against it, and report DIED or SURVIVED with counts. **A mutant that
    dies at TYPECHECK proves nothing** — this repo compiles with `noUncheckedIndexedAccess`, so
    an indexed array literal dies at `TS2532` before any assertion runs. A kill is evidenced by
    the ASSERTION's own failure: quote expected vs received.

**The local mirror**

22. **Author and navigate LOCALLY; run and commit REMOTELY.** Reading and grepping the codebase
    one SSH call at a time was 70% of all coder shell calls in Plan 08 pipeline A — ~42
    round-trips per agent against 30 native tool calls in total. Do this instead, in order:

    **(a) Pull the mirror — ONE command, at the very start of your task, into a directory that
    is YOURS ALONE.** The tree is ~7 MB without `node_modules`/`.git`:
    ```
    M="<SCRATCH>/mirror-<taskid>-<role>"        # e.g. mirror-t13-coder, mirror-t13-gate
    mkdir -p "$M" && ssh root@62.238.106.231 \
      'cd /opt/hmis && tar czf - --exclude=node_modules --exclude=.git .' \
      | tar xzf - -C "$M"
    ```
    `<SCRATCH>` is your session scratchpad directory — a Windows path, so `Read`, `Grep`,
    `Glob`, `Edit` and `Write` all work natively against it.

    **The per-agent suffix is correctness, not tidiness.** Every agent in a pipeline SHARES one
    session scratchpad; `tar x` does not remove files the archive lacks; and clause (b) has you
    AUTHORING scratch inside the mirror. Without the suffix every later agent's "fresh" pull
    silently inherits every earlier agent's mutants, stubs and scratch specs — and they look
    exactly like files somebody left lying in the tree. In Plan 08 pipeline C two consecutive
    agents pulled trees carrying seven files that existed in no commit and had never been on the
    server (§2.40). A RETRY of your own task deliberately reuses your own directory: that is the
    state a retry is told to expect.

    **(b) Navigate and author in the mirror** with `Read`, `Grep`, `Glob`, `Edit`, `Write`.
    This is where you read shipped code, read the plan, and write your own files. It costs one
    tool call per operation instead of an SSH round-trip whose command and full output land in
    your context.

    **(c) Push the files you changed — ONE command, and the FILES LIST IS THE SYNC LIST.**
    `scp` exactly the paths your task's Files list names:
    ```
    scp "$M/<path>" root@62.238.106.231:/opt/hmis/<path>
    ```
    (batch several paths in one `scp` invocation). **If you find yourself syncing a file your
    Files list does not name, stop — that is a scope violation, not a sync problem.**

    **(d) CONFIRM THE SYNC LANDED before you run anything.** A stale server file under a green
    local edit is the one way this workflow can lie to you. After every push:
    ```
    ssh root@62.238.106.231 'cd /opt/hmis && git status --porcelain && md5sum <the files>'
    ```
    and compare against the local `md5sum`. Never run a test against a tree you have not just
    confirmed.

    **(e) Everything that produces evidence still runs on the server** — migrations, tests,
    `pnpm verify`, git, commit, push. Nothing about the evidence standard changes. The mirror
    is a reading and typing surface, not a build environment: there is no local Postgres, no
    local `node_modules`, and a result obtained locally would not be a result.

    **(f) The mirror is scratch, and you do NOT delete it.** Put it in your session scratchpad
    directory and leave it there: that directory is removed automatically when the job is
    deleted, and **`rm -rf` is denied outright on this host** by a standing deny rule
    (`Bash(rm -rf *)`) in the owner's settings. Every agent in Plan 08 pipeline B — and the main
    session — hit that denial trying to honour the older wording of this clause, and each one
    spent part of its report explaining a failure that was never its fault.

    So: do not attempt to delete the mirror, and do not report its survival as an unfinished
    step. It is not the owner's checkout (rule 2), it is never git-operated, and nothing is ever
    committed from it, so it cannot contaminate anything. **Server-side scratch under
    `/opt/hmis` is a different matter and you DO still delete it** — with plain `rm -f`, which is
    permitted — before your final counts and before committing.

    **(g) THE MIRROR IS A COPY, AND IT IS NOT EVIDENCE ABOUT THE SERVER'S TREE.** Read code from it
    freely — that is what it is for. But every claim of the form *"this file is present / absent /
    left behind / never cleaned up"* must be made against the SERVER, with `git status --porcelain`
    and `find`, in the same batch as the claim. A copy can only tell you what was true when it was
    taken and — per (a) — what somebody else put there. The failure this prevents is not a stale
    read: in Plan 08 pipeline C a reviewer used seven phantom files from a shared mirror to
    conclude, with executed evidence and in good faith, that a compliant agent had broken a hard
    rule and that a green `pnpm verify` could not have been green. It had been green; the files
    were never on the server. **A positive observation from a mirror is the dangerous one, because
    it arrives looking like a discovery.**

---

## 2. Evidence discipline

1. Long commands run detached with the exit VALUE read from a file (rules 16–18).
2. Test isolation is proved from OUTPUT (rule 19).
3. Race and flake measurement: confirm nothing else is running first; where the plan marks a
   row *measure*, the stated run count is a FLOOR, not a target — report the OBSERVED rate,
   keep running if the window has not opened, and never engineer the window.
4. **Fail-first** is owed by the attempt that does the work, and its failing output must be
   QUOTED. The fallback has an auditable precondition: if a PRIOR ATTEMPT AT THIS SAME TASK
   already pushed the artifact, you may skip the red run ONLY by NAMING THE COMMIT SHA that
   contains it. A dead rung that shipped nothing is not a prior attempt. Never manufacture a
   red by mutating shipped state: no throwaway databases, no relocating or deleting source
   files, no weakening a guard.
5. A red that is only an unresolved-import or typecheck error proves nothing. Where a test file
   cannot compile against unmodified shipped code, stage the deployable SUBSET that can,
   capture the SEMANTIC red, restore the full file, and disclose exactly what you staged.
6. When you assert something is ABSENT, name the fixture field that would have made it appear
   and confirm the fixture carries it. When you assert something BLOCKS, name the specific lock
   **and its mode**, and confirm no other lock the implementation takes produces the same wait.
7. Before you claim any count, run it and quote the runner's own summary line.
8. **Test-run economy:** run the NARROW suite while iterating; run the full workspace suite
   ONCE, at the end. A full suite per iteration is the most expensive habit available to you.

---

## 3. Mutant discipline — now scaled to risk

Every task carries a **risk tier** in its brief.

**CRITICAL** — money arithmetic, concurrency and locking, immutability, approvals and
permissions, anything that can silently produce a wrong number:
- Build every mutant the plan's Assertion Book names for your task.
- Separate scratch file beside the source; never edit, move, or revert the shipped file.
- Self-contained scratch spec; run ISOLATED; quote the isolation line.
- Record DIED or SURVIVED with counts, and quote expected vs received (rule 21).
- Fail-first is owed.

**ROUTINE** — config loaders, event catalogs, seed scripts, wiring, docs, screens with no money
maths:
- Tests are required and must pass. **Mutants are not required.**
- Fail-first is not owed; say so in your report rather than manufacturing one.
- If you *notice* an assertion that cannot discriminate, say so — that is a finding, and it is
  worth more than a mutant you were not asked to build.

**Both tiers:**
- Delete all scratch before final counts and before committing. `git status --porcelain` empty,
  no `*.mutant.*` residue, no frozen path in the diff.
- Frozen-path rules govern what may be COMMITTED. Transient mutant scratch that is never
  committed may sit beside its source even in a frozen directory — prefer a non-frozen location.
- **NEVER fix a surviving required-DIED mutant silently.** Two branches, disclose either way:
  (a) the survival implies the SHIPPED CODE IS WRONG, or the fix reaches outside your Files
  list → **CHAIN HALT**, commit nothing further, report it as a plan defect with evidence;
  (b) the survival means the PLAN'S TEST cannot discriminate and that test is YOUR OWN task's
  file → fix it minimally in-task and disclose it.

---

## 4. Counts

Do not chase a predicted per-task test total. The rule is:

- The workspace total must **not decrease**, and your diff must **delete no test**.
- Quote the runner's own summary line for the suites you added, by exact path.
- If a number in the brief disagrees with what you measure, **report the difference and its
  cause**. Never pad, split, merge, or delete a test to hit a number.

---

## 5. The finish block

Three numbered steps, in this order. Do not chain them onto one line.

0. **Before any `git add`:** run `git status --porcelain` on the server and READ IT. Delete
   every SERVER-side scratch file you created — mutants, scratch specs, `.log`, `.exit`, generated
   reports — with plain `rm -f`. **LEAVE YOUR LOCAL MIRROR ALONE** (rule 22(f)): you do not delete
   it and must not try. The tree must contain ONLY files your Files list names. Never run
   `git add -A` over a status you have not read.
1. **Commit** with the plan's EXACT commit message for your task.
2. `git pull --rebase origin main`
3. `git push origin main`

Then confirm and report: `git status` clean, and the resulting commit SHA. If step 2 conflicts
in a way you cannot resolve without rewriting pushed history, STOP and report — never amend,
never force-push (rule 15).

---

## 6. Migrations are irreversible host mutations

Running `db:generate` and letting a suite migrate it **mutates all per-worker databases**.
`git checkout` does not undo it. Plan 08 pipeline A run 1 generated an `0011`, applied it, then
deleted the file — leaving fourteen orphan tables and a phantom migration row in seven
databases and turning `origin/main` itself RED on the host, with no commit containing the cause.
It cost ~934k tokens and delivered nothing.

- Generate a migration only when you are ready to carry it to a commit.
- If you must abandon after one has been applied, **DO NOT delete the file and walk away.**
  STOP and REPORT which migrations are applied to the worker databases.
- Never hand-edit `drizzle/meta/_journal.json` to make the migrator skip anything, and never
  insert or delete a `drizzle.__drizzle_migrations` row by hand.
