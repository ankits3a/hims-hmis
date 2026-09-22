# HANDOFF — the radiology lane, 2026-09-12

**Paste this file's §0 as the opening prompt of the new session.** Everything else is reference.

---

## 0. THE PROMPT

> You are the radiology lane. Worktree `/opt/hmis-lanes/radiology/hmis`. Read `CLAUDE.md` and this
> handoff; **read nothing else until a task names it.**
>
> The goal is unchanged: **get the radiology module launched.** Coordinate with the orchestrator
> session (`ListAgents` → the `hmis-lanes-*` one) — it drives the merge train, holds the board, and
> assigns goals. Tell it you are picking the lane back up and ask what is live.
>
> **Re-measure before you believe anything below.** This handoff was written 2026-09-12 and the
> repository's own recurring defect is a diagnosis inherited past its truth. Every number here is a
> measurement with a date on it, not a fact.

---

## 1. STATE IN ONE PARAGRAPH

Radiology's code is essentially complete and **the launch gate is not code**. 18a (core), 18b (DICOM
seams) and 18c (AERB registers) are deployed. 18a-iii (contrast, bedside, outside study, chasers) is
merged and closed. Everything this lane opened is merged — nothing of ours is in flight. **The one
remaining code gap is the ordering door: nothing in the product can place an imaging order.** Its
plan is authored and on main (`18a-iv`) and deliberately unbuilt, because building a clinical surface
is the owner's scope call, not a lane's. The three things that actually block launch are data and
people in production, and none of them is an agent's act.

## 2. MEASURED 2026-09-12 — re-measure at kickoff

**This table went stale inside ten minutes, which is the point of the instruction above it.** It was
written at `594e1cf`; the 11i stack (#117–#122) and #171 landed while it was being written and
`origin/main` became **`0960ca6`**, with the production deploy staged for the owner's hand. Treat
every row as a reading with a timestamp, never as a fact.

| fact | value |
|---|---|
| `origin/main` | **`0960ca6`** (was `594e1cf` ten minutes earlier — re-read it) |
| the 11i stack `#117`–`#122` | **landed** |
| open PRs anywhere | `#73` only — a deploy-candidate hotfix marked DO NOT MERGE — per the orchestrator, 2026-09-12 |
| open PRs from this lane | **none** |
| worktree | clean, on `lane/formf-backfill-clock` (merged; cut a fresh branch from `origin/main`) |
| the ordering door | **still absent** — `radiology/orders` has 0 callers in `apps/web/src` |
| plans on main | `docs/superpowers/plans/2026-09-06-phase1-18a-iv-radiology-ordering-door.md`, `…-phase1-20-workforce-roster.md` |

## 3. WHAT BLOCKS LAUNCH — all three are the owner's, none is code

**In this order, because the order changed once already:**

1. **Does production hold the five imaging machines as `device` resources at all, and an active
   `study_types` book?** `seed:radiology` could never succeed on a fresh deployment until it was
   fixed, so production may never have been seeded. **18c's licence gate points at a device registry
   row** — if the machines do not exist, "enter the certificates" has nothing to attach to. This
   precedes everything.
2. **The RSO — and it is TWO preconditions, not one.** Somebody must *hold* the
   `radiation_safety_officer` role (an application permission, what lets them file a licence) **and**
   have an `aerb_persons` appointment row (the statutory appointment, carrying AERB's own reference).
   The app will let you complete every licence with the second missing and nothing refuses.
3. **The certificates**, entered until `GET /aerb/licences/gaps` returns empty. Then real imaging
   prices and the SAC ruling for the `investigation` GST category — **one CA ruling that covers the
   laboratory too**, not two.

**Never read the production database to answer these.** "Never touch `hmis-prod-*`" covers a SELECT.
The orchestrator has written the queries out for the owner.

## 3b. YOUR ASSIGNED ROW — and a correction to make before you accept it

The orchestrator will hand you **ROADMAP-v2 §2 week 3: "Plan 20 authored by R"**. **That row is
already DISCHARGED** — Plan 20 was authored in this lane and merged as **#150**, and
`docs/superpowers/plans/2026-09-06-phase1-20-workforce-roster.md` is on main. Verified 2026-09-12.
**Say so before you start, or you will write a second plan for the same phase.**

The live row after it is **week 4, "Plan 20 built by R"** — and it is gated on the owner approving
the plan, which had not happened as of this handoff. §2 of that plan corrects the roadmap's own
sizing three times over: the consumer count is **3 runtime files + 2 seed scripts**, not the "five"
or the "seven" the roadmap states in two different places; a second resolver (`usersHoldingRoleAtScope`)
goes unnamed; and *"the chaser's destination is already a configuration row"* is **half true** — it is
`usersHoldingRole(tx, DUTY_MANAGER_ROLE)`, a constant in `kernel/alerts/consumer.ts`, so making it a
row is **work inside the phase** (D6/T5). The blast radius is smaller than the roadmap says, but one
of the three files belongs to everyone, so **the cost is coordination, not count.**

**Two corrections measured by the orchestrator after this file was written:**

- **ROADMAP-v2 §0c is wrong that no `deploy-blocker` label exists.** It exists, red, correctly
  described — so §0 row 10's rule is live, not inert.
- **The catch-up deploy's rehearsal gate (§0c.1) is NOT met for `0960ca6`.** The last restore drill
  was 2026-09-05 and rehearsed production's own image (migrations 56→56); no candidate image exists
  on the daemon. **"The deploy is staged and ready" is on several boards and is not true yet.** The
  commissioning lane holds it.

## 4. THE OTHER BUILD, WHEN THE OWNER SAYS GO

**Phase 18a-iv — the ordering door.** Plan is on main; §2 carries the ground truth. The finding that
sizes it: `AdvisedTest` is `{serviceId, code, name, pricePaise}` — **service-generic, not
lab-specific** — and the doctor's picker searches the whole active price list. **A physician can
advise "CT head, plain" today**; it lands in `encounter.advisedTests` and prints on the prescription,
and the only consumer of that rail anywhere is `lab/desk.ts`. So this is not a new clinical workflow;
it is the missing consumer of a rail already carrying imaging lines. Four tasks, six decisions, no
owner ruling.

**After it:** the contrast **reaction** route (18a-iii T2) has no screen either, and 18a's safety gate
reads the allergy it writes — the loop exists at both ends and cannot be entered in the middle.

**Also authored and waiting:** Plan 20, the workforce/roster substrate. One owner ruling in it
(whether an on-call phone number lives in this system — DPDP), blocking nothing.

## 5. TRAPS — every one of these cost this lane real time

- **`pnpm build` is cwd-dependent.** Exit 0 from `apps/core`, **254** from the repo root. A whole
  department was walked against a day-old `dist` because of it. Use `pnpm --filter @hmis/core build`,
  and **assert the artefact, not the exit code** — a chain ending in `echo "X=$?"` always exits 0, so
  the harness's completion code carries no information.
- **Drop the lane test databases whenever the tree's journal and the database can have DIVERGED** — a
  merge does that, **and so does switching between your own branches.** A green run on a poisoned
  database looks exactly like success.
- **Backticks in a double-quoted `gh --body` or `git commit -m` EXECUTE.** Always `-F -` /
  `--body-file -` with a quoted heredoc. Knowing this is not sufficient; make the safe form the
  default form.
- **Every scripted patch asserts its anchor is unique.** A guard meaning *"a script may not retire
  what a human approved"* nearly landed in the **approval route** and made it refuse itself — the
  block appeared twice and the diff would have looked right either way.
- **Prove a mutation LANDED, then prove the failure is the one you PREDICTED.** A mutant that "kills"
  a test which never ran is the most dangerous false green, because red is the outcome you want.
- **The CI twin proves a failure is REAL, never that THIS PR caused it.** Several PRs red at once on
  unrelated diffs → suspect the base or the clock.
- **`gh pr update-branch` writes a merge commit to your branch** under the token's account, so it
  reads like a peer touched your work. Your next push is then rejected as non-fast-forward.

## 6. VERIFY

```
pnpm typecheck && pnpm lint
/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run radiology \
  pnpm --filter @hmis/core exec jest -w 2 <paths…>
/opt/hmis-lanes/.orchestrator/bin/board.sh          # who else is running, free memory
```

Never run a bare `pnpm verify`. Use the test lock for anything heavy.

**Standing up a dev stack and walking it in a browser** is the method that found nearly every real
defect this lane closed — the recipes are in memory under `radiology-standup-recipe` and
`lab-standup-and-walk-recipe`. Use `:5433` (dev); **`:5434` is `hmis-prod-db-1`.**

## 7. OPEN FINDINGS WITH NO OWNER

- **Nothing writes `attributes.aeTitle` anywhere**, so `GET /radiology/mwl` returns empty on every
  deployment, permanently, and the PACS runbook's own proof step can never pass. 18b's plan foresaw
  it (*"if not, T1 adds `POST /radiology/devices/:id/ae-title`"*) and closed the spike the other way.
  **Recorded, not fixed — reopening it is a scope decision.**
- **There is no resources screen and no create route**, so `seed:radiology` is the only writer of an
  imaging device. A hospital adding a second CT edits `MODALITY_MACHINES` and re-runs. That is a
  deployment act where a hospital act belongs.
- **18a-iii's contrast record, contrast reaction and outside-study register have zero web callers.**

## 8. HOW THIS LANE WORKS

One lane per session, `/opt/hmis` stays on main, commit by pathspec, never `git add -A`. The
orchestrator drives every merge — **lanes do not merge.** Fail-first on every fix, and a fix is done
when the suite has run and the count is read, not when it compiles. Owner rulings are for money,
procurement and law only; anything else, pick the standard Indian-corporate-hospital answer, mark it
DECIDED, and keep going.

**Two habits worth inheriting.** Verify a peer's claim before acting on it — several of this lane's
best findings came from a handed-over diagnosis being half right, and the orchestrator asks to be
corrected. And when a sweep is owed, **define the class by its property, not by a string**: this lane
made the instance-versus-sweep error three times at three levels (the site, the grep pattern, the
document section) before changing the instrument instead of the fix.
