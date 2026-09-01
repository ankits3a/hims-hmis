# Five radiology suites are RED on `main`, and it is not the workers, the neighbours or the tree

**Written 2026-09-01 by the VD-1 (vitals desk) lane, for the 18a radiology lane.** Not our module
and not our tests to change — this is the diagnosis with the discriminating experiment already
spent, so nobody repeats it. Found by VD-1's phase-end full pass; the experiment below was run by
the RC-2 lane.

## What is red

`src/modules/radiology/` — **`checkin`, `gates`, `gates.concurrency`, `schedule`,
`schedule.concurrency`**. Twelve tests across five suites.

```
RadiologyError: service 01M1EHP4TAZX42KS108QPT3P9D was already ordered for this patient
within 24 hours (R2608310001) — pass duplicateOfItemId and duplicateReason to order it again
  at src/modules/radiology/place.ts:270
  at placeAndCreateStudy (test/helpers/radiology.ts:212)
  at schedule.test.ts:80
```

## What it is NOT — four hypotheses, all killed by execution

| hypothesis | killed by |
|---|---|
| Another lane's uncommitted work | Two lanes reproduced it on **two different trees** |
| Cross-suite fixture leakage | `schedule.test.ts:28` does `truncateAll` in `beforeEach`; and it is red on a **virgin database** |
| The `maxWorkers: 2` ruling changed suite distribution | **Red at `-w 2` AND at `-w 7`**, identical counts |
| Co-tenancy with other suites | Red **run alone**, nothing else on the box |

```
radiology alone, fresh DB, -w 2 → 5 failed / 7 passed · 12 failed / 167 passed
radiology alone, fresh DB, -w 7 → 5 failed / 7 passed · 12 failed / 167 passed
```

**The owner's `maxWorkers` ruling (`42e7efc`) is exonerated: it neither caused this nor exposed
it.** This was red at the old default too.

## The two facts that point at the diagnosis

1. **Two orders collide INSIDE ONE TEST.** The `beforeEach` truncate rules out leakage between
   tests, so the duplicate is against a row the same test created.
2. **Two failing cases name DIFFERENT `serviceId`s and both collide with the SAME order,
   `R2608310001`** — sequence **0001**, the first order in a freshly truncated database.

So either the 24-hour duplicate guard's matching is **broader than its `(patientId, serviceId)`
signature suggests**, or `placeAndCreateStudy` is called twice per test for one patient and those
cases were always order-dependent. Both are cheap to distinguish from inside the module; neither is
safe to guess at from outside it.

## Why this note exists

The evidence lived only in cross-session messages, which do not survive. The 18a lane's own memory
records T1–T5 as pushed with green suites, so whoever picks it up will reasonably expect green and
should know that `main` is not.

**Nothing has been changed in `src/modules/radiology/` by either lane.**

---

## CORRECTION, appended 2026-09-01 after the 18a lane found the root cause

**RESOLVED at `f449f70`. The cause was a CALENDAR BOMB, and this report's remaining hypothesis was wrong.**

**Root cause (the 18a lane's, finding F28 in their phase doc):** `placeOrder` stamps
`placed_at = input.placedAt ?? new Date()`, and the test helper `placeAndCreateStudy` never passed
`placedAt`. So every order row carried the REAL wall clock while T3's duplicate window
(`orders.placed_at >= now - 24h`) was computed from the FICTIONAL `now` the helper threads through.
T4 and T5 space placements 25 fictional hours apart on the assumption that the two clocks agree —
and they agree only while real time sits behind `NOW + seq*25h − 24h`. The suites' `NOW` is
`2026-08-31T06:00Z`; `NOW + 26h` is `2026-09-01T08:00Z`. **Green all of 08-31, red all of 09-01,
with no code change in between.** One-line fix: `placedAt: now` in the helper. 12 suites / 179 tests.

**What this report got right, and it saved the owning lane four re-runs:** the four eliminations
above all hold — not `maxWorkers` (red at `-w 7` too), not co-tenancy, not cross-suite leakage, not
another lane's in-flight work.

**What this report got WRONG, struck here rather than left standing.** It offered as a candidate
that `findRecentItems` matched more broadly than its `(patientId, serviceId)` signature, on the
evidence that "two failing cases name different `serviceId`s yet both collide with the same order
`R2608310001`". **That is a misreading.** The two cases are separate `it()` blocks, each running
after `truncateAll`, so **the order sequence restarts every test and each test's first order is
`R2608310001`.** They are two different orders that share a number. `findRecentItems` filters
exactly as its signature says. There is no second defect; do not go looking for one.

**The methodological lesson, which is the durable half and is the owning lane's:**

> **A test that mixes a fictional clock for its assertions with the real clock for its rows is not
> deterministic — it is merely not failing yet, and it detonates on whoever runs it next rather than
> on whoever wrote it.**

And the corollary this report's own failure demonstrates: **every elimination here held the wall
clock constant by running now, so none of them could have distinguished a calendar bomb.** A defect
that reproduces perfectly today and would not have yesterday looks exactly like a deterministic
defect to any experiment run entirely today. When isolation, worker count and a virgin database all
fail to move a red, the next variable to vary is TIME, not topology.

**Ownership:** these suites predate T6 by about fifteen hours, not by a release — introduced by the
18a lane's own T5 helper usage on 08-31 and detonated on 09-01. The phrase "predates T6" earlier in
this report should be read that way rather than as ambient breakage.
