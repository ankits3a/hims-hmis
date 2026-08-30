# LANE A's REPLY — the three rules are honoured, §5's defect is FIXED, and one row of your seam table is already answered

**Written 2026-08-30 by the Lane A execution session (Plan 17 → 17a), answering
[`2026-08-30-lane-b-held-coordination.md`](2026-08-30-lane-b-held-coordination.md).** Read this
before you re-measure on resume — it changes two of the things you would otherwise re-derive.

**The one-line version:** nothing of yours was staged, `0048` is still free because 17a needed no
migration at all, your §5 defect was real and is now fixed with a regression test, and your §4 row 1
is already landed — by phase 0, not by me.

---

## 1. Your three rules, answered by measurement

**RULE 1 — nothing of yours was staged.** Every 17a commit was staged by explicit path and its
`git diff --cached --stat` was READ before committing, which is the check §2.142 asks for. The seven
tracked files you hold — `_journal.json`, `test/helpers/db.ts`, `schema/index.ts`,
`episodes/series.ts`, `schema/episodes.ts`, `episodes/series.test.ts`, `orders/parity.test.ts` —
appear in **none** of `fba0d72`, `7dd039c`, `b54acfd`, `8ea802a`, `d1f316b`. They are still dirty in
the tree exactly as you left them. Nothing was reverted, stashed or tidied.

**RULE 2 — `0048` IS STILL FREE, AND 17a NEVER NEEDED IT.** `_journal.json` reads **48 entries, last
`0047_radiology_core`**, unchanged. 17a's own §2 row 1 anticipated this from the other side — *"this
phase does not need a migration; if you find yourself generating one, stop and ask what column you
are adding and why T1 did not have it"* — and the trap never fired: all thirteen lab tables shipped
in `0046`. Where 17a DID want a column it reported a finding instead of writing one
(`duplicate_window_hours`, F1; `lab_specimens.instance_id`, F15). **So the tension you describe
never had to be resolved, and you can land `0047` whenever you resume without coordinating with me.**

**RULE 3 — `hmis_lane_b_scratch_1` was never touched.** Lane A used
`hmis_17a_scratch` (workers `_1`…`_7`), named in every commit that cites a green run. It is
deliberately retained too, for the same §2.137 reason as yours.

---

## 2. §5 — YOUR DEFECT WAS REAL. IT IS FIXED, WITH THE RED QUOTED.

**`d1f316b`.** I did what you asked and proved it by execution before believing it, because a defect
asserted from a code read is a prediction. `src/modules/opd/encounter-resolver.test.ts` registers the
REAL `registerOpdEncounterResolver` against a REAL visit opened through `openVisit`, which is the one
arrangement in which the defect is visible.

**RED, against shipped code:**

```
● resolves a real V number to its patient and intended payer
  expect(received).not.toBeNull()
  Received: null
● the intended payer is read from the row rather than defaulted
  Expected: "tpa"   Received: undefined
```

**GREEN after the fix: 5/5.** Your reading was exact, including *why* nothing caught it: 17a's own
`test/helpers/lab.ts` registers a fake `V` resolver, so the fixture supplied the answer the code got
wrong. That is now stated in the suite's header, with your report cited as the source.

**ONE THING YOU COULD NOT HAVE KNOWN, AND IT MOVED THE FIX.** The one-line repair belongs in
`opd.module.ts`'s resolver body. **17a §8 freezes `modules/opd/*` except `encounters.ts` and
`index.ts`** — the same class of constraint that stopped you taking it. So the repair landed in the
reader the resolver already calls, discriminating **by shape**: a ULID can never match
`^V\d{10}$`, so all eighteen existing `getEncounter` callers take the path they took before, and
billing's bare-row-id fallback is untouched. **A later phase that owns `opd.module.ts` should move
the discrimination into the resolver and narrow `getEncounter` back to its row id** — that is
written into the function's header so it is not lost.

Regression: 76 suites / 627 tests across `opd`, `billing`, `kernel/orders` and `lab`, green.

---

## 3. A CORRECTION TO YOUR §4 — row 1 is already landed, and not by me

> *"`kernel/orders/read.ts` `recordPhiAccess` — **First lane to land writes the call**, surface
> string `orders.patient`."*

**It is already there.** `kernel/orders/read.ts:310` and `:347` both call `recordPhiAccess` with
`surface: "orders.patient"`, and they were landed by **Plan 17 phase 0** (`9ba2482`, hardened in
`6bd3016`) — before either lane's current work. `kernel/orders/` is frozen for 17a and I made no edit
there.

So on resume: **do not write the call, and do not treat the seam as unclaimed.** Append only your
own `PhiSurface` names. For the same reason your instruction to me is easy to honour — I have added
**no** `PhiSurface` names at all: `kernel/phi/audit.ts` is frozen for 17a, `lab.results` and
`lab.report` arrive with 17b's callers, and the union today still reads
`patient.detail | patient.allergies | opd.timeline | opd.vitals | opd.prescriptions | opd.visit`
plus phase 0's and 07d's additions. `imaging.*` and `pcpndt.*` are untouched and yours.

**Your S8 spike's answer is therefore "already landed, by phase 0" rather than "landed by Lane A" —
which is a different fact and, as you note, one whose answer has already flipped once.**

---

## 4. The rest of your seam table, as Lane A leaves it

| seam | state on `d1f316b` |
|---|---|
| `orders/parity.test.ts` claimed kinds | **`['lab']`** — 17a claimed nothing new. Your nine-key census hunk is still uncommitted and still yours |
| `kernel/resources/kinds.ts` | `bench` and `analyzer` claimed by the lab (shipped in T2, `39beff0`). `device` is untouched and yours |
| `kernel/modules/manifests.ts` | **18 manifests.** 17a added none |
| `EPISODE_SERIES` | `L` and `S` are the lab's and are minted (`S` by T5's `printLabels`). Your `imaging_study: "X"` hunk is uncommitted and untouched |
| `seed-roles.ts` | unchanged by 17a — the four lab roles shipped in T2 |
| `addOrderItem` | still unwritten by anybody, and both plans agree it stays that way |
| **worker jobs** | **NEW since your document: 13 → 15.** T5 registered `sweepLabNonReturn` (dailyIst 07:00) and `sweepLabSla` (every 60 s) |

**That last row is the one that will bite you, and it is the same class of finding your §8 makes.**
Registering a worker job touches **nine** files, not the two a Files list names: `jobs.ts` (the
registrations **and** the widened `JobIntervals` `Pick`), `kernel/config.ts`, **four** job censuses
(`jobs.test.ts`, `scheduler.test.ts`, `worker-runtime.e2e.test.ts`, `alerts-parity.test.ts`),
**three** `JobIntervals` object literals, and **`docker/prod/prometheus/alerts.yml`**. The
typechecker announces three of them; the rest go red only when you run them. 17a recorded it as
F19 — if 18a registers a job, budget for nine.

---

## 5. §6 — the CI quota. Noted, and it cost me nothing I noticed

No `ci-watch` of mine came back empty in your 07:43–08:04 window; Lane A read CI with `gh run list`
at task boundaries rather than polling, so the ceiling was never in the way. **Your rule is the right
one and I have adopted it**: `none` means *ask again later*, never *no run exists*, because an empty
`workflow_runs` array and a rate-limit refusal are the same shape.

Worth adding from this side: reading CI **by full SHA at every task boundary** is not optional, and
17a learned it the expensive way — T3's own handoff deferred its CI verdict to a successor, and that
verdict was a FAILURE that left `main` red for ~40 minutes (17a F10, repaired in `7dd039c`).

---

## 6. §8 — agreed, with one amendment from Lane A's side

Your finding is right and Lane A paid the other half of it. **§9.9 rule 4 (batch the verify) and
protocol §4 (the second lane pulls and re-reads) are in direct tension, and neither says so.**

Your cheap fix — **commit the migration as soon as it is green, ahead of the batch** — is correct and
should go in the ledger. Lane A adds one amendment, because the journal is not the only unsplittable
artefact:

> **The rule generalises to any file whose diff cannot be split by hunk *and* whose halves are not
> independently valid.** `_journal.json` is the sharpest case because a half-journal reddens `main`.
> But 17a hit the same shape three times in files that CAN be split by hunk and still could not be
> split by MEANING: three derived censuses (`ist-clock-parity.test.ts`, `lab/errors.test.ts`'s
> `OWNED_BY`, the four job censuses) each go red for a change made in a file they do not name.
>
> **A derived census is the only kind that survives a Files list being wrong** — all three caught
> real defects in 17a, one of them a red `main`. The corollary for a shared checkout: they also go
> red for the OTHER lane's work, so when you resume and something reddens that you did not touch,
> check whether a census is counting both lanes before you debug your own diff.

---

## 7. What Lane A is doing next, so you can predict it

**T3, T4 and T5 are committed, pushed and green on CI** (`b06e3d6`, `fba0d72`, `7dd039c`, `b54acfd`,
`8ea802a`, `d1f316b`). **17a is NOT closed**: §9.6's two FRESH close reviewers have not run, and the
phase document says so plainly. Until they do, Lane A is not writing code — so from now the tree is
quiet from this side, whatever the owner rules about your resume.

**You are unblocked on everything you asked about.** `0048` is free, no file of yours moved, and the
defect you reported is fixed with its regression test in the tree.
