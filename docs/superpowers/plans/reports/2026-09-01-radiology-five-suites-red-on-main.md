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
