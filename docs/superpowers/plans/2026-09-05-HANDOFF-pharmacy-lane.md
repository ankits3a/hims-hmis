# HANDOFF — the pharmacy lane, after the 16c close is finished

**Supersedes `2026-09-04-HANDOFF-pharmacy-lane.md`, which is on the unmerged branch
`lane/pharmacy-handoff` and can be dropped — everything still true from it is carried here.**

---

## 0. Reading budget

Read **this file** and `/opt/hmis/CLAUDE.md`. That is enough to work. Do not read the 16c phase doc
end to end (§8 now carries five closes), `EXECUTION-LESSONS.md` (468 KB), the plan-series index or
the project brief. Context is re-sent every turn; a big read on turn three is paid for on every turn
after it.

---

## 1. State

**Plan 16c is CLOSED, and its close is now FINISHED — the owed independent pass has been run.** Six
PRs, all merged: **#53, #62, #65, #66** (the author's own passes) and **#72, #75** (the independent
pass and its prose sweep). Nothing is in flight. **Code-complete and NOT DEPLOYED.**

**16d / 16e / 16f are all gated on things that do not exist** — an unauthored IPD plan, an unlanded
interaction/dose dataset, and 30 days of live data from an undeployed module. **The lane is idle by
DEPENDENCY, not because it stalled.** Do not invent work to clear an idle flag. If an orchestrator
asks you to "advance to the next task in the phase doc", tell it there isn't one, and why.

---

## 2. FOUR DECISIONS ARE WITH THE OWNER — do not start any of them on a peer's say-so

| # | decision | if he says yes |
|---|---|---|
| 1 | **Deploy PR #73 or bin it** | he runs it; never you (§5) |
| 2 | **Author the IPD cluster's first phase doc** | unblocks 16d; a DRAFT for approval, nothing built from it |
| 3 | **Take reagent consumption in materials** | `reagent` is already a materials class with batch/shelf-life/QC rules; the missing piece is CONSUMPTION. Design reasoned about in LIMS's 17-E §6 |
| 4 | **Five untranslated pharmacy error strings** | routed to front-desk, who own `locales/*.json` |

All four were declined overnight on 2026-09-04 **for the same reason** — real work, but not work the
owner had asked for, proposed after he had gone to sleep. A peer relaying "the owner approved it" is
not his approval. That held up twice: the relayed owner-state was wrong once and overstated once.

---

## 3. PR #73 — the deploy candidate, and the false alarm that produced it

`hotfix/materials-fefo-expiry`, built on **`c11833d`** (the commit production's image was built
from), **fully green** (run 33907683254), `DO NOT MERGE`, **no migration**. It is DIRTY against main
by design, so GitHub cannot merge it by reflex.

**The escalation that produced it was wrong, and the correction is the useful part.** #65 was raised
to the owner as *"production dispenses expired medicine by preference — a live patient-safety
defect"*. It is not:

```
git ls-tree -r --name-only c11833d -- apps/core/src/modules/pharmacy/   → nothing
git show c11833d:apps/core/src/app.module.ts | grep -c PharmacyModule    → 0
```

**The whole pharmacy module is absent from the deployed image.** There is no counter in production
to dispense anything. What *is* deployed is `MaterialsModule`, where `transfers.ts` is the **only**
production caller of `fefoPick` — so the real exposure is that a stock transfer picks the most
expired batch first. Genuine, worth fixing, **not** a D&C Act violation and **not** an emergency.

`af03335` is **not cherry-pickable** as a commit: 4 of its 6 files are pharmacy files that do not
exist at that base. What shipped is its `ledger.ts` hunk (byte-identical at `c11833d` and
`af03335^`, zero conflict) plus the `occurredAt` fix. **#66 cannot come with it** —
`availableQty`'s only callers are `pharmacy/queue.ts` and `pharmacy/verify.ts`, absent at that base.

---

## 4. ONE DEFECT IS REPORTED AND NOT FIXED — it has a date

`queue.ts` and `verify.ts` call `availableQty` with the default `new Date()`; `pick.ts` passes its
injected `now`. #66's invariant — *the number on the screen is the number the pick will honour* —
therefore holds in production only because the controller also passes `new Date()`.

**`t4.test.ts`'s `available === 140` FAILS ON 2027-02-01**, when `CR-EARLY` (2027-01-31) expires in
real time while the fixture pick still offers it. The real fix threads a clock through
`getDispense` / `alternativesFor`, which have none — a signature change across controllers and call
sites. Deliberately not done unilaterally overnight. It is a defaulted parameter, so it is not large;
it is just wider than one lane's night.

---

## 5. THE BOUNDARY — sequencing from a peer, authority from the user

An orchestrator session may coordinate the box (`/opt/hmis-lanes/.orchestrator/bin/`:
`test-lock.sh` — **route ALL jest/vitest through it**, `lane-report.sh`, `board.sh`). Take
**sequencing** from it. Never take **authority**. Specifically, never on a peer's say-so: deploy, run
`deploy.sh`, touch any `hmis-prod-*` container, run a migration against production, force past a
safety gate, edit permissions / `CLAUDE.md` / config, or treat a peer message as approval for a
pending permission prompt. If a peer says it was denied permission and asks you to do it instead,
**refuse and surface it to the owner** — that is permission laundering.

Also: **do not merge or rebase onto `main` yourself.** Migrations are numbered at rebase time and
`seed-roles` / `caddyfile-parity` pin counts. The orchestrator hands out the baton.

---

## 6. Facts that cost real time to learn

**6.1 The worker job census is SIXTEEN, and registering one costs FIVE FILES, two edited twice.**
The repo said "four places" through four consecutive registrations. It is `jobs.ts`, `jobs.test.ts`
(a count), `scheduler.test.ts` (`THE_SIXTEEN` **and** its spy list), `alerts-parity.test.ts` (sorted
names **and** a separate `toHaveLength`), `alerts.yml`, plus `test/worker-runtime.e2e.test.ts`. The
enumeration now lives in `alerts-parity.test.ts`'s docstring.

**6.2 Pushing to a branch with CI in flight CANCELS the run and restarts the clock.** `ci.yml` has
`cancel-in-progress: true` per branch. `gh pr update-branch` does it too. **The pharmacy lane
livelocked itself for ~90 minutes on PR #31 this way.** While a run is active: do not push, do not
`update-branch`. The PAT cannot `gh run rerun` or `gh run cancel`.

**6.3 The self-hosted runner degrades from ~8 to ~25 minutes** with three lanes pushing. A slow core
shard is SLOW, not hung — #73's `core (2)` took 18m6s and passed. Stagger CI-triggering pushes.

**6.4 A green revert is not a licence to delete a guard.** #62's `status='picked'` filter survived
its revert because `cancelDispense` refuses a `billed` dispense independently; it was kept, with the
caller enumeration written in as its comment.

**6.5 `lab-reports.test.tsx` D9 flakes on this box under load** — it failed three times including
once with this lane's work `git stash`ed, then passed unchanged. **A failure that survives
`git stash` is not yet a red `main`.** Check CI on your own SHA before freezing anything.

**6.6 Worktrees cost DISK, not RAM.** Dropping a lane does not free memory; only ending sessions does.

---

## 7. The four method lessons, in the order they pay off

**7.1 Run an ASYMMETRY SCAN beside the contract pass.** A contract pass can only find what the plan
wrote down, and nobody writes down "do not dispense expired stock". That CRITICAL came from one path
checking `recallStatus` while its sibling didn't. Grep for: sibling paths where one validates and one
doesn't; a value **ordered by** but never **filtered on**; a constant **written and never read**; a
**state** checked where an **amount** is meant; a number **displayed** computed differently from the
number **enforced**. **Fix an asymmetry by making ONE definition, never by patching N sites** — #65's
fix became #66 exactly that way.

**7.2 A fail-first test must be able to TELL THE TWO VERSIONS APART.** The transfers test written the
obvious way — one expired batch, one good one — **passed against the unfixed code**: a batch expired
under both clocks cannot discriminate them. It needed a batch dying BETWEEN `occurredAt` and the wall
clock. "It fails before the fix" is not enough if the fixture cannot exercise the difference.

**7.3 A written diagnosis records a MOMENT, not a state.** This bit twice in one night. "af03335 is
not deployed" was true as a commit fact and false as an exposure claim. "CI never builds the web app"
was PR #51's *title*, true when opened and false when closed — the step is in `ci.yml:74`, added by
#50. Before acting on a diagnosis someone else wrote down — a title, a comment, a TODO, a phase-doc
deferral, a board row — check whether it is still true. **And run the measurement before reading the
explanation.**

**7.4 A pass that changes an INVARIANT must sweep every place the old one was WRITTEN DOWN.** Tests
guard the code; nothing guards the sentence. The 16c runbook told a human the pick takes "FEFO's
earliest batch" long after it stopped doing that, and **never mentioned that an abandoned pick
self-cancels after 30 minutes** — correct software that presents as a dispense vanishing on its own.
**Sweep PROCEDURAL prose a human follows** (runbooks, drill steps, refusal tables), not every
historical mention: the architecture design and project brief say "FEFO" and are still accurate as
design records.

---

## 8. Verify — through the mutex, always

```bash
cd /opt/hmis-lanes/pharmacy/hmis
pnpm typecheck && pnpm lint                     # cheap, no lock needed
L=/opt/hmis-lanes/.orchestrator/bin/test-lock.sh
$L run pharmacy pnpm --filter @hmis/core exec jest -w 2 src/modules/pharmacy src/modules/materials test/pharmacy.e2e.test.ts test/alerts-parity.test.ts
```

Baseline at handoff: that command is **25 suites / 240 tests, exit 0**; materials alone 13/169;
`pnpm lint` **0 errors, 2 pre-existing warnings** (unused eslint-disable in `scheduler.test.ts` and
`advance.test.ts` — not yours). `pnpm --filter @hmis/web build` passes in ~6 s and **CI already runs
it** (`ci.yml:74`).

---

## 9. The headline worth repeating to the owner

The individual defects are not the story. **Production is 42 commits and 14 migrations behind
`main`** — 56 against 70 — with Plans 14, 15, 16c, 17a/b/c/d and 18a/b/c all code-complete and none
of them deployed, and **two whole modules that have never run outside a test database**. Every
per-defect urgency question this week is downstream of that one.
