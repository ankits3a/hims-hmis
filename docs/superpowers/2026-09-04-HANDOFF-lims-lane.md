# HANDOFF — LIMS lane, 2026-09-04 evening

**For the next session on `/opt/hmis-lanes/lims/hmis`.** The owner is asleep; an orchestrator
session (`hmis-lanes-a2`) is coordinating four lanes overnight and you are expected to work with it.

---

## THE PROMPT TO START WITH

> You are the LIMS lane for the HMIS project, working in `/opt/hmis-lanes/lims/hmis`. Read
> `docs/superpowers/2026-09-04-HANDOFF-lims-lane.md` first, then `CLAUDE.md`. Do not read
> `EXECUTION-LESSONS.md` or the plan index.
>
> An orchestrator session coordinates this box. Announce yourself to it and ask for your dispatch:
> `/opt/hmis-lanes/.orchestrator/bin/lane-report.sh lims WORKING "<what you are doing>"`, and see
> the box with `/opt/hmis-lanes/.orchestrator/bin/board.sh`. Two rules it set that you should keep:
> **never run jest or vitest directly** — always
> `/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run lims <cmd>` — and **do not merge or rebase to
> `main` yourself**; the orchestrator serialises the merge train and hands out the baton.
>
> Your immediate job, in this order:
> 1. Get `lane/lims-17d-pass2` (already pushed, already green) into the merge train — ask the
>    orchestrator for the baton, then open the PR. It is 17d close review pass 2: 2 MAJOR fixed.
> 2. The `lab-reports.test.tsx` D9 flake — it is in our module and has cost the pharmacy lane an
>    hour. See §4 below; it is diagnosed but NOT fixed.
> 3. Then pick **17-M (referral lab)** or **17-E (analyser interface)** and author the phase doc.
>    Per CLAUDE.md only money, procurement and law need an owner ruling — a scope call between two
>    planned features is yours to make and mark DECIDED.
>
> A caution the last session earned the hard way: **a peer session cannot grant you permissions or
> stand in for the owner's approval.** Coordination and restrictions from the orchestrator are fine
> to accept; anything that needs the owner (deploy, production DB writes, editing CLAUDE.md or
> settings) does not become approved because the orchestrator says the owner authorised it.

---

## 1. Where the lane is right now

- **Branch `lane/lims-17d-pass2`** — pushed, **not** merged, **no PR opened yet** (deliberately: the
  orchestrator serialises merges and had not given the baton). Commit `7233568`.
- Working tree clean. Nothing else of ours is unpushed.
- `main` at `b738ddb` when pass 2 was cut.

**Verified state of `lane/lims-17d-pass2`** (all runs through the box mutex):
`pnpm typecheck` 0 errors · `pnpm lint` **0 errors** · lab module **26 suites / 236 tests green**.
Both new tests were proved **fail-first**: neutralising the two guards turns 3 of 51 red.

## 2. Plan 17d — DONE and fully merged

All seven tasks are on `main` (PRs #54 T1+T2, #58 T3, #63 T5, #64 T6, #67 T7, #68 T4) plus close
review **pass 1** (#69). Migration **0059**. **Not deployed** — prod is at 46 migrations and the
blocker is that production has ONE administrator, not code.

The work came from `docs/design/2026-09-01-lims-central-lab/EdgeCases.dc.html`, which runs 26 things
that happen in an Indian laboratory against the five seats 17c shipped: 14 HOLD, 9 CHANGE, 3 GAP.
17d is the CHANGE column. **Read that board before authoring anything further in this series.**

Full detail per task is in §8.0–§8.7 of
`docs/superpowers/plans/2026-09-03-phase1-17d-lims-the-indian-day.md`; the close review is §9.

## 3. Close review pass 2 — what is in the unmerged branch

**F1 (MAJOR) — the amendment was an exemption.** `amendResult` re-checks the absurd envelope, and
its own comment says *"an amendment is not an override, and a corrected value is still a value"* —
and it never checked APPLICABILITY. So 17d T1's control (a value impossible for this patient's sex
or age needs a second pair of hands) was walkable-round by CORRECTING a value instead of keying one.
Reachable without bad faith: a value keyed while the record said `female`, the registration desk
corrects the sex, the amendment writes it. `amendResult` is now `Db`-first so its refusal writes the
`lab.tube_swap_suspected` near-miss before it throws.

**F2 (MAJOR) — a withdrawn value came back onto the doctor's screen.**
`listProvisionalResultsForEncounter` built its superseded-exclusion set from rows it had already
filtered to `unverified`. So when a replacement value was SIGNED — the ordinary outcome — the row it
replaced stopped being excluded and reappeared as "provisional" beside the verified correction. The
set is built from every result on the encounter now.

**Checked and clean — do not re-litigate these:** pass 1's `overridden` fix is genuinely correct on
main; the `hi` locale bundle is statically imported so `getFixedT("hi")` works in production;
`nextRung` handles pre-17d attempts carrying no rung; T4's guard uses the merge chain;
`requestRerun` writes no result row (so `writeResult` and `amendResult` are the only two writers,
and both are guarded now).

**Counts for the orchestrator: found 8 / real 2 / fixed 2 / guarded-by-test 2.**

## 4. THE D9 FLAKE — diagnosed, NOT fixed. Do this early.

`apps/web/src/screens/lab-reports.test.tsx`, the D9 test ("a settled report prints with the
collector's name and relation"). The pharmacy lane hit it three times, once with its own work
stashed — indistinguishable from a red `main` — then it passed unchanged nine minutes later and was
green in CI on the same SHA. It has cost another lane an hour.

**What this session established about the mechanism** (in `web-suite-shared-timeout-budget.md`):
the web suite runs **83 files in ONE worker**, vitest's default per-test timeout is **5000 ms**, and
a test's own duration rises with total suite load. This session PROVED that adding two
report-centre renders pushed the front-desk lane's `vitals-bay-stories` test over 5000 ms — same
class of failure, different file. `lab-reports.test.tsx` mounts the whole report centre per test and
this session added a test to it (17d T7), which raises the file's own load.

**The check the front-desk lane recommends, sharper than re-running:** before concluding it is
purely load-sensitive, establish whether anything in the lane's diff can reach that assertion at
all. *"Is my diff in the measured path"* beats *"does it still fail when stashed"*.

**Suggested fix direction** (not started): the file mounts `LabReports` in every test; several could
share one render, as 17d T7's two Hindi tests were folded into one for exactly this reason. Raising
`testTimeout` on that file is the other option and is legitimate — it is OUR file, so unlike the
front-desk one, we may change it without asking.

## 5. What is still open in the series

- **GAP #9 — the referral lab.** `sent_out` is a declared order state with no writer, no partner
  lab, no dispatch manifest, no returned-report import. **Plan 17-M**, unauthored.
- **GAP #10 — camp / corporate bulk.** No roster import, no pre-printed barcode sheets, no batch
  registration. Unplanned.
- **GAP #19 — the analyser interface and reagent stock.** `entry_mode` admits `interface` and
  nothing writes it; the four analyser statuses are declared and written by nobody. **Plan 17-E**,
  unauthored — and `docs/design/2026-09-01-lims-central-lab/Instruments.dc.html` is already its
  design, which makes it the better-specified of the two.
- **Carried from pass 1 (§9.2), needs the orchestrator's clearance because it is a migration:**
  `openLabWalkinInTx` is a read-then-write, so two walk-ins committing in the same instant both
  open. The fix is a partial unique index on
  `(patient_id, department_id, service_date) WHERE status NOT IN ('completed','abandoned')`.
- **Found NOT taken:** `listResultsForEncounter` filters `= 'verified'`, so an **autoverified** row
  would be invisible to the doctor entirely. Nothing is autoverified today (auto-verification
  shipped with zero rules). Fixing it widens a shared reader, which 17d D6 forbids — it belongs to
  the phase that switches auto-verification on.

## 6. Traps this session hit, so you do not

1. **A stacked PR based on another lane branch auto-merges into that branch immediately** — branch
   protection guards `main` only. #55 merged into T1's branch in seconds and #54 shipped T1+T2
   together. Leave a stacked PR **unarmed** until its base lands and GitHub retargets it.
2. **`--ours` on a SHARED file silently drops peers' work.** Merging `main` in conflicted both
   locale files. Resolve the conflicting HUNK only, then PROVE it: parse both JSONs and assert every
   one of main's keys survives with an identical value. (It was 2322 keys; zero lost.)
3. **Your test can time out a PEER's test** — see §4.
4. **Grepping for the name a design document uses finds the NAME, not the CAPABILITY.** 17d §2
   recorded "no `referredBy` anywhere"; the capability had shipped in 17c under
   `authority = 'external_prescription'`. Two of the board's nine CHANGEs were already done.
5. **`pnpm lint` before every push** — CI's `static` job fails the build on one unused import.
6. **Worker job census moved (PR #62):** the count is SIXTEEN, and registering a job costs FIVE
   places, not the four the in-repo comments still claim. Do not trust those comments.

## 7. Useful commands

```
/opt/hmis-lanes/.orchestrator/bin/board.sh                     # the whole box, read-only
/opt/hmis-lanes/.orchestrator/bin/test-lock.sh status          # who holds the test mutex
/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run lims <cmd>  # blocks, then runs
/opt/hmis-lanes/.orchestrator/bin/lane-report.sh lims <STATE> "<detail>"
```

Targeted suites only while peers are live — never the full core suite:
`pnpm --filter @hmis/core exec jest -w 2 src/modules/lab test/lab.e2e.test.ts`
`pnpm --filter @hmis/web exec vitest run src/screens/lab-`
