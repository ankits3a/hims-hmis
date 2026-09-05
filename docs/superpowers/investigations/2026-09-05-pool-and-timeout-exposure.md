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

**The signature is a candidate filter, not a finding** — and the negative control matters as much as
the hits: `modules/lab/specimens.ts:134` `printLabelsInTx` carries exactly the same `(db, tx)`
signature and does **not** nest. Four candidates, three real.

### THE TRAP FOR WHOEVER FIXES IT — the obvious repair deletes the evidence

**The separate transaction is deliberate and load-bearing.** 17d D3 appends the near-miss on its own
transaction *"so the rollback cannot take the audit record with it"*: the entire point is that a
REFUSED entry still leaves the near-miss behind for NABL. Collapsing the inner write onto the outer
`tx` removes the second connection and **silently destroys the audit row it exists to preserve** —
and every test would stay green, because the refusal still refuses.

The repair that keeps both properties is to move the audit write **outside** the outer transaction:
let `withTx` roll back and return or throw, write the near-miss on a fresh connection at the
`Db`-first layer, then rethrow. Two connections are never held at once and the audit still survives.
**The LIMS lane owns this and is taking it**; it is described here so the document states the class
rather than one lane's queue.

### The census, and what it is now worth

**Six sites, two shapes:** three direct (`billing` ×2, `ot` ×1) and three indirect (`lab` ×3). The
earlier "three is a floor" warning is discharged for these two shapes. A third shape — a handle
reached from module scope rather than passed as a parameter — would still be invisible to both
scans, but neither scan found any evidence of one.

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
