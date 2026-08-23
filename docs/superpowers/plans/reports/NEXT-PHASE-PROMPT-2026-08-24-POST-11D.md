# Prompt — the phase after Plan 11d

> **For a fresh session.** Written 2026-08-24 by the session that executed 11d and deployed it.
> **Nothing in this document is ground truth by the time you read it.** Re-measure everything §1
> tells you to; this project has produced five specimens of §2.78 (a coordinate is a claim with no
> expiry date) in a single run, and two of them happened to the session that was writing about it.

---

## 0. Where things actually stand

**Plan 11d SHIPPED and DEPLOYED, 2026-08-24.** Gate report
[`plan-11d-gate-report.md`](plan-11d-gate-report.md) **including its ADDENDUM** — the body says the
plan is not live and the addendum says the deploy ran; **only the addendum is true now.**

**On the live box at `https://hmis.crkmch.com`:**
- Nine services up, `/health` 200, **`alertmanager` scraping `up`, three rule files, eight rules,
  zero firing.** A critical alert reaches a human inbox, and the alert path now watches itself —
  on the EMAIL side only.
- **Fifty-four grants across nine roles**, verified by reading the
  `users → role_assignments → role_permissions` join, never the seed script's own report.
- **STILL ONE USER — `admin`, with NO PIN.** So those grants are authority nobody holds.

**11c's MAJORs 1, 2 and 3 are closed in code** (advisory lock, the four-leg permission map, the
alert-path rules). MAJOR 4's other eight doors are closed by `seed:roles`.

## 1. Ground truth — verify, do not trust

- `git pull --rebase origin main` on the build host and **record the SHA you are at.** This
  document was written at **`e4604d6`**. Docs commits land from the owner's machine while you work —
  it happened five times during 11d's run, twice mid-task.
- **Re-measure the baseline** detached, exit VALUE from a file: `apps/core` was **148 suites / 1109
  tests**, `packages/contracts` 3/7 at `e4604d6`. **`apps/web` read 34/175 against a 173 baseline
  because another session had four uncommitted files in the build checkout** — check whether that is
  still true before you compare anything, and **do not touch those files** (rule 8).
- **Re-read production's actual state** before planning anything that depends on it. §B-MEASURED's
  numbers are from the morning of 2026-08-24 and were already stale by that evening.

## 2. Read first, in this order

1. **`EXECUTE-METHOD-V3.md`** — **v3 governs every phase after 11d.** 11d ran under v2 by explicit
   exception. v2 remains in force only as the HEAVY-lane pipeline manual that v3 §2 invokes.
   **Read v3 first and let it tell you which lane this work belongs in.**
2. **`plan-11d-gate-report.md`, whole, including the ADDENDUM.**
3. **`plan-11d-findings-inbox.md`** — 400+ lines, and the densest thing in the repository right now.
   Its discovery-review section carries two MAJORs that six per-task gates missed.
4. **`EXECUTION-LESSONS.md` §2.81-§2.86 and §3.51-§3.53** — the nine entries 11d earned. §2.81 is
   the one to read twice.
5. **`AGENT-RULES.md`** — the contract, unchanged.

## 3. The decision this session makes

**The roadmap RULES Plan 09 next** (owner, 2026-08-23) — *"after the in-flight 11c/11d work
settles"*, ahead of 11b's hardware wait and 12a. **Whether 11d has "settled" is the question**, and
there are three honest candidates:

**(a) Finish 11d's flag ③ — the staff half.** Not a plan; two owner actions and one script run.
`seed:staff` needs a roster on stdin (username, full name, initial password, optional PIN, roles from
the nine). Then a real login reaching one granted route and one refused — **the only evidence the
whole chain works, and no test can produce it.** **This is cheap and it is what makes the hospital
usable. Do it first unless the owner says otherwise.**

**(b) Plan 11e — user administration over HTTP.** Booked in the roadmap with its trigger marked
ARRIVED. It inherits **MAJOR 1** (see below), the seed-time-only password floor, and the absent
credential-reset flow. It is the highest-privilege write in the system, so §3.42's four legs from
day one.

**(c) Plan 09 — memberships/coupons, re-shaped for channel-partner intermediation.** The owner's
2026-08-23 ruling changes its scope substantially: a legacy/partner-book import task, a
receivable-commission instrument, sales OFF in Phase 1. Commercial terms live out-of-git at
`hmis-context/plan-09-channel-partners-2026-08-23.md`.

**Ask the owner which, and say what each costs.** Do not assume the roadmap's order survives contact
with (a) still being open.

## 4. The open items, ranked by what they block

1. **`seed:staff` has not run.** Blocks a usable hospital. Owner supplies the roster.
2. **`workflow.*` needs an owner ruling.** All eight strings are not-yet-modelled, so **no account
   can perform the two-key `opd_visit` activation that go-live runbook step 4 demands** — the
   runbook cannot be completed end to end. **Shortest path from "operable" to "a patient can be
   seen."** Most likely: grant `workflow.definitions.draft`/`.approve`/`.activate` to `owner` and
   `medical_superintendent`.
3. **MAJOR 1 — `seed:roles` computes its census and READY verdict from SOURCE CONSTANTS**, not the
   database. Measured: claims 42 held where 33 are granted. `seed-admin.ts` returns early on any box
   that already has an admin, so a newly declared `auth.*` permission can never be granted there
   while the census counts it held — **MAJOR 4's mechanism inside the artefact built to abolish it.**
   Fix: derive `held` from the intersection of the model and what the database actually holds.
4. **Nothing watches the IN-APP alert path**, or `consumer.poisoned`, or `event_dead_letters`. The
   README promises mode-change alerts travel in-app, not by email. **11d closed the half that
   carries five rules to an inbox and left the half that carries the sixth to a browser.**
5. **`deploy.sh` carries a FOURTH hand-maintained copy of the rule-file census** (the `note`
   brace-list), in the file whose two lists D8 was written to unify. ~6 lines to close.
6. **Flag ④ is evidenced but not reproducible** — the `promtool` drill files were scratch. Nothing
   re-runs that proof. Re-homing them needs a SUBDIRECTORY (`ruleFilesOnDisk()` would otherwise fail
   its own leg 2) and a CI step, which is an **owner action** under rule 10.
7. **`seed:staff`'s writes are not transactional**; **`seed:opd` has never run against production**;
   **stale `/opt/hmis/apps/core/dist/`** on the build host.

## 5. What 11d learned that will change how you work

- **§2.81 — a plan's STATED mutant is itself a prediction.** 11d built 32 mutants and every
  required-DIED one died — **and twelve Book rows or design claims were refuted by execution.** Only
  one row survived contact intact. **When a task reports its stated mutant cannot fail, that is a
  discovery worth more than the kill it was asked for.** Write Assertion Books expecting this.
- **§2.82 — walk the ASSERT-ON graph, transitively, to a fixpoint** — including assertions the
  widening task adds in the same commit, which a compile-time sweep structurally cannot see. The
  File Structure gives every file one owner; it does not model which files assert on which files'
  behaviour, and that is the graph a widening change travels along.
- **§2.83 — amending a task's BODY without amending the File Structure** is §2.54 one document
  earlier, because §2.25 generates the frozen block from those lists.
- **§2.84 — query CI by FULL SHA.** `gh run list --commit <short>` returns `[]` silently, which is
  indistinguishable from DID-NOT-RUN.
- **§2.85 — byte-check for NUL as well as CR** on anything authored through a heredoc.
- **§2.86 — never add a REQUIRED field to an event on an appended immutable stream.** Optional, with
  the consumer carrying the fallback.
- **The discovery reviewer is the best-value agent in the process, four runs running.** 11d's cost
  9% of the run and found the two things six per-task gates missed. **Do not skip it. I nearly did.**

## 6. Standing constraints

**Rules 3 and 7 as amended** govern every path and container decision · **`hmis-db-1` is the dev
database; `hmis-prod`'s database and volumes are a live hospital's data** · **the repo is PUBLIC —
no password, PIN, roster or owner email in any commit** · **never rewrite pushed history** ·
**never weaken a guard to produce evidence** · **the deploy is authorized only when the owner names
it**, and expect the safety classifier to block production operations even then — **it blocked the
11d deploy and two database reads after the owner had authorized in as many words. Do not work
around it; ask.** A `Bash(ssh root@62.238.106.231:*)` allow rule via `/permissions` is what
unblocks an unattended run, and **a session cannot add that rule for itself.**
