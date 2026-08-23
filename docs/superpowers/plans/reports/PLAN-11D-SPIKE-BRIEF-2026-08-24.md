# Plan 11d spike brief — one lock, one read-only look at production, and two config smokes

**Written 2026-08-24 by the plan-writing session.** Run by ONE agent, from the execute session,
BEFORE Phase 0 and before any brief is compiled. The plan this serves:
[`../2026-08-24-phase1-11d-operability-hardening.md`](../2026-08-24-phase1-11d-operability-hardening.md).

**Its central premise was fork-open and is now CLOSED by measurement** — Question B was discharged
in the planning session, before this brief reached you (see below). **T3's named fix is still
unproven until Question A answers it, and that is what blocks compile.** Everything this spike
builds is THROWAWAY; the deliverable is a report, committed as `plan-11d-spike-report.md` beside
this brief, and the resolutions written into the plan document **in place** (§2.48: mark a losing
shape dead where it stands, never merely record a verdict in a summary block).

**Budget: ~70k target, honest range to 150k** — reduced because Question B is already answered.
11c's spike targeted 80k and cost 172k, closing a fork, measuring a blocked port nobody expected,
and finding two Alertmanager facts that would each have cost a rung. This one is **one concurrency
measurement and two smokes**. **Wall clock: expect 20–35 minutes**, dominated by Question A's
concurrent runs.

## Ground rules (AGENT-RULES.md binds in full; these are the spike-specific edges)

- All evidence on the build host (`root@62.238.106.231:/opt/hmis`). Author in your own mirror
  (rule 22, per-agent suffix). **Nothing is committed to `main` by this spike.** Leave the server
  tree CLEAN (`git status --porcelain` empty) before reporting.
- **Question B is the ONE exception to "stay off production", and its boundary is exact.** The owner
  authorized **READ-ONLY SELECT queries against the `hmis-prod` database** on 2026-08-24, in
  conversation. That means: **no INSERT, no UPDATE, no DELETE, no DDL, no `compose` command that
  starts, stops, restarts or recreates anything, no write anywhere under `/opt/hmis-prod` (rule 3),
  and no schema change.** Reach the database with `docker compose -f … exec -T db psql` or
  `docker exec`, run SELECTs, read the output. **If any command you are about to run is not a
  SELECT, do not run it — report that you stopped.**
- Everywhere else rule 7 stands unchanged: containers you create belong to a `hmis-spike` project
  and are REMOVED before you report. Never `prune`.
- Rule 20 before every timing or race measurement: `pgrep -af jest`, **read the matched LINES rather
  than counting them** (the shell's own command line contains the word), and say in the report
  whether anything else was running.
- Exit codes read from files, detached, per rules 16–18. Isolation proven from OUTPUT (rule 19).
- **Every answer is MEASURED or it is marked PREDICTION.** A hand-walk of what Postgres "would do"
  is not an answer to Question A; it is the thing this spike exists to replace.

---

## Question A — does `pg_advisory_xact_lock` actually serialise `changeOperatingMode`? *(resolves plan D5 / Book V10, V11; blocks T3)*

**Why this is asked.** `pg_advisory_xact_lock` appears **nowhere in this repository.**
`kernel/worker/scheduler.ts:43` (at `78b0a3d`) uses `pg_try_advisory_lock` — the *session*-scoped, *non-blocking*
variant — and its own header says a session lock pins one pooled client for the lock's lifetime and
must be explicitly unlocked. D5 asserts the transaction-scoped blocking variant behaves differently
in three ways this plan depends on, and **all three are currently predictions**.

**Build the smallest thing that answers it, on the DEV database, in a throwaway script.**

1. **Does `withTx` hold ONE client for the transaction's life?** `kernel/db/client.ts:14` is a bare
   `db.transaction(fn)` over a `pg` Pool. If drizzle were to check out a client per statement, an
   advisory lock taken inside the transaction would sit on a connection the next statement does not
   use, and the whole fix is void. **Measure it**: inside one `withTx`, run
   `select pg_backend_pid()` twice with other statements between, and assert the pid is the same
   value both times. Quote the pids.
2. **Does the loser BLOCK, and for how long?** Two concurrent `withTx` blocks, each taking
   `select pg_advisory_xact_lock(hashtext('hmis.spike'))` then sleeping ~200 ms then committing.
   **Measure**: the second's wall time from statement start to acquisition. Expect it to be
   ≈ the first's hold time. Quote the numbers. **A near-zero wait means it did not block and D5 is
   wrong.**
3. **After acquiring, does the loser's re-read see the winner's COMMITTED row?** This is the whole
   point and it is where READ COMMITTED matters: each statement takes a fresh snapshot, so a SELECT
   issued *after* the lock is acquired must see what the winner committed before releasing it.
   **Measure**: winner inserts a sentinel row and commits; loser acquires, then SELECTs, and the
   sentinel is present. **If it is absent, the lock serialises the writes and not the decisions, and
   T3's fix does not close case B.**
4. **Does the lock survive a THROWN error correctly?** `changeOperatingMode` throws on four paths
   between the lock and the append. **Measure**: take the lock, throw, and confirm a second
   transaction acquires immediately afterwards (the ROLLBACK released it). A hang here means the fix
   would deadlock the mode desk on every refusal, which is worse than the defect.
5. **Cheap and worth it: does it work over the SAME `Tx` type the function receives?**
   `changeOperatingMode(tx: Tx, …)` is Tx-typed. Confirm the drizzle `sql` template executes on a
   `Tx` and not only on a `Db`, so T3 does not discover a type problem on its first rung.

**Report:** each of the five as MEASURED with its numbers, plus the exact statement text that
worked. **If (1), (2), (3) or (4) fails, say so plainly and STOP — the plan needs a different fix
and it is not the spike's job to invent one.** Name what you observed; the plan-amending session
decides.

## ~~Question B~~ — DISCHARGED 2026-08-24, BEFORE THIS SPIKE. **DO NOT RUN IT AGAIN.**

> **Answered in the planning session** on a second explicit owner authorization: one minute of
> read-only SELECTs, `psql` exit VALUE **0**. The full transcript is **§B-MEASURED** in the plan
> document. **The premise HELD** — `admin` holds nine permissions (six `auth.*`, three `ops.*`), the
> catalog holds **59**, and **fifty declared permissions are held by no role at all**.
>
> Three unpredicted facts came with it, all now written into the plan: **`admin` has no PIN**, so
> the fast-switch Plan 02 perf-tested is unusable by anyone · **only three roles exist**, so
> `seed:opd` has never run against production · and every per-manifest permission count in the
> plan's Consumed Surfaces section is **independently corroborated** by the live catalog.
>
> **Do not re-run these queries.** Production has been read once for this purpose and there is
> nothing further to learn by reading it again. The section below is kept as the record and as the
> shape a future rotation would reuse: **it is history, not a task** (§2.48 — mark the dead branch
> dead where it stands rather than deleting it, so the next reader sees what happened).

### The question as it was written, kept as history

**READ-ONLY. SELECT ONLY. Re-read the ground rules above before you connect.**

**Why this is asked.** The plan's central premise, measured from source but **predicted** about the
live box: `grantPermissionToRole` has two non-test callers, `seed-admin.ts` (six `auth.*` strings,
and it returns early once an admin exists) and `seed-ops.ts` (three `ops.*` strings). Therefore
production's `admin` should hold nine permissions and no more, and every billing, patients, OPD,
tariff, workflow and approvals route should 403 for the only user who exists.

**Run exactly these, and quote the output verbatim:**

```sql
-- 1. Who exists, and can any of them fast-switch?
select username, active, (pin_hash is not null) as has_pin from users order by username;

-- 2. The join the PermissionGuard actually reads. This is the answer.
select u.username, ra.role_key, ra.scope_type, rp.permission
  from users u
  join role_assignments ra on ra.user_id = u.id
  left join role_permissions rp on rp.role_key = ra.role_key
 order by 1, 2, 4;

-- 3. Is the CATALOG complete? (syncPermissions runs at api boot over nine manifests.)
select module, count(*) from permissions group by module order by module;

-- 4. Which roles exist at all, and which hold nothing?
select r.key, count(rp.permission) as granted
  from roles r left join role_permissions rp on rp.role_key = r.key
 group by r.key order by 2 desc, 1;
```

**What each answer changes, stated in advance so the measurement cannot be read to taste:**

- **Query 2 returns only `auth.*` and `ops.*` for `admin`** → the premise HOLDS. T1 ships as written
  and flag ③ becomes the most important step in the whole plan.
- **Query 2 returns billing/opd/patients permissions too** → **the premise is WRONG.** Something
  grants them that this session did not find. **STOP, report what grants them, and the plan is
  amended before compile** — T1 shrinks to the reachability invariant and D1's narrative is rewritten.
- **Query 3 shows fewer than nine modules** → the catalog is incomplete, which means `syncPermissions`
  has not run for some manifest, which is a **different defect** and a finding of its own.
- **Query 1 shows more than one user** → the staff gap is smaller than stated; report the count.
- **Query 4 shows `duty_manager` and `owner` present with the ops grants** → consistent with the 11c
  addendum, and a useful control that the query is reading the right database.

**Do not fix anything you find.** Not one INSERT. The repair is `seed:roles` run as an authorized
deploy step (flag ③), because a hand-written grant leaves production in a state no script reproduces.

## Question C — does Alertmanager export its notification counters BEFORE the first failure? *(shapes plan D7 / Book V18a)*

**Why this is asked, and it is §2.49's class.** D7's `HmisAlertNotificationsFailing` rule reads
`alertmanager_notifications_failed_total`. **If that series does not exist until a notification has
been attempted, a rule written as `increase(...) > 0` is unarmed on a fresh deployment** — the same
missing-series blind spot `alerts.yml`'s `absent()` leg exists to close for the scheduler, and the
same one that made D11's watcher inert. A rule that can never fire looks exactly like a healthy
system.

**Measure it on a THROWAWAY alertmanager** (`hmis-spike` project, removed before you report — do NOT
scrape the production one for this; you may read production's `/metrics` on loopback if that is
cheaper, but only by reading, and say which you did):

1. Start `prom/alertmanager:v0.27.0` with a minimal config. `curl` its `/metrics` **before any alert
   is fired**. Record: does `alertmanager_notifications_total` exist? Does
   `alertmanager_notifications_failed_total` exist? **With which label sets** — is `integration` and
   `reason` present with zero values, or is the metric family absent entirely?
2. Fire a synthetic alert whose receiver is guaranteed to FAIL (an SMTP smarthost pointing at a
   closed port on localhost is the cheapest). `curl` `/metrics` again. Record which counters moved
   and what `reason` label the failure carries.
3. Record `up`'s behaviour for a scrape target that has never been scraped, if it costs nothing.

**What it changes:** if the counters are **present at zero**, D7's rules ship as written. If they
are **absent until first use**, T5's rule must be written to survive that — an `or on() vector(0)`
term, or an `absent()` leg beside it — and **the plan is amended before compile**, in D7, in place.
Either way the report states which, with the raw `/metrics` lines quoted.

## Question D — can `promtool test rules` unit-test these rules at all? *(cheap smoke; de-risks T5's first rung)*

D7's rules use `up{}` and `increase()` over a counter. 11c proved `promtool test rules` works for
plain gauge comparisons. **Confirm, with a two-minute throwaway test file, that it also handles:**

1. a rule over `up{job="…"}` with the series driven from the test file's `input_series`;
2. a rule over `increase(<counter>[15m])`, including whether the test's `interval` and series
   length have to be long enough for the window to be meaningful — **this is the one likely trap**,
   because a 15 m range over a 1 m test series evaluates to nothing and the rule reads as
   not-firing when it is really not-evaluable;
3. the exit VALUE, read from a file, in both the firing and the not-firing direction.

**What it changes:** if `increase(...[15m])` cannot be unit-tested cleanly, T5's rules use a window
`promtool` can drive and D7's table is amended — a rule whose correctness cannot be asserted is a
rule this project does not ship (11c's flag ⑥ is the precedent).

## Report format

Commit as `plan-11d-spike-report.md` beside this brief. One section per question. Each answer is
**MEASURED** (with the command, the raw output and the numbers) or **PREDICTION** (and then say why
it could not be measured). Then:

- **What the plan must change**, quoted as the exact edit — D5, D1, D7 and the Book rows by number.
  The plan-amending session applies them **in place** (§2.48), not as a verdict block.
- **What you touched and what you removed**: every container created and destroyed, every scratch
  file, and `git status --porcelain` on the build host at the end.
- **An explicit line confirming that every production interaction was a SELECT**, or naming exactly
  what else you ran and why. This is the one sentence a reader will look for first.
- **Anything you found that nobody asked about.** 11c's spike found a blocked outbound port and two
  Alertmanager facts that were not in its brief, and each was worth a rung. §2.49's rule applies:
  when an answer is "nothing uses this", immediately ask what the plan asserts about it.
