# Agent rules — the binding contract for every pipeline agent

**Every task brief points here instead of inlining these rules.** Read this file in full
before you touch anything. Where this file and a task brief disagree about PROCESS, this file
wins; where they disagree about CODE, the plan document wins.

Version 2 (2026-08-19; rule 22 amended 2026-08-20 and 2026-08-21; rules 20 and 21 amended 2026-08-21; **rule 6 RETIRED and rules 7 and 9 AMENDED 2026-08-22 — the InsForge co-tenant was removed and the build host is now dedicated to this project; read rule 7's new boundary before you create any container**). Supersedes the inlined tripwire
block used through Plan 08 pipeline A. ~~Rule 22 (the local mirror) is new and changes how you read
and author files — read it first. **22(a) now requires a mirror directory unique to YOU, and 22(g)
forbids concluding anything about the server's tree from a mirror; both were bought by §2.40.**~~

**AMENDED 2026-08-23 — the topology ruling ([`EXECUTE-METHOD-V3.md`](EXECUTE-METHOD-V3.md) §8):
authoring moved ONTO the build host, effective with the v3 pilot phase (11e).** Rules 1–3 restate
to one sentence, rule 13 and all of rule 22 are STRUCK, and rule 18 narrows — each marked in
place below, the rule-6 pattern. Privileges, rules 7 and 14–21, and the evidence standard are
unchanged: evidence still comes only from this host — it is simply no longer remote. One
vigilance note from the ruling, recorded so it is watched rather than discovered: production
paths are now reachable by native file tools instead of visible SSH calls, so rule 3/7
discipline carries the weight the SSH boundary used to make conspicuous.

---

## 1. Hard rules

Violating any one of these fails the task regardless of code quality.

**Hosts and paths**

> **RESTATED 2026-08-23 (v3 §8) — rules 1–3 compress to one sentence: you are ON the build
> host; `/opt/hmis` and `/opt/hmis-prod` are the only writable paths; the owner's Windows
> checkout is not reachable from any session and stays out of scope.** The bodies below stand
> as the record and their boundaries are unchanged; where they speak of SSH round-trips or a
> remote server, read "this host".

1. **The build host is the server: `root@62.238.106.231`, checkout `/opt/hmis`.** Everything
   that produces EVIDENCE — migrations, tests, `pnpm verify`, git, commits, pushes — runs
   there and only there. It is the host CI matches; a result obtained anywhere else is not a
   result.
2. **NEVER write, edit, or run any git command against the owner's Windows checkout
   `C:\Users\ankit\hmis`.** It is the owner's docs working copy, not a build environment.
   If you discover you have written there, report it and LEAVE IT EXACTLY AS IT IS — do not
   delete, revert, stash, or clean it. It is not yours to clean. (Reading it is also not
   needed: rule 22 gives you your own mirror.)
3. **AMENDED 2026-08-22 (Plan 11a's deploy directory).** **`/opt/hmis` (the build checkout) and
   `/opt/hmis-prod` (the production deploy directory) are the only writable paths on the server.
   NO writes to `/tmp`, ever**, for any reason — not even a throwaway sanity check.
   `/opt/hmis-prod` holds deploy-script-managed configs and the production `.env` ONLY: it is
   never scratch, never a mirror, never a checkout, and a task may write it only when its brief
   says so in as many words.

   > **AMENDED 2026-08-28 — OWNER RULING, Plan 14 close. THIS RULE OVERRIDES THE HARNESS'S OWN
   > SCRATCHPAD INSTRUCTION, AND THAT IS NOT A CONFLICT YOU NEED TO RESOLVE AGAIN.**
   >
   > Every Claude Code session is told by its harness to put temporary files in a session
   > scratchpad under `/tmp`. **That instruction does not apply here.** Two consecutive phases
   > spent part of a report discovering the contradiction — Plan 14's execution session committed
   > one breach and disclosed it in its CLOSE (§6.5), and its successor spent a paragraph
   > re-deriving the same conclusion. The owner ruled on 2026-08-28: **§1.3 stays absolute.** The
   > reason is containment, not tidiness — anything an agent writes must land where
   > `git status --porcelain` can see it and `rm -f` can clean it, and a `/tmp` path is invisible
   > to both the next agent and the owner.
   >
   > **THE SANCTIONED ALTERNATIVE, so nobody rediscovers it a third time: do not write a file at
   > all.** Pipe the script into an interpreter on stdin, via a quoted heredoc:
   >
   > ```
   > python3 - <<'PY'
   > ...your script...
   > PY
   > ```
   >
   > The quoted delimiter (`<<'PY'`, not `<<PY`) is load-bearing: it stops the shell expanding
   > `$`, backticks and `!` inside the script, which is what turns a working script into a silent
   > corruption. This handles essentially every case a scratchpad was wanted for — multi-line
   > edits, JSON surgery, source scans. **Where a real file IS unavoidable** (a detached run's
   > `.log` and `.exit` per rule 18, a mutant module per rule 21), it goes under `/opt/hmis`,
   > **`git status --porcelain` is READ before any `git add`, and it is deleted with plain
   > `rm -f` before committing** (§5 step 0). That is the whole of the workaround.
4. Keep any scratch file under `/opt/hmis` ~~(server) or your own mirror (local)~~, and delete it
   before committing. *(The mirror clause is struck with rule 22; `/opt/hmis` is now the only
   place scratch can go — see the 2026-08-28 ruling in rule 3, which also gives you the way to
   avoid writing a file at all.)*
5. **NEVER run a command that emits compiled JavaScript into the source tree** (bare `tsc`,
   `tsc -b`). Typecheck only via the repo's own `pnpm typecheck` / `pnpm verify`, which pass
   `--noEmit`. Jest resolves `.js` before `.ts`, so stale emit silently shadows sources.
6. **RETIRED 2026-08-22 — the co-tenant is gone and the host is now dedicated to this project.**
   ~~Never read, stat, list, or reference `/opt/InsForge` or any `insforge-*` container — not even
   read-only. It is an unrelated co-tenant stack on the same host.~~ The owner removed the InsForge
   stack on 2026-08-22 (four containers, ten volumes, its images and `/opt/InsForge`); the box is
   now this project's alone. **The rule is struck rather than deleted** because briefs compiled
   before that date cite rule 6 by number, and an agent reading one must be able to see what
   happened rather than find a gap. Nothing replaces it: there is no co-tenant left to avoid.
   *(An archive of the removed stack sits at `/opt/insforge-archive-2026-08-22/`, owner-owned. It
   is not yours: do not read it, do not delete it, do not include it in any diff.)*
7. **AMENDED 2026-08-22, TWICE — first when InsForge was removed, again the same day when the
   owner ruled that stage-1 production SHARES this box (Plan 11a brainstorm).** ~~Create no docker
   container.~~ **Create no docker container EXCEPT under the `hmis` or `hmis-prod` compose
   projects, and only when your task's brief says to.** The original absolute existed to protect a
   shared docker daemon that no longer exists (rule 6) — but it cannot survive Plan 11a unchanged,
   because that plan's entire job is to ship a production compose, and *"create no container"* and
   *"ship a compose file"* cannot both be true. The boundary that replaces the absolute, and it is
   narrow on purpose:
   - Containers you create belong to a compose project you can name, and it is `hmis` (dev),
     **`hmis-prod` (the stage-1 production stack, Plan 11a — dev and production deliberately do
     NOT share a project name, so a `compose down`/`up` against one can never act on the other)**,
     or a clearly-temporary project of your own (`hmis-spike`, `hmis-drill`) that **you remove
     before you report**. A container nobody named is a container nobody will clean up.
   - **`hmis-db-1` and the `hmis_hmis_pgdata` volume are the dev database. Never stop, remove,
     rebuild or prune them.** The suite's per-worker databases live in there.
   - **Once `hmis-prod` exists, its database container and volumes are PRODUCTION DATA and are
     exactly as untouchable** — with one stricter clause: no agent stops, restarts, or removes any
     `hmis-prod` container unless its task's brief says so in as many words.
   - **Never run a blanket `docker system prune`, `docker volume prune`, or `docker rmi -a`.**
     Remove by explicit name, always — a prune cannot tell your scratch from the dev database, and
     once production exists it cannot tell either of those from a live hospital's data.
   **Create and drop no database by hand**; the test suite manages its own per-worker databases.
   The one exception is a scratch database you create with a name that is obviously yours, use,
   and drop in the same task — and if you cannot drop it, say so rather than leaving it silently.
8. The owner may be working on the same host from the same IP and SSH key. Never infer from
   logs, timestamps, or file mtimes who did what. Report only what you yourself did.
9. Guard every `apt` invocation with `NEEDRESTART_MODE=l`. **(Amended 2026-08-22: the docker
   daemon is no longer *shared* — rule 6 — but the guard stands. It now protects THIS project's
   own database container and any running pipeline, which is a smaller blast radius and an
   equally unwelcome one.)**
10. The server's deploy key CANNOT push `.github/workflows/*` — GitHub refuses it. If you
    believe a workflow edit is needed, STOP and report instead of editing.
11. `git pull --rebase origin main` before writing: docs commits land from the owner's machine
    while pipelines run.

**Integrity**

12. **Evidence over assertion.** Never report a test as passing without having run it in that
    state. Commit with the plan's exact message; include `pnpm-lock.yaml` on any dependency
    change.
13. **STRUCK 2026-08-23 (v3 §8) — sessions run on the build host, so Write and Edit target
    `/opt/hmis` natively and there is no Windows path to mangle.** ~~NEVER pass a POSIX
    absolute path (`/opt/...`) to the Write or Edit tools — you run on a Windows host, so that
    silently creates `C:\opt\...`. Write and Edit are for your LOCAL MIRROR (rule 22), which
    has a Windows path. Files reach the server by sync, never by Write/Edit.~~
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
18. **NARROWED 2026-08-23 (v3 §8): the dropped-SSH-channel failure mode is gone — the
    detached-with-exit-file discipline stays, for genuinely long runs, on this host.**
    Original text, whose mechanism survives without the `ssh` wrapper:
    **Run any LONG remote command DETACHED** with its own exit code written to a file — never
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
    **READ THE MATCHED COMMAND LINES, NEVER THE COUNT.** `pgrep -af jest` is almost always run
    inside a compound `ssh root@... 'cd /opt/hmis && ... pgrep -af jest ...'`, and that shell's
    OWN command line contains the literal string `jest` -- so it matches ITSELF, once per shell,
    and prints hits that look exactly like concurrent test runs. Two agents have already read
    their own probe as somebody else's suite. Look at what each matched line actually is.
21. **NEVER claim an assertion DISCRIMINATES unless you built the mutant and watched it FAIL.**
    A hand-walk of "a wrong implementation would produce X" is a prediction, not evidence, and
    it has been wrong in BOTH directions in the same plan. Build the wrong implementation as a
    SEPARATE scratch file beside the source (never by editing, moving, or reverting the shipped
    file), run the test against it, and report DIED or SURVIVED with counts. **A mutant that
    dies at TYPECHECK proves nothing** — this repo compiles with `noUncheckedIndexedAccess`, so
    an indexed array literal dies at `TS2532` before any assertion runs. **A second, sneakier
    case: a class with `private` members is compared NOMINALLY, so a byte-copy mutant of such a
    class cannot be passed to a function typed against the shipped one.** Copy the one
    intermediate module between mutant and test, repointing ONLY its `import type` (§2.61).
    When a mutant will not compile, ask whether the obstacle is the LANGUAGE or the ASSERTION
    before rewriting either. A kill is evidenced by
    the ASSERTION's own failure: quote expected vs received.

**The local mirror**

22. **STRUCK IN FULL — all of (a)–(g) — 2026-08-23 (v3 §8): the reading surface and the
    evidence host are the same machine. No mirror, no `scp` sync, no md5 confirmation; §2.40's
    entire class is structurally impossible. Every reference to "your local mirror" elsewhere
    in this file (§2, §5 step 0) is struck with it; server-side scratch discipline — plain
    `rm -f` before committing — is unchanged.** The struck text stands below as the record:

    ~~**Author and navigate LOCALLY; run and commit REMOTELY.**~~ Reading and grepping the codebase
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
