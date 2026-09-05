# Connection pool and statement timeouts — an evidence pack, not a proposal

**Investigation only. No configuration was changed, and none should be changed from this document
alone.** Pool sizes and statement timeouts are numbers with production consequences on a live
database; this exists so the owner can decide with measurements instead of estimates.

Measured 2026-09-05 against `main` at `dff9d14`.

---

## The two claims that started this, both verified

```
$ grep -rn "new Pool(" apps/core/src tools scripts | grep -v '\.test\.'
apps/core/src/kernel/db/client.ts:9:  const pool = new Pool({ connectionString: url });

$ grep -rn "statement_timeout\|lock_timeout\|idle_in_transaction" apps docker tools scripts
   (three matches, all of them PROSE in comments or tests — none sets anything)
```

One pool constructor in the whole non-test tree, with **no `max`** (so pg's default of **10**), no
`connectionTimeoutMillis`, and **no server-side statement or lock timeout anywhere.**

---

## Q4 — does the worker share the API's pool? **No. Two processes, two pools.**

`createDb` is called twice: `app.module.ts:50` and `kernel/worker/worker.module.ts:65`. They are
separate OS processes, so the ceiling is **10 + 10 = 20** connections, not 10. That is the good news
and it is why the API does not die when the worker saturates.

---

## Q1 — connections under the sixteen jobs, and the shape that has no bound

**Every job that WINS its advisory lock holds one pool client for the job's entire lifetime.** This
is deliberate and correct — `pg_try_advisory_lock` is session-scoped, and `scheduler.ts`'s own
comment explains that releasing the client without unlocking would strand the lock. The loser
releases immediately.

So an in-flight job costs **one pool client for the lock, plus a connection for each of the two
heartbeat writes and its own work.**

**Eight interval jobs share the sixty-second boundary, permanently.** Their cadences all divide
60 000 ms, and `scheduler.start()` creates every `setInterval` in one synchronous loop, so their
phases are aligned for the life of the process:

| job | cadence (default) |
|---|---|
| `runDispatchCycle` | 2 000 ms |
| `runNotifyPump` | 5 000 ms |
| `runDueTimers` | 20 000 ms |
| `sweepExpiredTempRoles` | 60 000 ms |
| `flagLateSurgeons` | 60 000 ms |
| `sweepInterfaceHeartbeats` | 60 000 ms |
| `sweepLabSla` | 60 000 ms |
| `sweepExpiredPharmacyPicks` | 60 000 ms |

**And `dailyTick` fires on the same boundary too** (`WORKER_DAILY_TICK_MS` default 30 000), and it
launches every due daily job **fire-and-forget — `this.runTick(job).catch(...)`, not awaited** — so
up to eight more can enter concurrently.

### The failure mode

At a minute boundary, eight lock clients are held out of ten. Two connections remain for eight jobs'
heartbeat writes and actual work. That alone is severe contention.

**If ten jobs are ever in flight together — eight interval plus two daily coming due in the same
tick — all ten connections are lock clients, every job then needs an eleventh connection to write
its heartbeat, and `pool.connect()` has no `connectionTimeoutMillis`, so it waits FOR EVER.** None
can finish, so none releases its lock client. The worker process deadlocks against itself, on a
timer, with no error and no log line.

**Postgres cannot see this.** Its `deadlock_timeout` detector (1 s) breaks cycles of *lock* waits
between transactions. Pool exhaustion is an application-side queue — the detector never fires,
because as far as the server is concerned nobody is waiting on a lock.

---

## Q2 — where else the nested shape appears

**First, the distinction that a naive grep gets wrong.** `tx as unknown as Db` — roughly forty sites
across radiology and billing — is **not** this bug. Drizzle's `.transaction()` on an existing `Tx`
opens a SAVEPOINT on the *same* connection. `bill.ts`'s header documents this deliberately. Those
sites cost zero extra connections and must not be "fixed".

The dangerous shape is different: a call inside a transaction body that passes the **outer `db`
handle**, which takes a *second* connection while the first is held open. A scan of every `withTx`
callback in the non-test tree found **three**:

| site | call |
|---|---|
| `modules/billing/invoices.ts:910` | `assertGrantedApproval(db, …)` **and** `hasPermission(db, …)` |
| `modules/billing/credit-notes.ts:306` | `assertGrantedApproval(db, …)` |
| `modules/ot/recovery.ts:341` | `getPatient(db, …)` |

**Two of the three are in `billing`, which CLAUDE.md names as imported by nearly every module** —
the highest-traffic path in the system. Each in-flight invoice issuance therefore holds **two**
connections, so **five concurrent issuances saturate the API's pool of ten.** And if one of those
second-connection reads touches a row the outer transaction has locked, it waits with no bound.

### The indirect kind — found after the LIMS lane supplied the shape

The first scan found only *direct* nesting and said so; the lab near-miss path it could not see was
the reason. The LIMS lane supplied the missing shape and a **second scan, written to that shape,
reproduces its three sites independently**:

> The outer `db` handle is passed **into** the transaction callback, and the nesting happens one
> frame down in a **different function body**. No grep for "a `withTx` inside a `withTx` callback"
> can pair them, because they are not lexically nested at all.

```ts
// results.ts — nothing nested here. This line is clean to any textual scan.
return await withTx(db, (tx) => amendResultInTx(db, tx, actor, input, now));
                                            // ^^ the outer handle travels inside

// …and one frame down, with `tx` demonstrably still open:
await withTx(db, (flagTx) => appendEvent(flagTx, labTubeSwapSuspected.make({ … })));
```

**The pairing key is a function carrying BOTH a `Db` and a `Tx` parameter.** Scanning for that
signature and then looking for `withTx(<the Db param>, …)` in the body yields:

| site | outer opened in | inner write |
|---|---|---|
| `modules/lab/results.ts:~335` | `enterResultInTx` (`:271`) | `lab.tube_swap_suspected` near-miss |
| `modules/lab/results.ts:~1200` | `amendResultInTx` (`:1098`) | the same, on the amend path |
| `modules/lab/verify.ts:~181` | `verifyResultInTx` (`:130`) | `lab.sod_violation_blocked` audit |

**The signature is a candidate filter, not a finding.** Four candidates, and this document first
recorded three as real with `modules/lab/specimens.ts:134` `printLabelsInTx` as a clean negative
control — *"carries exactly the same signature and does not nest."*

### That negative control was WRONG, and the way it was wrong is the lesson

`printLabelsInTx` **does** nest. Two frames down:

```ts
// specimens.ts, inside printLabelsInTx, holding the open `tx`:
await assertRightPatient(db, actor, { … });        // the handle escapes by ARGUMENT

// collection.ts:53, assertRightPatient(db: Db, …):
await withTx(db, (flagTx) => appendEvent(flagTx, labTubeMismatchFlagged.make({ … })));
```

The pairing key we had agreed on asks *"does THIS function, holding both handles, call `withTx` on
its `Db`?"* — and `printLabelsInTx` does not. It hands its `db` to a callee that does. **A third
shape: the handle escapes by argument, one frame further than either scan looked.** Found by the
LIMS lane following callers, which is a call-graph question and not a regex one.

**The uncomfortable part is not the miss — it is that the false negative was published as evidence
of rigour.** A filter that reports only hits is indistinguishable from one that reports everything,
so a negative control was volunteered to show the filter discriminated. It did not discriminate; it
agreed with the scan because it shared the scan's blind spot, and it made the census read as MORE
trustworthy than it was. **A negative control drawn with the same instrument as the positives is not
a control.**

### THE TRAP FOR WHOEVER FIXES IT — the obvious repair deletes the evidence

**The separate transaction is deliberate and load-bearing.** 17d D3 appends the near-miss on its own
transaction *"so the rollback cannot take the audit record with it"*: the entire point is that a
REFUSED entry still leaves the near-miss behind for NABL. Collapsing the inner write onto the outer
`tx` removes the second connection and **silently destroys the audit row it exists to preserve** —
and every test would stay green, because the refusal still refuses.

The repair that keeps both properties is to move the audit write **outside** the outer transaction:
let `withTx` roll back, write the near-miss on a fresh connection at the `Db`-first layer, then
rethrow. Two connections are never held at once and the audit still survives.

**The LIMS lane owns this and has taken all four (PR #87).** Its implementation is worth recording
because two of its choices are not the obvious ones:

- The event **rides the thrown error on a non-enumerable symbol**, and the `Db`-first wrapper
  appends it once the outer transaction has fully unwound — *deferred*, not merely moved. A symbol
  rather than `LabError.detail`, because `detail` is serialised into the HTTP response and an audit
  payload naming sibling specimens is not the client's business.
- For `assertRightPatient` it **removed the `db` parameter** rather than leaving it unused: with no
  handle in scope the function *cannot* re-acquire the shape. Structural, not a promise.
- On the path that PROCEEDS (an override accepted) there is nothing to outlive the rollback, so that
  one appends on `tx` and takes no second connection at all.
- It verified the precondition that makes deferral safe rather than assuming it: each `*InTx` has
  exactly **one** caller, its own wrapper, so there is no door the flush can be missed through.

**And the trap earned itself twice: the collapse-onto-`tx` version passes 29 suites / 245 tests.**
It was not shipped, but it would have been green — 17d T1 D3's *"the swap is EVENTED even though the
entry rolls back"* is the single assertion standing between that repair and a silently deleted audit
trail.

### The census — SEVEN, and the floor warning is STRENGTHENED rather than discharged

**Seven sites, three shapes:** three direct (`billing` ×2, `ot` ×1) and four indirect (`lab` ×4).

The earlier draft discharged the "this is a floor" caveat once a second scan reproduced three sites
independently. **That was the wrong conclusion from the right evidence.** Two independent scans,
written by two lanes, agreed on three — and the fourth was invisible to both, because they shared a
blind spot rather than because it was subtle. **Agreement between two instruments of the same kind
is not corroboration.**

So the caveat stands and is now explicit about what remains unscanned:

- a handle reached from **module scope** rather than passed at all;
- a handle escaping **more than two frames**, or through a callback, an object field or a closure —
  the third shape above was found at two frames by following callers, and nothing here proves two is
  the limit.

**Treat seven as the count that two regex scans and one call-graph walk could find, not as the
number of sites that exist.**

---

## Q3 — what a `statement_timeout` would have to allow

The favourable finding: **the long sweeps are already batched.** `retentionSweep` deletes in bounded
batches (`sweep.ts`, and its test pins "five doomed rows at a batch size of two is three
statements"), so no single statement grows with table size.

**The 205 s figure from `results.test.ts` should NOT size a production timeout** — that is a jest
seed on a contended CI runner, not a production statement.

No production p99 statement time exists to quote, and this investigation cannot produce one without
touching production. That is the measurement to take before choosing a number.

**But note the ordering of value.** A `statement_timeout` bounds a slow *query*; it does not bound a
wait for a *connection*, which is the failure above. In rough order of cost-to-benefit:

1. **`connectionTimeoutMillis` on the pool** — the cheapest, and the only one that addresses the
   deadlock directly. It converts "wait for ever, silently" into a loud error. It changes no
   database behaviour at all.
2. **`max`, set explicitly** — 10 is pg's default, not a decision anyone made. Whatever the right
   number is, it should be written down rather than inherited.
3. **`idle_in_transaction_session_timeout`** — bounds a transaction left open by a crashed caller.
4. **`statement_timeout` / `lock_timeout`** — the ones that need production numbers first, and the
   ones most likely to break legitimate long work if guessed. Migrations in particular should be
   exempt.

---

## What this pack does not claim

- It no longer says the nesting census is a floor **for the two shapes it scanned for** — the
  indirect kind was found once the LIMS lane supplied its shape, and a second scan reproduced its
  three sites independently. A third shape (a handle reached from module scope rather than passed)
  would still be invisible; neither scan found evidence of one.
- It does not claim the worker deadlock has HAPPENED. It shows the shape is reachable on a timer and
  has no bound if it occurs. Nobody has observed it, and the module is not deployed.
- It does not recommend numbers. Items 1 and 2 above are arguably safe defaults; 3 and 4 want
  production measurements.
- It changed nothing.
