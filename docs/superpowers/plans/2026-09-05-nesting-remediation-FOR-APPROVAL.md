# Transaction nesting and the connection pool — remediation phase (FOR APPROVAL)

> **STATUS: FOR APPROVAL. NOT APPROVED, NOT STARTED, NO PLAN NUMBER.** The number comes from
> `00-INDEX` when and if the owner adopts this. Nothing here is built. This document exists so the
> decision is made from measurements and so **the two traps below survive the session that found
> them** — right now they exist only in the evidence pack and in messages between lanes.
>
> **Steps 1 and 2 are the owner's rulings, not tasks.** Step 3 does not start until they land.

Written 2026-09-05 against `main` at `15e3087`. Evidence:
`docs/superpowers/investigations/2026-09-05-pool-and-timeout-exposure.md`.

---

## 1. What was found

**Seven sites hold two database connections where one would do**, across three shapes — three
*direct* (the outer `db` passed positionally inside its own transaction body) and four *indirect*
(the handle escapes by argument, one or two frames down).

| | site | callee taking the second connection |
|---|---|---|
| direct | `modules/billing/invoices.ts:910` | `assertGrantedApproval(db, …)`, `hasPermission(db, …)` |
| direct | `modules/billing/credit-notes.ts:306` | `assertGrantedApproval(db, …)` |
| direct | `modules/ot/recovery.ts:341` | `getPatient(db, …)` |
| indirect | `modules/lab/results.ts` ×2, `verify.ts` ×1 | audit writes on their own transaction |
| indirect | `modules/lab/specimens.ts` → `collection.ts:53` | `assertRightPatient` → tube-mismatch flag |

**Two are in `billing`**, which CLAUDE.md names as imported by nearly every module — so at pg's
default pool of 10, **five concurrent invoice issuances saturate the API pool.**

**Not this defect:** `tx as unknown as Db`, roughly forty sites across radiology and billing. That is
a SAVEPOINT on the same connection, documented deliberately in `bill.ts`. It costs zero extra
connections. A scan that conflates the two yields ~13 false positives per real finding.

---

## 2. THE ORDER IS CHEAP-FIRST, NOT ALARMING-FIRST — and that is the main proposal

### Step 1 — `connectionTimeoutMillis` (owner's ruling; trivial, reversible)

**Nothing else in this area can be DIAGNOSED until this exists.** `pg-pool@3.14.0/index.js:206`:
with the option unset, a starved `connect()` is pushed onto `_pendingQueue` and **never rejects**.
The failure mode of everything below is therefore an **invisible, unbounded hang** — no error, no log
line, and **Postgres cannot see it** (its `deadlock_timeout` breaks cycles of *lock* waits; pool
exhaustion is an application-side queue, so the detector never fires).

It changes no database behaviour at all. It converts a silent hang into a loud error.

### Step 2 — an explicit `max` (owner's ruling; decides whether step 3 matters)

10 is pg's default, not a decision anyone made. **The urgency of step 3 is a function of this
number**: at `max: 10` five concurrent invoice issuances saturate the pool; at `max: 50` the same
code is unremarkable. That is what makes the code work genuinely *downstream* of the ruling rather
than merely adjacent to it.

### Step 3 — the nesting sites (a reviewed phase, in a quiet window)

Gated on 1 and 2, and on the notice in §4.

---

## 3. THE TWO TRAPS — the reason this document exists

### 3a. `hasPermission` through `tx` would pass its own check

The obvious repair is to pass `tx` instead of `db`. **It is not a refactor.** A read through `tx`
sees the transaction's **own uncommitted writes**; a read through `db` sees committed state. So a
transaction that has just written a role grant **would begin passing its own permission check.**

That may be right or wrong *per site*, but it is a **security-relevant semantic decision**, it must
be taken one site at a time with the answer written down, and **every test would stay green either
way.**

### 3b. The lab fix must not collapse onto the outer `tx`

The four indirect sites append an audit record on a **deliberately separate** transaction. 17d D3:
*"so the rollback cannot take the audit record with it"* — the entire point is that a **refused**
entry still leaves the near-miss behind for NABL.

**Collapsing the inner write onto the outer `tx` removes the second connection and silently destroys
the audit row it exists to preserve.** The LIMS lane measured this: **the collapsed version passes 29
suites / 245 tests.** It would ship green, and NABL reconciliation would break with no warning.

The repair that keeps both properties: let the outer transaction roll back, write the record on a
fresh connection at the `Db`-first layer, then rethrow. One connection at a time, audit survives.

---

## 4. Blast radius — count the CALLEES, not the call sites

The three direct sites cannot be fixed by editing three lines, because the callees take `db: Db`,
not `Db | Tx`:

| callee | file | non-test callers |
|---|---|---|
| `hasPermission` | `kernel/auth/permissions.ts` | **71** *(a second count made it 56; the difference is what each scan treated as a call site — both are recorded rather than the flattering one)* |
| `getPatient` | `modules/patients/registration.ts` | **15** *(second count: 13)* |

CLAUDE.md: *"Modules `patients`, `tariff`, `billing` are imported by nearly every other module: **a
signature change there breaks every lane.**"*

**So step 3 requires: all active lanes notified before it starts, a quiet window with nothing
mid-flight, and review.** It is explicitly NOT a fix to slip in beside other work.

---

## 5. Who does what — and neither audits its own scan

- **Pharmacy lane: the three direct sites.**
- **LIMS lane: the four indirect sites.** It found the shape that broke the pharmacy lane's scan,
  and it has designed the fix (the event rides the thrown error on a **non-enumerable symbol** —
  not `LabError.detail`, which is serialised to the client and must not carry sibling specimen ids —
  and flushes after the unwind; `assertRightPatient` had its `db` parameter **removed** rather than
  left unused, so the shape cannot recur). **Not landed on `main` as of `15e3087`.**
- **Neither lane reviews its own half.** This is not ceremony: the pharmacy lane published a false
  negative control that made its census read as complete, and LIMS broke it with a method the scan
  did not have. Two instruments of the same kind agreeing is not corroboration.

---

## 6. What "done" looks like

1. `connectionTimeoutMillis` and an explicit `max` set, with the numbers' reasoning recorded.
2. Each of the seven sites either holds one connection at a time, or carries a written note saying
   why two is correct there.
3. For every site touched by 3a, the read-semantics decision recorded **at the site**.
4. A test proving the lab audit record **survives the rollback it documents** — the one assertion
   standing between the correct fix and the green-but-wrong one.
5. The `tx as unknown as Db` savepoints untouched, and a note in the phase doc saying so, so the
   next scan does not "fix" forty working call sites.

---

## 7. What this document does NOT do

It does not set any number, does not start any work, and does not claim the seven sites are all that
exist — **seven is what two regex scans and one call-graph walk could find.** A module-scope handle,
or an escape of more than two frames, would still be invisible to all three.
