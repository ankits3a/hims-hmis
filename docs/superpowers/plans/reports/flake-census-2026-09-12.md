# Flake census by content — the suite's load-sensitive assertions, ranked

**2026-09-12.** Commissioned after `#169` proved the method on this board: a test that demands
determinism from a surface which never promised it fails under load, looks like a new flake each
time, and costs every lane on the board a CI cycle.

**This is the list, deliberately without fixes.** Five classes were swept by content — **and §0 below
is a sixth that a content sweep could not have found, already on the board before this census ran.
Read it first.** The point of reporting before fixing is that the fixes land in different modules and
can be sequenced across lanes instead of colliding in one PR — and that the ranking is visible, so the
cheap ones are not done first by accident.

**Headline: two of the five swept classes are already clean, and the largest live item is three
instances of one bound, two of which the board did not know about.** And **load-sensitivity on this
board is proven, not inferred: two PRs that changed no code at all went red** — one on §0's hook
ceiling, one on item 1's lock-settle budget — each with a green same-SHA twin. Which class accounts for
the most reds is not measured here and is not claimed.

---

## The ranked list

| # | site | class | exposure |
|---|---|---|---|
| **1** | `membership/entitlements.contention.test.ts:206` | fixed ms budget | **high — unreported** |
| **2** | `membership/entitlements.contention.test.ts:234` | fixed ms budget | **high — unreported** |
| **3** | `partners/accrual.test.ts:584` | fixed ms budget | high — known (F11(a)) |
| **4** | `test/perf-search.test.ts:107` | completeness of best-effort | medium-high |
| **5** | `kernel/search/registry.test.ts:151` | completeness of best-effort | medium |
| **6** | `kernel/search/registry.test.ts:164` | completeness of best-effort | medium |
| **7** | `test/lab.e2e.test.ts:220` | fixture from the real clock | low-medium |
| — | `modules/ot/bill.ts:565` | **not a flake — a correctness finding** | see §6 |

---

## 0. WHAT A SWEEP OF THE CODE CANNOT SEE — read this before re-running the census

**Source: `/opt/hmis-lanes/.orchestrator/BLOCKERS.md:905-925`, written by an earlier session and
found only after this census was delivered.** Named here so the next sweep starts from what the board
already knows instead of rediscovering it.

There is a sixth class, it was already diagnosed, and its conclusion is **stronger than anything the
five classes below could have reached**: a 15 s hook ceiling (`jest.config.cjs:27`'s `testTimeout`,
which applies to hooks) blown by three structurally unrelated setup paths inside one window —

    lab suites        beforeEach -> truncateAll + seedLabDeskBase      ~1.84 s per test
    partners/accrual  beforeAll  -> CREATE DATABASE + migrate()        906 ms per worker
    opd e2e           beforeEach -> the OPD seed chain + nine grants    80.5 s suite, one hook died

**In all three the average is nowhere near 15 s and a SPIKE did it. Three independent paths is no
longer evidence about a fixture; it is evidence about the runner.**

The corroboration is as clean as this board gets for free, and it is **broader than this one class** —
measured, not taken on report:

    BLOCKERS.md:905   docs-only, 1 file, +222/-0   red: test/opd.e2e.test.ts   15 s HOOK ceiling
    #176              docs-only, 1 file, +91/-37   red: membership/entitlements.contention.test.ts
                                                        -> this census's items 1 and 2, the 300 ms
                                                           lock-settle budget, ALREADY FIXED in #175
    both: the same-SHA twin job PASSED ENTIRELY.

**A docs change cannot break a core test.** Two docs-only PRs, two *structurally different*
load-sensitive assertions, both with a green same-SHA twin. That is stronger evidence for the runner
than two instances of one class would have been — and note the second one's fix is already written and
held by the freeze, so it will keep firing until #175 lands.

Measured on `#174` the same night: **47m37s against a twin's 10m27s on the same SHA.** A 4.5×
wall-clock skew between identical jobs is the finding.

### CORRECTION — the runner is NOT this box, and that settles the fix direction

The first draft of this section said the skew "is about what else was running on the box." **That is
wrong**, and it is worth keeping the correction visible because the wrong version points at a lever
that does not exist. Measured:

    .github/workflows/ci.yml:79, :121, :152    runs-on: ubuntu-latest
    grep -rn "self-hosted" .github/            (nothing)

**All three CI jobs run on GitHub-hosted runners.** Nothing about lane load on this 15 GB host, the
test mutex, a docker build, or six sessions on this terminal moves that skew. The test mutex still
matters and still binds — it governs local jest pools and docker builds, which genuinely do share this
box — but that is a different resource from the one CI spends.

So the earlier session's inference survives and sharpens: *three structurally unrelated paths is
evidence about the runner* — **and the runner is one nobody here administers.**

> When the instrument is someone else's datacentre, the budget IS the thing you control.

That retires the objection that raising a budget is "treating the instrument". You cannot make a shared
runner quieter; you can only stop asserting a wall-clock figure that a quiet runner happens to meet.
**Which makes item 1's `SETTLE_CEILING_MS = 2_000` (#175) the actual fix and not a workaround** — and
the same reasoning applies to every other fixed-millisecond assertion on this page.

### Why this census could not have found it, which is the part worth carrying

This census swept **code** for patterns, exhaustively, and that is the right instrument for an
assertion that demands determinism from a surface which never promised it. But *"three unrelated paths,
therefore the runner"* is **an inference across incidents over time**, and no grep over a tree can see
it. It lived in the board's prose, not in the suite.

> Before sweeping a tree for a failure class, read what the board has already concluded about
> failures. A code sweep answers "where is this pattern"; it cannot answer "what do these incidents
> have in common".

The same gap let a peer session publish a "fifth flake class" on 2026-09-12 that was neither fifth nor
a class: it read `duplicate key value violates unique constraint "opd_config_pkey"` as a non-re-entrant
fixture helper, when the line ABOVE it in the same log was this section's hook timeout and the
duplicates were its residue. The discriminator was free — the same aborted hook also threw
`users_username_ux`, which the proposed fix could not have touched. **A diagnosis that explains symptom
1 and is structurally incapable of explaining symptom 2 is not the cause.**

### And it changes the fix direction, including the obvious one

The tempting fix for the OPD hook is to hoist its invariant setup out of `beforeEach` — nine
sequential DB groups per test, of which `truncateAll`, `seedOpdBase`, `activateOpdVisitDefinition`
(the full three-person Class A ceremony) and `seedOpdMasters` do not change across the suite's tests.
That is correct engineering and worth doing on its merits. **It would not have saved any of the three,
because none of them is slow on average.** Treating one suite's structure is treating the instance.

It is also not the two-token change it looks like: `truncateAll` in `beforeEach` wipes whatever
`beforeAll` seeded, so hoisting means moving the truncate too and **proving no test reads state the
previous one left.**

**Logged as census item 9: the runner's load — not a fixture, and not a timeout number.** Raising
`jest.config.cjs:27` globally is the wrong lever: that file is a shared surface, line 33's
`maxWorkers: 2` carries an owner ruling, and a bigger number hides every other slow-hook problem
behind it.

---

## 1. Fixed-millisecond wall-clock budgets — 3 live, all the same bound

```
partners/accrual.test.ts:584                    expect(settleMs).toBeLessThan(300)
membership/entitlements.contention.test.ts:206  expect(settleMs).toBeLessThan(300)
membership/entitlements.contention.test.ts:234  expect(settleMs).toBeLessThan(300)
```

All three are the same test shape — *a writer BLOCKS while another session holds a row, and settles
on its COMMIT* — and all three measure `Date.now() - releasedAt` against **300 ms**.

**Only `accrual.test.ts:584` is on the board.** It is recorded as F11(a) and has been *measured at
348 ms on a loaded runner*. The two in `entitlements.contention.test.ts` are the identical
construction against the identical bound and have never been reported. **That is three dice on one
number, not one.**

The bound's own comment argues it is safe: *"the spike measured 0 ms; the bound is loose enough to
survive a busy build host."* The 348 ms observation contradicts that for the accrual instance, and
nothing distinguishes the other two.

**What these tests are actually for is not in dispute** — that a lock-waiter settles promptly after
the holder commits, rather than hanging. The question for whoever fixes them is whether that
property needs a wall-clock number at all, or whether *settled before the next assertion observes
it* expresses the same thing without a stopwatch.

### Lower-exposure budgets, listed so nobody re-finds them as new

These assert that **a timeout FIRED**, which is the robust direction — they fail only if the machine
stalls for a multiple of the budget:

- `kernel/db/client.test.ts:99` — `elapsed < 5_000` on a connect that must time out
- `kernel/search/registry.test.ts:148` — `elapsed < SLOW_PROVIDER_MS`, which is the budget **× 8**
- `test/auth.e2e.test.ts:97` — `fastest < 1000`, and it is the **minimum of 5 samples**

### And the perf suites are already hardened — cite them as the pattern

`perf-patient-search`, `perf-opd-queue` and `perf-search` all gate on **`fastest(times)` over 5
runs**, not a mean or a single sample. `perf-opd-queue.ts:21` carries the analysis in full: the
plan's 300 ms board ceiling *"sat INSIDE the measurement noise (observed medians 246-251 ms
isolated, 270-310 ms under full-suite parallel load, single samples to 390 ms)"*, so it was raised
to 500 **and** the gate moved to `fastest`, which *"is ~225 ms and barely moves with load (225.0
contended vs 225.8 clean)"*.

**That is the fix shape for class 1**, already proven in this repository by someone who measured it.

---

## 2. Completeness demanded of a best-effort surface — 3 live

Two budgeted surfaces exist, both 250 ms per provider:

```
kernel/desk/registry.ts:7     DESK_PROVIDER_BUDGET_MS = 250
kernel/search/registry.ts:9   PROVIDER_BUDGET_MS = 250
```

### The asymmetry that decides exposure, and it is not obvious

**The desk DROPS a timed-out provider's card** (`runOne` resolves `[]`, so no card appears) — the
returned *set shrinks*, which is why `#169`'s three exact-set assertions flaked.

**Search KEEPS the group** and marks it `timedOut: true, hits: [], total: 0`. **So the group set
does not shrink**, and the exact-set assertions over it are *safe*:

```
registry.test.ts:112, 197, 214, 228   exact group sets      NOT at risk
```

**Two surfaces with the same budget and opposite failure modes.** An audit that treated them alike
would either miss the desk's three or file four false positives against search.

### The live instances are the ones asserting a timeout did NOT happen

1. **`test/perf-search.test.ts:107`** — `expect(res.groups.every((g) => !g.timedOut && !g.errored)).toBe(true)`.
   This demands that **no provider exceeded 250 ms**, inside a *performance* test that exists to run
   under load. Highest of the three, and the same shape as `#169`.
2. **`registry.test.ts:151`** — `{ timedOut: false, total: 7 }` on a deliberately fast provider.
3. **`registry.test.ts:164`** — `{ errored: false, total: 7 }`, same.

(2) and (3) use trivial in-process providers, so they need a severe stall — but 250 ms is 250 ms.

---

## 3. Real DB writes under `jest.useFakeTimers()` — ZERO live

All three candidate files are hardened, and this class is **closed**:

- **`kernel/worker/jobs.test.ts`** — the V12 defect is fixed and its own comment records what it
  was: *"ticks, so EIGHT real writes, and it ran all of them with `jest.useFakeTimers()`
  installed."* The fake window is now scoped (`:415` → `:440`).
- **`kernel/worker/scheduler.test.ts`** — scoped windows, with `useRealTimers()` at `:717` and
  `:784` and an explicit *"Real timers here — no `jest.useFakeTimers` active in this test"* at `:881`.
- **`test/opd-lifecycle.e2e.test.ts`** — fakes for the whole file and is nonetheless **the exemplar**:
  `doNotFake` lists every fakeable API *except* `Date`, so only `new Date()` is pinned while every
  socket, pg timer and `setTimeout` stays real. It is taken from a spike that *measured* a live pg
  round-trip containing `pg_sleep(0.2)` still taking 203 ms of real wall time under it.

**If a suite needs a pinned clock and real I/O, copy `opd-lifecycle.e2e.test.ts:157`.**

---

## 4. A fixture derived from the real clock — 1 live

**`test/lab.e2e.test.ts:220`** — `const today = istDayString(new Date())`.

Right time zone, so this is not the UTC defect. The residual risk is the **straddle**: a suite that
takes minutes can cross IST midnight between deriving `today` and asserting against rows stamped
later. That is the `lab-reports` D9 shape, which was a real failure once.

Low-medium: the window is one instant a day, and the rest of this suite pins its dates explicitly
(`new Date("2026-08-29T05:00:00Z")` two lines below).

---

## 5. Non-unique random identifiers — ZERO live

Every random suffix in the suite is `Math.random().toString(36).slice(2, 9)` — **7 base-36
characters, ~78 billion values** — or `slice(2, 7)` (~60 million). Neither collides in practice.

The dangerous one is **already fixed**: `kernel/db/schema/lab.test.ts:76` documents that
`specimenNo` *"used to be `Math.floor(Math.random() * 90) + 10` — 90 possible values for a UNIQUE
column"*, which collided about 1 run in 90. **This class is closed.**

---

## 6. Not a flake, and the sharpest thing the sweep found

**`modules/ot/bill.ts:565` buckets day-care discharges by UTC date in an IST hospital.**

```sql
and (e.discharged_at::date = ${day}::date or e.converted_at::date = ${day}::date
     or e.updated_at::date = ${day}::date)
```

`discharged_at` is `timestamptz`, and `timestamptz::date` resolves in the **session** time zone.
Measured: the container's `TimeZone` is `Etc/UTC`, and nothing in `client.ts`, `jest.config.cjs` or
`test/helpers/db.ts` sets it. So `::date` is the **UTC** calendar date.

**A day-care discharge at 02:00 IST on 1 April is 20:30 UTC on 31 March**, so it buckets to 31
March. The orphan scan run for "today" does not see last night's discharge — and the function's own
header says *"a discharged day-care encounter with no invoice is reported HERE or by nobody."*

**The test agrees with the code, which is why no suite is red:** `ot/bill.test.ts:763` derives
`new Date().toISOString().slice(0, 10)` — also UTC — and passes it in. The test and the query share
the same wrong zone, so they are consistent. **That consistency is what hid it.**

This is the F52 class the radiology and PCPNDT code guards against explicitly (*"the statutory date
is the server's IST day, never the caller's — the browser's UTC day is yesterday between 00:00 and
05:30 IST"*), arriving in SQL instead of in JavaScript.

### And the instrument that exists for this is blind to it

`test/ist-clock-parity.test.ts` keeps one clock everywhere by pinning a `SITES` list of **JavaScript
expressions** — `330 * 60_000`, `5.5 * 60 * 60 * 1000`, `IST_UTC_OFFSET_MINUTES * 60_000`. It
**cannot see a SQL `::date` cast.** One site exists today (`ot/bill.ts:565-566`, three casts in one
query), so the class is small and containable — but the census that would have caught it does not
look there.

**A guard keyed to one language cannot see the same defect expressed in another.**

---

## What the census says about the 19%

Three of the seven live items are one bound in one test shape, and the class that *sounds* most
alarming — real writes under fake timers — is closed, with a documented exemplar to copy. The
classes are not evenly loaded, and two of them are finished.

**The two findings worth more than the list itself:**

- **Two surfaces with the same 250 ms budget fail in opposite ways** (desk drops, search marks), so
  the exposure of an assertion depends on which one it faces. `#169` fixed the dropping side; the
  marking side needs only the three `timedOut: false` assertions looked at.
- **The `ot/bill.ts` UTC bucketing is invisible because its test shares the error.** A test that
  agrees with the code proves they agree, not that either is right — and here the agreement is the
  only reason nothing is red.
