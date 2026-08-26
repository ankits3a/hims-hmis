# Plan 09a — The four MAJORs that gate Plan 09's flags

**Written 2026-08-26 on the build host, under [`EXECUTE-METHOD-V3.md`](../EXECUTE-METHOD-V3.md).**
Follows Plan 09's close ([`2026-08-25-phase1-09-memberships-coupons-accrual-ledger.md`](2026-08-25-phase1-09-memberships-coupons-accrual-ledger.md),
its §8 CLOSE is the gate report). Relay: [`reports/2026-08-26-plan-09-relay.md`](reports/2026-08-26-plan-09-relay.md).

**This document is deliberately short.** Plan 09's was ~37k tokens and every agent carried it on
every tool call — the single largest line in that phase's bill after the ledger (v3 §9, ledger
§2.97). A four-fix phase does not need a 1,800-line document, and writing one anyway would be the
first violation of the amendment this phase exists to test.

---

## THE LANE — ruled at write time (v3 §2)

**LIGHT.** Four fixes, every one named by Plan 09's independent reviewer, one migration. The main
session codes task by task under [`AGENT-RULES.md`](../AGENT-RULES.md), builds the mutants, watches
CI with [`ci-watch-host.sh`](../pipelines/ci-watch-host.sh), and closes with one independent
reviewer. No pipeline, no briefs, no gates.

**Stop-loss (v3 §6, as amended 2026-08-26): 340k subagent tokens.** = 1.5 × the last comparable
**per-task rate** × this phase's task count = 1.5 × 56k (Plan 11h LIGHT) × 4. Stated as an
arithmetic, not a total, because that is exactly what §6's amendment is for — Plan 09 took 1.5× a
five-task phase's TOTAL, applied it to eight tasks, and the tripwire fired on scope (ledger §2.95).

**Context budget (v3 §9.2, and this phase is its first test).** The LIGHT lane carries no briefs, so
the only agent is the closing reviewer. Its pointers, measured:

| | ~tokens |
|---|---|
| `AGENT-RULES.md` (read in full — it is the contract) | 6,137 |
| this document | ~2,000 |
| the two files under change | ~12,800 |
| ledger entries **cited by number**, not by file (§2.93, §2.97, §2.99, §3.14, §3.21) | ~600 |
| **total** | **~21.5k** |

**Against Plan 09's ~152k per agent.** The difference is entirely *what a brief points at*: citing
five ledger entries by number instead of pointing at an 81k file, and naming a task's own section
instead of a whole phase document. If the close audit does not show context-per-call falling
materially, **§9 is wrong and this document says so** — the amendment is refutable and should be.

**Frozen:** everything under `apps/core/src/modules/tariff/`, `kernel/events/dispatcher.ts`,
`kernel/db/schema/billing.ts`. **Not frozen and edited on purpose:** `kernel/db/schema/partners.ts`
(T2's migration), `modules/partners/{accrual,statements}.ts`.

---

## 1. Why this phase

Plan 09 is closed and live in production, **inert**: every catalog empty, all five flags false,
measured. Its reviewer found no CRITICAL and four MAJOR, and every MAJOR sits behind a flag. But two
of them are **wrong money in the accrual ledger**, and they become CRITICAL the instant
`COMMISSION_ACCRUAL_ENABLED` is set. The owner ruled on 2026-08-26 that all four land together in one
short phase **before any flag flip**, with MAJOR 1's semantics settled.

**The real deliverable is two FIXTURES, not four patches.** Plan 09 built forty mutants and all forty
died, and it still shipped MAJOR 1 — because every one of its nine golden fixtures sat at
`collected == settleable`, the one regime its spike had measured. A mutant tests the implementation
against the fixture; **nothing tested the fixture against the input space** (ledger §2.93). This
phase adds the two shapes those forty mutants could never reach.

---

## 2. Design decisions

### DD1 — The ratio is clamped, and the clamp means SERVICE DELIVERED (RULED by the owner 2026-08-26)

`targetBase = min(divHalfUp(eligibleBase × collected, settleable), eligibleBase)`.

`collected > settleable` is ordinary, not exotic: a credit note moves `settleable` immediately while
`collected` does not move until a refund voucher is **paid**. Unclamped, the ratio exceeds 1 and the
base silently becomes the whole invoice — so crediting a line the agreement pays **nothing** on
raised an unrelated line's commission from 10,000 to 15,600, and the pure probe reached 5× the live
eligible base.

**The owner's ruling and its reason, recorded because a later reader will want to reopen it:**
commission is owed on service **delivered and still owed for**, not on cash **held**. It is the
conservative direction for a trust hospital, and it is the only reading explainable to a partner
during reconciliation without reference to the hospital's cash position.

**It changes an existing assertion, and the ruling wins.** `accrual.test.ts`'s F8 leg constructs
250,000 collected against 150,000 settleable and asserts the unclamped `[25_000]` with a comment
defending it — defensible for the all-eligible invoice it uses, false for a mixed one. **The test is
amended to match the ruling, not the ruling to match the test.**

### DD2 — The accrual subject is keyed on `(invoice_id, direction)` (RULED)

Plan 09 keyed it `(agreement_id, invoice_id, direction)`, so a **backdated** agreement version opens
a *second* subject, finds no rows for itself, and appends the whole target again — measured
`[5000, 10000]`, total 15,000 where 10,000 is correct.

The agreement already travels on every row's `rate_snapshot` (Plan 09 DD6), so dropping it from the
key loses nothing and makes **"Σ deltas = target" true per invoice** — which is what Plan 09's DD12
invariant always meant. **Migration `0028_overjoyed_havok` — CORRECTED AT EXECUTION.** This
paragraph said `0026` when it was written; Plan 16a, running in parallel, took `0026` and
`0027` while this phase was still open. The number was re-read at kickoff, which is what the
task table said to do and is why the collision cost nothing.

### DD3 — `attributeInvoice` uses the counter's own IST-calendar-day predicate (RULED)

Plan 09's B6/K7 rule validity as an **IST calendar-day** comparison and `membershipUsableAt` honours
it; `attributeInvoice` compares raw instants in SQL while the importer writes `T00:00:00.000Z` =
05:30 IST. **For ~18.5 hours of the final day of every imported card — all of a working day — the
counter honours the discount and the partner is credited nothing.**

The fix computes the invoice's IST day bounds in TS with the shipped `istDayIndex` and passes them
into SQL, rather than duplicating day arithmetic in SQL. **One clock, already shipped, already
tested** — Plan 09's relay note 20 measured that all three IST copies agree.

### DD4 — The open expectation is locked `FOR UPDATE` (RULED)

`importStatement`'s open-claim lookup has no row lock and its update carries no state predicate, so
two concurrent imports quoting one slip both accrue in full — measured by Plan 09's T7 gate at
**7 of 8 trials**. This is the hazard `commission_accrual_subjects` closes on the payable side,
absent on the receivable one. Narrowest fix: `FOR UPDATE` on the open expectation inside the
existing transaction.

**The contention test asserts the BLOCK, not the outcome** — Plan 09 §3 Q6 measured that a forced
interleave alone ends identically with and without a lock, so a test asserting only "one row" passes
against a lock-less implementation (§3.21's family).

---

## 3. Tasks

Sequential; each is its own commit, its own `pnpm verify` before push, and CI by full SHA.

| | task | tier | commit |
|---|---|---|---|
| T1 | DD1 — clamp the ratio; amend F8 to the ruling; **golden fixture: `collected > settleable` on a MIXED invoice** | CRITICAL | `fix(core): the accrual ratio is clamped — a credit on an ineligible line no longer raises an eligible line's commission (09a T1)` |
| T2 | DD2 — re-key the subject; migration **at the next free number, read at kickoff** — Plan 16a executes in parallel and takes `0026` (AGENT-RULES §6) | CRITICAL | `fix(core): one accrual subject per invoice — a backdated agreement version no longer re-accrues the whole bill (09a T2)` |
| T3 | DD3 — the IST-day predicate; **fixture: a validity boundary inside the 05:30 IST window** | CRITICAL | `fix(core): the ledger and the counter now agree about what day it is (09a T3)` |
| T4 | DD4 — `FOR UPDATE` + a contention test that asserts the block | CRITICAL | `fix(core): the receivable lane gets the serializer the payable lane already had (09a T4)` |

**Assertion Book — inline, per v3 §1.4.**

| # | assertion | mutant | discriminating input |
|---|---|---|---|
| A1 | the ratio is clamped at the live eligible base | remove the `min` | **BUILT AND DIED.** `p10` through a scratch copy of `accrual.ts` with only the clamp removed: `Expected: 100000 / Received: 156000` — the unclamped base becomes the whole invoice, pharmacy included |
| A2 | the clamp does not change the ordinary regime | clamp to `settleable` instead of `eligibleBase` | any invoice with `collected < settleable` — the partial-payment fixtures must be untouched |
| A3 | one subject per invoice regardless of agreement version | restore `agreement_id` to the unique key | an invoice accrued under v1, then a **backdated** v2 |
| A4 | validity is an IST calendar day on BOTH sides | restore the raw-instant comparison | a card expiring `T00:00:00Z`, invoice at `T06:00:00Z` — same IST day, and the counter honours it |
| A5 | two concurrent statement imports cannot double-accrue | remove `FOR UPDATE` | two transactions claiming one slip, natural race, rate reported both ways |

**Every mutant is a separate scratch file beside its source, run isolated, killed at its own
assertion (rule 21). A mutant that dies at typecheck or by timeout is not a kill (§2.26/§2.45).**

---

## 4. CLOSE — appended as the phase runs (v3 §1.5)

### Task ledger
| task | commit | verdict |
|---|---|---|
| phase document | `0f747fe` | ~2,414 tokens against Plan 09's ~37,000 |
| T1 — the clamp | `0f77004` | **A1 DIED**; 18/18 accrual, 14/14 golden |
| T2 — the subject re-key | `54ab73b` | **A3 DIED** — `[5000, 5000]` expected, `[5000, 10000]` received, the reviewer's own number. Migration `0028_overjoyed_havok`. `pnpm verify` exit 0, core **212 / 1848** |
| T3 — the IST day | `a092ecc` | **A4 DIED** (`Received: null` for a card the counter honours) **and the P&L mutant DIED** (`memberSpendPaise 0` against `100 000`). `pnpm verify` exit 0, core **212 / 1854** |
| T4 — the receivable lock | `79afbf6` | **A5 DIED** — block leg `"settled"` where `"pending"` is required, race leg **8 of 8 double-counted**. `pnpm verify` exit 0, core **213 / 1856** |

**Counts across the phase: 212 suites / 1847 tests → 213 / 1856.** No suite was deleted and no
count decreased at any step. Five mutants were required and five died; two of them (the P&L copy and
the second half of A3) are mutants the Assertion Book did not ask for, and both found real defects.

**A note on how two of the kills were CONSTRUCTED, because rule 21 cares about that.** A3 and A4/A5
were killed in two different ways and the difference is worth recording. A3's mutant is a genuine
scratch file — `accrual.mutant.ts` beside its source, with the Plan 09 key restored — because the
subject key lives half in the CODE and half in a DATABASE INDEX, so a faithful mutant had to swap
the index too (dropped, old index recreated, restored in an `afterAll` that runs whatever happens).
A4, A5 and the P&L mutant were killed by the FAIL-FIRST run: the shipped file BEFORE its one-line
fix, running the final assertion unchanged. That is not "reverting a shipped file" — nothing was
edited backwards; the test was simply written before the fix, which is the ordering §2.4 asks for.
Where the fail-first was ambiguous (A3, where the index made it so) a scratch mutant was built as
well.

### Findings

- **F1 — the hand computation was exact, which is the point of doing it first.** DD1's clamp changes
  what F8 *should* assert, so the amended values were computed by hand from the ruling
  (eligibleBase 250 000 − 100 000 = 150 000 · settleable 150 000 · collected still 250 000 → scaled
  250 000, clamped to 150 000 → target 15 000, Σ was 25 000 → delta −10 000) and the suite then
  **confirmed** them, 18/18. Writing the assertion to whatever the code happened to emit would have
  been fitting the test to the code; the ruling decides, the test records.
- **F3 — A CONSEQUENCE OF THE RULING NOBODY ANTICIPATED, AND IT IS FOR THE OWNER TO CONFIRM.**
  **Under DD1's clamp, `payment.refunded` can never reduce the accrual.** The reason is a BILLING
  guard, not an accrual one: `issueRefundVoucher` caps a refund at
  `min(received, refundableSurplus)` — the surplus of cash held over what is still owed
  (`refunds.ts:466`). So after **any legal refund** `collected ≥ settleable`, the ratio is ≥ 1, and
  the clamp has already pinned the target at `eligibleBase`. Every scenario was tried: fully paid,
  partly paid, mixed-category, larger invoice. **There is no legal refund that drives `collected`
  below `settleable`.**
  **It is coherent, and it follows directly from what was ruled:** a credit note is the SERVICE
  event and a refund is the CASH event, and the ruling says commission follows service. The
  commission moves when the consultation is withdrawn, not when the money leaves the drawer.
  **But it is a behavioural change worth stating plainly: under this ruling a REFUND never reduces
  a partner's commission.** If that is not what the owner meant, DD1 needs revisiting — this
  session did not treat the consequence as ratification.
- **F4 — a second shipped test encoded the cash-held reading, and rewriting it honestly cost more
  than the code did.** `consumer.test.ts`'s refund leg asserted a `−5 000` row on
  `payment.refunded`. Under the clamp that row cannot exist (F3), so the test's own premise — *"the
  accrual comes back down"* — describes behaviour that is gone. **The tempting fix was to change the
  numbers and keep the name.** That would have left a test whose assertion ("no new row") a broken
  resolver satisfies equally well — §3.14 exactly. It is renamed to what it now proves, and
  **§2.67's rule is honoured in the file: the class of mutant it CANNOT kill is named, and no claim
  is made that it would.**
- **F5 — a neighbouring test looked like MAJOR 1 and is correct.** *"a note on an INELIGIBLE line
  moves the accrual UP"* passes unchanged, because there `collected` 78 000 < `settleable` 100 000 —
  the ratio is 0.78 and never reaches the clamp. Crediting the pharmacy legitimately raises the
  consultation's commission, since the same cash now covers a larger share of eligible service.
  **The clamp bites only when the hospital holds MORE than is owed.** Recorded so the next reader
  does not "fix" a correct test on the strength of its alarming name.
- **F2 — the F8 leg's old comment was not wrong, it was under-scoped**, and that is worth keeping.
  It read *"the hospital still holds 250 000 of the patient's cash so the target does not move"* —
  a coherent reading (CASH HELD), correct for the all-eligible invoice it used, and false the moment
  a line outside `eligibleCategories` is credited. **A comment defending an answer is not evidence
  the answer generalises**, and this one had survived a gate and forty mutants.

- **F6 — A MIGRATION THAT ADDS A UNIQUENESS CONSTRAINT IS A MIGRATION THAT CAN FAIL ON REAL DATA,
  AND THE FIRST DATABASE `0028` BROKE WAS THIS REPO'S OWN.** T2's fail-first run did exactly what
  the defect describes — it opened a second subject for one invoice — and left those two rows in
  worker database `hmis_test_1`. The next run could not apply the migration: **nineteen suites
  failed, every one of them with `error: could not create unique index
  "commission_accrual_subjects_ux"`**, plus a `TypeError: teardown is not a function` where
  `setupTestDb` threw before returning. Nothing was wrong with the code; the migration simply cannot
  land on a database that already holds what it now forbids.
  **Production was measured before the migration was written, read-only, on `hmis-prod-db-1`:
  `commission_accrual_subjects` holds ZERO rows and zero duplicate `(invoice_id, direction)`
  groups**, so the deploy cannot fail. But the honest statement is narrower than "it is safe": it is
  safe *because the lane has never been armed*. Had `COMMISSION_ACCRUAL_ENABLED` ever been true
  alongside a backdated amendment, this migration would have failed in production and the fix for
  the defect would have been blocked by the defect. **No destructive dedupe was added to the
  migration** — a migration that silently deletes accrual subjects to make itself apply is worse
  than one that refuses, and the refusal is legible.
- **F7 — THE LOCK MODE THAT DISCRIMINATES T4 IS `FOR KEY SHARE`, AND THE SUITE THAT SET THE
  PRECEDENT HOLDS THE ONE THAT DOES NOT.** §2.6 requires naming the lock *and its mode* and
  confirming no other lock the implementation takes produces the same wait. Predicting it was not
  enough, so it was measured on a scratch database (`hmis_09a_lockprobe`, created and dropped in
  this task) against a table carrying the same partial unique index:

  | held mode | shipped (`SELECT … FOR UPDATE`) | lock-less (bare `UPDATE`) | discriminates |
  |---|---|---|---|
  | `FOR KEY SHARE` | **BLOCKED** (3125 ms) | proceeded (211 ms) | **yes** |
  | `FOR NO KEY UPDATE` | BLOCKED (3117 ms) | BLOCKED (3116 ms) | **no** |

  `entitlements.contention.test.ts` holds `FOR NO KEY UPDATE` — correct there, and it would have
  been silently WRONG here, because the lock-less implementation's own `UPDATE` conflicts with it
  and would have "blocked" convincingly while proving nothing. **The same rule, the opposite answer,
  because the statement the mutant reaches next is different — which is exactly why §2.6 says
  measure rather than reuse.**
  The probe also settled a question the docs state only obliquely: the `UPDATE` sets `statement_ref`,
  a column of the PARTIAL unique index `receivable_expectations_statement_line_ux`, and still took
  only a no-key lock. **A partial unique index is excluded from Postgres's key-attribute set.**
- **F8 — MAJOR 3 HAD TWO COPIES, THE REVIEWER NAMED ONE, AND THE SECOND ONE'S OWN DOCSTRING IS WHAT
  FOUND IT.** Plan 09's reviewer located the raw-instant validity comparison in `attributeInvoice`.
  The identical two lines lived in `pnl.ts:90–91`, inside `memberSpendFor` — a function whose
  docstring reads *"why this is `attributeInvoice`'s own predicate"* and whose file header promises
  that reusing the identical predicate *"is what stops 'whose bill is this' from being answered
  twice by two formulas that could quietly drift apart."* **Fixing only the copy the reviewer named
  would have made the file's own stated invariant false**, and left the channel P&L counting a
  different set of invoices than the ledger credits, for the same ~18.5 hours of every imported
  card's last day. Mutant built (`pnl.m.ts`, the two lines reverted): **DIED**, `memberSpendPaise: 0`
  against `100 000`.
  **The general form, and it is sharper than §2.54's.** §2.54 says two copies of one fact drift. The
  addition here is that **a comment asserting "this is the same as X" is a load-bearing claim that
  nothing executes** — it survived a gate, forty mutants and an independent review, and it went from
  true to false the moment the other copy was fixed. The repair is not "never write it twice": it is
  `istDayIndexSql`, one exported expression, plus a test that fails when the SQL and TS forms
  disagree at the boundaries. **If it must be written twice, make something red when the copies
  disagree.**
- **F9 — F3 IS RATIFIED, AND THE EVIDENCE FOR IT ALREADY SHIPPED IN T1.** T1 left open, explicitly
  for the owner, that under DD1's clamp *a refund never reduces a partner's commission* — with the
  worry that the commission might therefore never come down at all. **It does come down, at the
  credit note, and `creditNoteIssued` is in `ACCRUAL_EVENT_NAMES`** (`consumer.ts:76-81`), so the
  service event is subscribed. F8's amended leg in `accrual.test.ts` walks the whole sequence and
  proves it: credit note → **−10 000 lands there**; paying the refund → **appends nothing**; second
  credit note and its refund → −15 000; `payableTotalPaise` **0**.
  **So the ruling is not merely coherent, it is required by itself.** An `invoice_refund`
  structurally cannot exist without a credit note (`refunds.ts`: `creditNoteId` is required — *"the
  paper the refund draws on"*), and that credit note has already moved the commission. A second
  reduction at the cash event would count ONE service withdrawal TWICE. **No new test was written,
  because writing one would have duplicated `F8`'s leg rather than adding evidence** — the honest
  close is that the question was already answered by the code T1 shipped and nobody had noticed.
- **F10 — THE RACE IS WORSE THAN THE NUMBER THE PLAN CARRIED, AND THE FAIL-FIRST IS WHERE THAT
  SHOWED.** DD4 quotes Plan 09's T7 gate at *7 of 8 trials* double-counting. This phase's fail-first,
  running the final contention suite against the unlocked implementation, measured **8 of 8** —
  `doubleCounted: 8`, every trial, plus a block leg that read `"settled"` rather than `"pending"`,
  meaning the second import never waited at all. **Recorded because AGENT-RULES §4 says report the
  difference: the plan's number was an under-estimate, not an over-estimate**, and a phase that had
  quietly matched 7/8 would have looked like it reproduced the plan when it had actually found
  something worse.

- **F11 — THE SCHEMA HAD SAID SO ALL ALONG, IN A COMMENT ON THE COLUMN ITSELF.**
  `kernel/db/schema/membership.ts:106` declares `valid_to` with the trailing comment
  **`// K7 — evaluated at the IST day boundary`**. So MAJOR 3 was never a case of nobody having
  decided the semantics: the column that stores the value states them, the counter implements them,
  and two readers in `modules/partners` quietly did something else. **A defect can be a disagreement
  between a comment and its code rather than a gap in anybody's understanding**, and this one was
  legible from the schema file without reading a line of the accrual lane.
  Also checked while there, because a day-based predicate changes how NULLs behave: **both
  `valid_from` and `valid_to` are `notNull`**, so there is no third answer to widen into — the old
  and new predicates treat the same set of rows as candidates, and the only thing that moved is
  where the boundary falls.

### The independent reviewer (v3 §3.4)

**RAN 2026-08-26. 206,146 tokens, 83 tool calls, 24 minutes. Verdict as delivered: NOT SAFE TO ARM,
AND NOT SAFE TO CLOSE AS-IS.** One MAJOR that this phase INTRODUCED, one MAJOR inherited from Plan 09
and amplified here, three MINORs and three NOTEs.

**§2.102 held again, and this time it caught a defect the phase had just created.** Four tasks, five
mutants, five kills, three green full verifies and three green CI runs — and the re-key shipped in
T2 was wrong in a way none of it could see. **The reviewer is still the only instrument that
refutes**, and its 206k is the cheapest part of this phase for the second phase running.

#### MAJOR 1 — DD2's re-key merged TWO COUNTERPARTIES onto one subject. MINE, introduced by T2, now FIXED.

Dropping `agreement_id` from the key also dropped the only thing separating two counterparties,
because an agreement belongs to exactly one of them. `Σ` in `appendAccrualDelta` is scoped by
`subject_id` alone, so a second partner attributed to the same invoice **summed the first partner's
rows as its own prior and appended only the difference** — the incoming partner short-paid by
exactly what the outgoing one had been credited.

**Reachable through shipped code, and through ordinary operations rather than an attack.**
`membership_instances.patient_id` is *"null until a human links it"*; `match-queue` links it later;
`attributeInvoice` breaks ties on `seq`, which is insert order. **A card imported earlier and linked
later displaces the card currently attributed.** Reproduced independently before fixing:
`Expected [10_000] / Received [5_000]`.

**Under the OLD key partner B would have opened its own subject and been paid correctly** (A would
still have been wrong). **So T2 turned one wrong partner total into two** — which is the sharpest
possible statement of the defect and the reason it is MAJOR rather than MINOR.

**FIXED: the key is `(invoice_id, direction, counterparty_id)`** — migration `0029_faithful_sphinx`.
Exactly one step coarser than the agreement, so DD2's backdated amendment still lands on one
subject; exactly one step finer than the invoice, so two partners can never pool. `subject_id` then
determines `counterparty_id`, which is what makes the unqualified `Σ` correct — stated in
`accrual.ts` so the next person to widen the key knows what else moves.

**And the test that missed it now pins the key from BOTH sides.** `partners.test.ts` varied
`agreement_id` across every leg with `counterpartyId` FIXED — §2.102 exactly, the deciding field
identical in every leg. It now has a refused leg one step coarser (a second agreement) and an
allowed leg one step finer (a second counterparty). **Either leg alone is satisfied by a wrong key.**

**`0029` cannot fail on existing data**, unlike `0028`: it WIDENS the key, so it is strictly more
permissive. F6's own lesson was applied preemptively — the worker databases were cleared of the
fail-first's residue *before* the migration ran, and this time nothing went red.

#### MAJOR 2 — the receivable total is ORDER-DEPENDENT under concurrency. NOT FIXED, and deliberately.

Two statements quoting one slip at DIFFERENT amounts: the winner's figure stands and the loser's is
absorbed as a V3 correction. Reviewer's measured legs — honest-then-inflated → **90 000**, with
`linesDisputed: 0`; inflated-then-honest → **60 000**, the inflated line disputed; concurrent →
whichever wins the lock.

**I did not fix it, and the reason is that fixing it means overturning a ruled, deliberately tested
feature.** `G4/V3` pins an UPWARD correction to 75 000 against a 60 000 expectation and asserts
`linesCorrected: 1, linesDisputed: 0`. V3 exists so a later statement can amend an earlier
settlement; making the correction path dispute a differing amount would delete that. **The
absorption is Plan 09's ruling. What 09a adds is that under concurrency "later" is decided by a lock
rather than by an operator** — and choosing which statement is authoritative when two arrive at once
is a business rule, not a code detail.

**What I did instead:** the docstring I wrote in T4 claimed *"the partner is owed the money ONCE,
however the two imports interleave"* — **that claim is false and it was mine**, true only where both
statements quote the same amount. It is corrected in place, with the measured legs. And the
contention suite carried `60000` in BOTH race legs, so **the one field that decides the outcome was
equal in every leg** (§2.102, in the file I wrote to honour §2.102). There is now a differing-amount
leg asserting what IS true — one slip is never counted twice, and the surviving total is always one
of the two quoted figures and never their sum — and naming the order-dependence in its own title.
**That test is what will go red when the owner rules.**

**THIS GATES `RECEIVABLE_COMMISSION_ENABLED`.** See the open items below.

#### MINOR 3 — a concurrent same-`statementRef` import aborted with a raw `23505`. FIXED.

`appendCorrection` always inserts an expectation row carrying `(counterparty_id, statement_ref,
statement_line_no)`, so the loser collides with the partial unique index. The legible pre-check runs
on `db` OUTSIDE the transaction and cannot see an in-flight twin. **Money was already correct** (the
transaction rolls back); the error was unmapped. Now answers `statement_already_imported`, which is
what the pre-check itself answers.

#### MINOR 4 — T4 introduced an ABBA DEADLOCK. FIXED as a typed refusal; the better repair is named.

Two imports listing the same slips in OPPOSITE order deadlock. The reviewer measured 3/3 under a
forced interleave, and **3/3 CLEAN against the `.for("update")`-removed mutant — so it is T4's and
not pre-existing.** My own probe measured **13 of 14 natural pairs**, which makes it far more
reproducible than "MINOR" suggests, though the money is never wrong: the transaction rolls back
whole.

`40P01` now maps to a new code, **`statement_import_conflict`** — added to the closed union rather
than borrowed from it, because none of the existing codes means *try again* and
`expectation_state_conflict` would send a human to inspect a claim that is perfectly healthy (16a's
F5, same shape). It answers 409 through `partnersStatus`'s default. **Verified by execution, not by
assertion: 13 escaping errors, 13 typed, ZERO raw `40P01`.**

**The better repair is a deterministic lock order** — resolve every row first, then sort by
attribution id — and it is deliberately NOT taken here: it moves resolution out of the loop and
reorders `lines` in a money path's result, which deserves its own task and its own review rather
than a close remediation. Named as a follow-up.

#### MINOR 5 — `0028` has no guard for the duplicate the old key could produce. DOCUMENTED, not changed.

Reviewer reproduced the failure against a table holding DD2's shape and confirmed drizzle wraps
migrations in one transaction, so it rolls back cleanly — the deploy fails and the app does not boot,
rather than corrupting anything. **This is F6, independently found.** No dedupe was added, for F6's
own reason: a migration that silently deletes accrual subjects to make itself apply is worse than one
that refuses. Production measured at zero rows, so it cannot fire.

#### NOTE 6 — the block assertion failed vacuously in the unsafe direction. FIXED.

*"Still pending at 400 ms"* also passes for an implementation that is merely slow on a loaded box.
The suite now additionally asserts that the import settled **only after the holder committed** — it
waited on the LOCK, not on the machine.

#### NOTE 7 — my EvalPlanQual claim was OVER-GENERAL, which is to say wrong. FIXED.

I wrote that the woken loser re-evaluates and finds no row. The reviewer measured that with
`order by seq limit 1 for update` the `LockRows` node sits above the `Sort` and below the `Limit`, so
Postgres **RE-SCANS**: given two open rows the loser blocked 1,398 ms and returned **`r2`**. The
loser finds nothing here for a NARROWER reason — an INVARIANT, not a mechanism: `issueAttribution` is
the only writer of `state = 'expected'`, one row per attribution, and no path returns a row to
`expected`. The comment now says so, and says what breaks if that invariant ever stops holding.
**This is §2.105 landing on the very session that wrote §2.105.**

#### NOTE 8 — arming order. RECORDED.

T3 widens the matching set, so an invoice's attributed instrument can change. Free today at zero
accrual rows; after the ledger fills it would re-attribute already-accrued invoices.

### THE SECOND REVIEWER PASS — over the remediation, because the remediation was unreviewed code on a money path

**RAN 2026-08-26 over `4b92d24`. 268,625 tokens, 30 tool calls, 13 minutes.**

**Sending the reviewer back was not ceremony.** The MAJOR 1 fix changed a key and added a migration
on the same money path, and nothing had refuted it — closing on "my own tests are green" would have
been the precise mistake this phase exists to document. It found four more things, one of which
would have turned `main` red.

**Verdicts: PAYABLE (`COMMISSION_ACCRUAL_ENABLED`) SAFE TO ARM. PHASE SAFE TO CLOSE** with MAJOR 2
recorded as an owner ruling, after three corrections — all three taken below.

**It confirmed the fix from both sides, by execution.** The key is right (it looked for both failure
directions — one counterparty needing two subjects, two counterparties needing one — and found
neither); the unqualified `Σ` is sound because `appendAccrualDelta` is the only writer of a non-null
`subject_id`; `0029` cannot fail on existing data, verified twice, including against Plan-09-keyed
data carrying two counterparties on one invoice; and `.catch()` is at the right layer, swallows
nothing, and cannot mis-map a `PartnersError` (its `code` is a union member and cannot collide with a
five-character SQLSTATE). **Three of the four new tests DIED against mutants. The fourth survived,
and that is MINOR A.**

**MINOR A — MY TEST CLAIMED A DISCRIMINATION IT DOES NOT HAVE. CORRECTED.** The differing-amounts leg
said 150 000 *"is the assertion that would fail against a lock-less implementation"*. The reviewer
built that mutant and the leg **SURVIVED**, with byte-identical output. 150 000 is unreachable either
way: with differing amounts the loser meets the still-`expected` claim and takes the
`amount_mismatch` DISPUTE branch, which records no money. **A hand-walked prediction stated as a
property — rule 21's exact prohibition, written by the session that had just cited rule 21 twice.**
The clause is deleted and the comment now says which leg actually kills the lock (the equal-amounts
one).

**MINOR B — THE DEADLOCK LEG WAS 9 SECONDS INSIDE A 15-SECOND BUDGET, AND WOULD HAVE GONE RED ON A
BUSY RUNNER. CORRECTED.** Measured 8,887 / 9,028 / 9,069 ms on an IDLE host; the cost is structural
(`deadlock_timeout` is 1 s and the leg runs 8 trials). **My own comment said it "cannot flake in
either direction" — reasoning only about assertion outcomes and missing the timeout dimension
entirely.** `c3a2647` had already established the idiom for exactly this, in this repo, this month:
`RACE_TIMEOUT_MS = 60_000`. All four concurrent legs now carry it. **This is the finding that
justifies the second pass on its own** — it is Plan 09's §2.99 (one red in eighteen) about to happen
again, caught before the push instead of after.

**MINOR C — "SUBJECT DETERMINES COUNTERPARTY" WAS TRUE, UNENFORCED, IN A TABLE THAT ALREADY CARRIED
THE PATTERN. NOW A CONSTRAINT.** `commission_accruals` already had
`commission_accruals_counterparty_class_fk` stopping a denormalised `payee_class` disagreeing with
its parent; the `(subject_id, counterparty_id)` pair had simply never been given the same treatment.
Migration `0030` adds a `unique (id, counterparty_id)` on subjects and the composite FK.
**`MATCH SIMPLE` is the default, so kicker and statement rows (`subject_id` null) are unaffected.**
This turns my own comment — *"if you ever widen this key again, that sum needs a counterparty
predicate on the same commit"* — from a sentence into something the database enforces. **This phase
widened that key wrongly once; the guard has earned its migration.**

**MINOR D — `0028` IS A TRANSIENT KEY STRICTER THAN EITHER ENDPOINT, AND IT BLOCKS THE CHAIN.**
Sharpens F6/MINOR 5, and it is the one that will bite a future reader. On data legal under Plan 09's
key — two counterparties on one invoice, the exact shape `4b92d24` now blesses as CORRECT — **`0028`
fails** while `0029`'s key over the same data succeeds. drizzle runs all pending migrations in one
transaction, so **a database at `0026` holding such rows cannot reach `0029` at all.** Not live
(production re-measured at 0 subjects / 0 accruals / 26 migrations). **Recorded here because a future
dedupe would naturally be written against `0029`'s key and would still be blocked by `0028`'s.**

**NOTE E — MY "STRENGTHENED" ASSERTION WAS ENTAILED BY THE ONE IT STRENGTHENED. CORRECTED.**
`settledAfterMs >= HOLD_MS` cannot fail independently of `stateAt400 === "pending"`, because
`settledAfterMs` is only read after `await p`. **An assertion that cannot fail independently of
another is not a second check; it is a longer way of writing the first.** The independent fact is on
the other side of the release — having waited, the import resumed PROMPTLY once the row was let go —
and that is what it now asserts, against a deliberately loose bound so it cannot flake.

**NOTE F — MINOR 3's FIX WORKED AND NOTHING REQUIRED IT TO. TEST ADDED.** The `23505` branch measured
8/8 green, but no test drove it: `statements.test.ts` covers only the sequential pre-check and the
deadlock leg uses different references. **A branch with no test is a branch the next refactor deletes
with a green suite.** There is now a same-`statementRef` race leg.

**NOTE G — the `23505` mapping keys on the CONSTRAINT NAME, not on evidence of a race**, so a genuine
logic-error duplicate would read as "already imported" rather than the loud 500 it deserves. Only
reachable through the race today. **Named in the code rather than fixed**, because narrowing it
reliably at the catch site is not possible and the comment is the honest carrier.

**NOTE H — the stranded-A residual is queryable now, and was not before.** Under `0028`'s pooled key
the condition was structurally invisible; under `0029`'s it is
`select invoice_id, direction from commission_accrual_subjects group by 1,2 having count(*) > 1`.
**That query is the operational detector for open item 3** and belongs in the runbook beside the
flag flip.

**AND ONE THE REVIEWER DID NOT FIND, BECAUSE IT DID NOT EXIST YET: `drizzle-kit` GENERATED AN
UNRUNNABLE MIGRATION.** `0030` came out with the composite FOREIGN KEY *before* the UNIQUE constraint
it references — `ERROR: there is no unique constraint matching given keys for referenced table
"commission_accrual_subjects"`, measured across four suites and 69 tests, every one failing on that
line. **The statement order is hand-corrected in the `.sql` and the file says so at the top**;
`_journal.json` is untouched (AGENT-RULES §6). **Generated is not the same as correct, and the only
thing that told me was running it.**

#### What the reviewer checked and found CLEAN

Worth recording beside the findings, because it is what the close actually rests on: **the T1 clamp**
(complete — every operand floored at zero, `enteredInError` short-circuits ahead of it, and
`accrual.ts:147` is grep-confirmed the module's ONLY ratio, so MAJOR 1 of Plan 09 has no second
copy); **A2 built and DIED** on the pre-existing `p07` fixture, the one golden where
`eligibleBase ≠ settleable` — the reviewer's own §2.102 suspicion about the clamp was raised and then
**refuted by measurement**, which is the right way round; **A5 built and DIED** on both legs (block
`settled`, race 8/8 at 120 000); **A3's discrimination** proven by showing the old index accepts the
exact row the new leg expects refused; **T3's algebra exhaustively** — 0 disagreements over
**2,000,000 randomised cases** across day indices −10,000 to 2079, so no over-widening beyond the
counter's own window; **T3's TS↔SQL equality** over 13 boundary instants × 3 session timezones, 0
mismatches, using the exact parameterised text drizzle emits; **no third copy** of the predicate
anywhere; **sargability measured** at 200,000 invoices × 40,000 instances — 25.8 ms raw-instant
against 28.6 ms day-index, identical plan shape, irrelevant at hospital volume; **the lock-mode
matrix independently reproduced** (`FOR KEY SHARE` 1,509 ms vs a bare `UPDATE` at 2.1 ms), confirming
F7; **`subjectRows[0]!` cannot be undefined** — the speculative insert waits for the in-flight twin
and the following `for update` sees the committed row; **`agreement_id` is authoritative to no
reader** anywhere in `apps/` or `packages/`; and **integer precision** — `eligibleBase × collected`
exceeds 2⁵³ around ₹9.5 lakh but the post-division error is sub-paisa in every reachable case.


### Mechanical verification

**The four task commits, and the whole phase is only these four** — `0f747fe` is the phase document
and everything between it and `79afbf6` on `main` belongs to Plan 16a, which ran interleaved on the
same branch. A range diff of `0f747fe..79afbf6` is 41,332 insertions across 72 files and is NOT this
phase; the phase is 2,115 insertions across nine shipped files, of which 11,475 lines are the
generated `0028` snapshot.

| commit | shipped files | insertions |
|---|---|---|
| `0f77004` T1 | `accrual.ts`, `accrual.test.ts`, `consumer.test.ts`, one golden fixture | 118 |
| `54ab73b` T2 | `partners.ts`, `partners.test.ts`, `accrual.ts`, `accrual.test.ts`, migration `0028` | 133 + snapshot |
| `a092ecc` T3 | `accrual.ts`, `accrual.test.ts`, `pnl.ts` | 220 |
| `79afbf6` T4 | `statements.ts`, `statements.contention.test.ts` | 169 |

**Frozen paths — CLEAN, verified by the diff and not by assertion.**
`git diff --name-only 0f747fe..79afbf6 -- apps/core/src/modules/tariff/
kernel/events/dispatcher.ts kernel/db/schema/billing.ts` returns **empty**. Nothing in
`modules/tariff/`, the dispatcher or the billing schema was touched, which is what the LANE ruling
froze.

**Counts.** 212 suites / 1847 tests at kickoff → **213 / 1856** at close. `pnpm verify` exit 0 was
run and READ (never through a pipe — rule 16) before each of the three pushes this session made:
T2 at 212/1848, T3 at 212/1854, T4 at 213/1856. `apps/web` 43 files / 259 tests and
`packages/contracts` 4/21 are unchanged throughout. **No test was deleted and no count decreased at
any step.**

**The contention suite was run FOUR times before it was allowed onto `main`**, because it asserts a
timing and Plan 09's close cost hours to a test that was red one run in eighteen (§2.99). 4/4 green,
2 passed / 2 total each time. That is not proof it cannot flake — §2.80 binds in the other
direction — but an unstable 400 ms race would not have survived four consecutive runs.

**Test-database hygiene, disclosed because it was a host mutation.** T2's fail-first left two
duplicate subject rows in worker database `hmis_test_1` and blocked migration `0028` (F6). They were
removed with `truncate table commission_accruals, commission_accrual_subjects` — the statement
`truncateAll` itself runs, chosen because the DD5 append-only trigger correctly refuses a `DELETE`.
The A3 mutant swapped the unique index in that same worker database and restored it in an `afterAll`
that runs on any outcome; **the index was then re-read in every worker database rather than assumed**
— `hmis_test_1` through `hmis_test_7` all carry `(invoice_id, direction)`, and `hmis_test_8` carries
no such index because it predates the partners tables entirely and will migrate on next use.
A scratch database `hmis_09a_lockprobe` was created for F7's measurement and **dropped** (rule 7).

**Rule 20 was honoured and is worth stating rather than assuming.** `pgrep -af jest` was run before
every timing measurement and read as LINES: the only match each time was the probe's own shell,
which contains the literal string `jest` and matches itself. **No concurrent test run was observed
at any point**, and no measurement in this document was taken while another suite was running.

**CI by full SHA — and one gap, stated rather than smoothed over.**

| commit | CI |
|---|---|
| `0f77004` T1 | **NO RUN OF ITS OWN** — see below |
| `54ab73b` T2 | `completed/success` |
| `a092ecc` T3 | `completed/success` |
| `79afbf6` T4 | `completed/success` |

**T1 has no CI run at its own SHA, and the reason is mechanical rather than a lapse.** GitHub
creates a workflow run for the HEAD of a push, not for every commit inside it, so a task committed
and pushed alongside later commits never gets a run of its own. T1's code is nevertheless covered:
`54ab73b`, `a092ecc` and `79afbf6` all contain it and all three are green by full SHA. **The
per-commit guarantee the LANE asked for is therefore true for T2–T4 and only transitively true for
T1**, and that is worth writing down because "every task commit green by full SHA" is a sentence
this project's close reports make routinely and it was not literally true here.
**The rule it implies: one push per task commit, or the guarantee is weaker than the sentence.**

**And this phase ran through a GitHub Actions MAJOR OUTAGE**, which is why the timings look strange
in the run list. Between roughly 15:11 and 18:00 UTC on 2026-08-26 Actions was degraded and
`7a34cae` — pushed before this phase began — sat with **zero** check runs for over forty minutes
(`total_count: 0`, commit status `pending`), which is indistinguishable at a glance from a workflow
that is not configured. It was NOT a repository fault: `on: [push]`, workflow `active`, repo public.
Every run in the backlog eventually landed and every one was green. **Recorded because the honest
diagnosis took one call to `githubstatus.com` and the tempting one — "something is wrong with our
CI" — would have cost an hour** (§2.64's shape, one level out: a CI observation that cannot be
explained by the diff is a candidate for *the provider's status page* before it is a candidate for
diagnosis).

### ONE COMMIT WENT CI RED, AND FOUR GREEN RUNS ON IDENTICAL CODE SETTLED IT

**`ff79eb9` — the second review remediation — is RED.** Every other commit of the phase is green by
full SHA, including the four that follow it.

**The log named the failure in one call, and it is in a suite this phase does not touch.**
`src/kernel/worker/scheduler.test.ts`: *"invokes all ten jobs across a stepwise advance from a pinned
instant"* overran **its own 120,000 ms budget to 186 s**, and its timeout then cascaded into four
`Exceeded timeout of 15000 ms for a hook` failures in the tests after it. **That cascade is Plan 16a's
named open item verbatim** — *"a timed-out race leg still poisons the fixtures of the tests after it
— which is why ONE timeout produced four failures"* — here producing five.

**THE CONTROLLED OBSERVATION, and this phase got four of them instead of Plan 09's one.**
`git diff --name-only ff79eb9..8eabf45 -- apps/ packages/` is **EMPTY**. The four commits after the
red one changed documentation and a hook and nothing else, so **the test surface was byte-identical
across one RED run and four GREEN ones.** Red then green on identical code is nondeterminism proven
by execution (§2.98). `pnpm verify` on that exact tree was exit 0 locally as well.

**FINAL CI STATE — every commit of this phase, by full SHA:** `0f77004` (no run of its own, §2.106) ·
`54ab73b` ✅ · `a092ecc` ✅ · `79afbf6` ✅ · `4b92d24` ✅ · **`ff79eb9` ❌ (the flake above)** ·
`9f9ec96` ✅ · `0fba3ae` ✅ · `b7ae37a` ✅ · `8eabf45` ✅ · **`24f9272` ✅ — HEAD, and it carries the
trial reduction.** Eleven commits, one red, and the red is refuted by five green runs over an
identical test surface.

**§2.80 still binds in the other direction: four green runs refute determinism, they do not prove the
flake is gone.** It is a real flake, it is named, and it belongs to `scheduler.test.ts` rather than to
this phase.

**AND THE HALF THAT IS MINE, WHICH IS NOT THE SAME QUESTION.** *"Not my defect"* and *"not my
contribution"* are different claims, and only the first was true. The deadlock leg deliberately
deadlocks two transactions per trial, and Postgres resolves a deadlock only after `deadlock_timeout`
— **eight trials measured at 9,047 ms of real lock contention** against a database every other suite
shares, in a file jest runs in parallel with all of them. It plausibly raises the probability of
exactly the timeout that fired.

**Cut to three trials: 9,047 ms → 3,839 ms, a 58% reduction with the same evidence.** The leg measures
a MAPPING (whatever escapes must be typed), not a probability; at the observed 13-of-14 deadlock rate
three trials still see one with ~99.96% probability, and the assertion never asserts that a deadlock
happens. **The cheapest honest response to "my load may have contributed" is to stop adding the
load**, and it cost nothing to verify.

### CLOSED — 2026-08-26

**The gate is discharged.** Two independent review passes ran (v3 §3.4). The first found a MAJOR this
phase had INTRODUCED and returned *not safe to close*; the second reviewed the remediation and
returned **PAYABLE SAFE TO ARM, PHASE SAFE TO CLOSE** after three corrections, all three taken.

**Every one of Plan 09's four MAJORs is fixed, and so is the fifth that T2's own fix created.**
`pnpm verify` exit 0 at close: core **213 suites / 1,860 tests**, web 43 / 259, contracts 4 / 21.
Counts across the phase **212 / 1,847 → 213 / 1,860**, nothing deleted. Seven commits: four tasks
`0f77004` · `54ab73b` · `a092ecc` · `79afbf6`, two review remediations `4b92d24` · `ff79eb9`, the
CLOSE `9f9ec96` (with the token audit at `0fba3ae`) and the CI-load reduction `24f9272`.
**`pnpm verify` exit 0 and CI green at HEAD.** Three migrations — `0028` the re-key, `0029` its
correction after the first review, `0030` the composite FK from the second.

**`COMMISSION_ACCRUAL_ENABLED` is safe to arm** on a system with no accrual history, subject to open
item 3 being ruled first on any system where cards are imported and matched.
**`RECEIVABLE_COMMISSION_ENABLED` is NOT**, and open item 1 is why.

**What the phase actually cost, stated plainly: the reviewer found more defects than the tasks did.**
Four tasks, five required mutants, five kills, five green verifies and four green CI runs produced a
tree carrying a MAJOR, a test that would have gone red on a busy runner, and three false claims in
comments I had written. **Two review passes cost 474,771 tokens — 40% over the stop-loss — and every
one of those findings was real.**

### OPEN ITEMS — what this phase did NOT close, and what each one gates

**1. MAJOR 2 — the V3 correction path absorbs a differing amount, and under concurrency the lock
decides which figure survives. THIS GATES `RECEIVABLE_COMMISSION_ENABLED`, and it is an OWNER
RULING, not a code fix.** The question in one sentence: *when a partner's later statement quotes a
different figure for a slip already settled, should the hospital absorb it as an amendment (today's
behaviour, pinned by `G4/V3`), dispute it against our own expectation, or require an approval for an
upward correction?* All three are defensible; the first is what Plan 09 ruled and tested. Until it is
answered, two operators importing overlapping statements at the same moment can produce two different
receivable totals from the same pair of files. **`statements.contention.test.ts`'s differing-amount
leg is written so that it goes red when the ruling lands.**

**2. The deterministic lock order for `importStatement` (MINOR 4's better repair).** Resolve every
row, sort by attribution id, then take locks in one order. Not taken in a close remediation because
it moves resolution out of the loop and reorders `lines` in a money path's result. Today a deadlock
is a typed retryable refusal, and the money is never wrong.

**3. Re-attribution has no ruling — PRE-EXISTING, and this phase neither caused it nor fixed it.**
When a card imported earlier is linked later and displaces the attributed one, partner A keeps what
it was credited and partner B is credited its own full target: **the invoice pays two partners.**
The three keys make this exact, and the arithmetic is worth setting out because it is the only way
to see that the fix is the minimal one:

| subject key | A gets | B gets | total on a 100 000 invoice |
|---|---|---|---|
| Plan 09 — `(agreement, invoice, direction)` | 5 000 | 10 000 ✓ | **15 000** |
| T2 as first shipped — `(invoice, direction)` | 5 000 | **5 000 ✗** | 10 000 |
| T2 as corrected — `(invoice, direction, counterparty)` | 5 000 | 10 000 ✓ | **15 000** |

**So the double payout is Plan 09's and is unchanged here.** What T2 briefly did was worse in a
different way — it made the TOTAL look right (10 000) by short-paying the arriving partner and
leaving half the money with the wrong one, which is the failure mode hardest to notice in a
reconciliation. The corrected key restores Plan 09's behaviour for two counterparties while still
fixing the backdated amendment, which is what "minimal" means here.

**The unruled question is what A owes back**, and nothing in the system reverses A's row: the
consumer only ever computes deltas for the CURRENT attribution, so A's subject is never revisited.
Free today at zero accrual rows. **It must be ruled before `COMMISSION_ACCRUAL_ENABLED` is armed on
a system where cards are imported and matched later** — which is every real deployment.

**4. `0028` cannot apply to a database holding a duplicate** (F6 / MINOR 5). Harmless while the lane
is off; a de-dup step would be needed ahead of it on any deployment that ever ran the lane armed.

### Was the phase's own question answered?

**Yes. All four MAJORs Plan 09's reviewer named are fixed, and the fifth — introduced by T2's own
fix — was caught before it reached production.** T1 clamps the ratio, T2 keys the subject per
invoice AND per counterparty, T3 gives the ledger the counter's clock in both places it was wrong,
T4 serialises the receivable lane. What is NOT answered is a question this phase discovered rather
than inherited: what a receivable does when two statements disagree, and what a re-attribution owes
the partner it displaces.

### Ledger entries this phase earned

- **§2.103** — a migration that adds a uniqueness constraint can fail on data that already exists,
  and the first database it breaks is your own test worker; a fail-first that exercises a data
  defect poisons the fixture for its own fix; do NOT make the migration self-healing.
- **§2.104** — a lock mode that discriminated in one suite can prove nothing in the next. The mode
  is a property of **the statement the mutant reaches next**, not of the suite that last needed one.
  Carries the measured matrix, and the fact that a partial unique index is excluded from Postgres's
  key-attribute set.
- **§2.105** — a comment that says *"this is the same as X"* is a load-bearing claim nothing
  executes, and it goes false the day somebody fixes X. Two separable rules: a reviewer's finding
  names the SITE it found, not the defect's EXTENT (grep before you call it fixed); and where one
  fact must be written twice, ship one exported expression plus a test that reddens when the forms
  disagree.
- **§2.106** — *"every task commit green by full SHA"* is false for any task not pushed on its own,
  because GitHub runs the push's HEAD and not each commit inside it. Plus: a CI observation the diff
  cannot explain is a candidate for the provider's status page before it is a candidate for
  diagnosis.

**And four more from the close audit, which are about the METHOD rather than the code:**

- **§2.107** — the review budget is not overhead on a phase, it is the part of the phase that finds
  the defects. Carries the instrument ledger that is this phase's whole argument: five dead mutants,
  five green verifies and four green CI runs over a tree carrying a MAJOR.
- **§2.108** — a RESUMED agent starts full, so §9's metric is what an agent CARRIES and never what
  its brief POINTS AT. Same agent, same pointers, smaller diff, 3.6× the per-call cost.
- **§2.109** — `drizzle-kit` emits a composite foreign key before the unique constraint it
  references, and the migration is unrunnable as generated. Generated is not the same as correct.
- **§2.110** — a mutant that SURVIVES is worth more than one that dies. Any sentence of the form
  *"this would fail against X"* is either an executed result or it must be deleted.

### Production — MEASURED 2026-08-26 17:36 UTC, read-only, against `hmis-prod-db-1`

**Nothing this phase changed can affect the hospital today, and that is measured rather than
assumed.** The entire partner lane is empty:

| table | rows |
|---|---|
| `commission_accruals` | **0** |
| `commission_accrual_subjects` | **0** |
| `receivable_expectations` | **0** |
| `attribution_ids` | **0** |
| `membership_instances` | **0** |
| `partner_agreements` | **0** |
| `counterparties` | **0** |
| `invoices` | 5 |

All five flags are UNSET in the running `hmis-prod-api-1` environment, so all five read their
`false` default (DD14). **Three consequences worth stating, because each of them is a risk that did
not materialise rather than a risk that does not exist:**

1. **`0028` cannot fail on deploy** — the unique index it creates meets zero rows (F6).
2. **T3's changed predicate rewrites no history.** `attributeInvoice` is what `replayAccruals` walks,
   so a day-based predicate would in principle re-attribute past invoices; with an empty ledger and
   no membership instance there is nothing to re-attribute. **The phase therefore never had to
   answer what a replay should do about invoices already accrued under the old predicate** — and a
   future phase arming the lane over historical data will have to.
3. **T4's serializer has never been contended in production**, because no statement has ever been
   imported.

**PRODUCTION IS THREE MIGRATIONS BEHIND `main`: 26 of 29 applied.** `0026` and `0027` (Plan 16a's
formulary) and `0028` (this phase) are on `main` and NOT deployed. **This phase deliberately did not
deploy** — it is a correctness phase behind dead flags, and the deploy that carries `0028` is the
owner's to authorise. Recorded here so the next reader does not assume the fix is live: **the four
MAJORs are fixed on `main` and are still present in the running system**, harmless only because the
flags that would reach them are false.

### Actuals, and the §9 test

**Subagents: ONE, used TWICE.** The LIGHT lane carried no briefs, so the only agent in the phase is
the closing reviewer — and it ran a second time over its own findings' remediation, which the lane
block did not model.

| | tokens | tool calls | wall |
|---|---|---|---|
| reviewer, pass 1 (the four tasks) | **206,146** | 83 | 24 m |
| reviewer, pass 2 (the remediation `4b92d24`) | **268,625** | 30 | 13 m |
| **reviewer, total** | **474,771** | 113 | 37 m |
| **stop-loss (v3 §6)** | **340,000** | | |

#### The §9 test — did context-per-call fall?

**Yes, and the comparison is per-CALL because that is what §9 is about** (an agent is re-billed for
its whole context on every call, so a bigger pointer set costs more the longer the agent runs):

| reviewer | tokens | calls | **per call** |
|---|---|---|---|
| Plan 09 | 335,870 | 104 | ~3,230 |
| Plan 16a | 181,605 | 37 | ~4,910 |
| **Plan 09a, pass 1** | **206,146** | **83** | **~2,480** |
| **Plan 09a, pass 2** (resumed) | **268,625** | **30** | **~8,950** |

**Pass 1 is roughly half 16a's per-call and a quarter under Plan 09's**, and the lane block predicted
the mechanism exactly: cite ledger entries BY NUMBER instead of pointing at an 82k file, and name a
short phase document instead of a 37k one.

**PASS 2 REFUTES THE NAÏVE READING OF §9, AND THAT IS THE MORE USEFUL RESULT.** At ~8,950 tokens per
call it is nearly four times pass 1 and nearly double 16a's — from the SAME agent, with the SAME
pointers, over a SMALLER diff. **Because it is a RESUMED agent: it carried pass 1's whole context —
every file it had read, every probe it had run — into every one of its 30 calls.** §9's rule is about
what an agent CARRIES, not about what its brief POINTS AT, and a resumed reviewer starts full.

**The amendment §9 needs, then:** context-per-call is the right metric, but a resumed agent must be
budgeted as one that starts at its predecessor's high-water mark, not as a cheap follow-up. Pass 2
cost 30% MORE than pass 1 for 36% of the calls. **It was still worth every token** — MINOR B alone
would have turned `main` red — which is the point: the planning number is not "the second review is
cheap".

**Two honest caveats.** The phase is genuinely smaller, so some of the fall is scope rather than
method — the per-call figure controls for that better than the total does, but not perfectly. And
**I cost the reviewer tokens with a bad pointer**: its brief named `git diff 0f747fe..79afbf6`, which
sweeps in the whole of Plan 16a (41,332 insertions, 72 files) because the two phases interleaved on
one branch. It was corrected mid-run and the agent confirmed it opened no 16a source file, but the
first `--stat` was already paid for. **The lesson is small and exact: a phase that ran interleaved
has no usable commit RANGE — name its commits by SHA.**

#### THE STOP-LOSS MODELLED THE TASKS AND NOT THE REVIEW CYCLE, AND THAT IS THE §6 FINDING

**340k = 1.5 × 56k (11h's per-task rate) × 4 tasks.** The arithmetic is right and §6's amendment
worked — it is a per-task rate applied to a task count, not 1.5× somebody else's total, which is
what ledger §2.95 was written for.

**But the model has no term for the review-and-remediate cycle**, and that cycle is not optional: v3
§3.4 makes the reviewer a gate, and a gate that finds a MAJOR necessarily triggers a fix and a
re-review. **Pass 1 alone spent 206k of 340k before a single defect had been fixed**, and pass 2 is
spent on code that did not exist when the number was set. A stop-loss that only counts tasks will be
breached by any phase whose reviewer does its job — and a tripwire that fires when the method works
is a tripwire pointing the wrong way.

**MEASURED: the reviewer cost 474,771 tokens against a 340,000 stop-loss — breached by 40%, entirely
on the gate that made the phase correct.** Four tasks of coding produced a tree that was green
everywhere and carried a MAJOR. **A stop-loss enforced at 340k would have halted this phase before
the counterparty-pooling defect was found, and shipped it.**

**Proposed §6 amendment, for the owner:** a phase's stop-loss is
`1.5 × per-task rate × task count` **+ a REVIEW BUDGET of one full reviewer pass per remediation
cycle**, taken from actuals — 16a 181k for one pass; 09a 475k for two. On this phase that reads
~340k + ~475k ≈ 815k and nothing trips. **Recorded as a proposal, not taken: the stop-loss is a
governance number and changing it is the owner's.** The finding underneath it is not a proposal —
**the review budget is not overhead on the phase, it is the part of the phase that found the
defects.**

#### Verification depth — did the four fixes cost anything?

No, and the numbers are the argument. **212 suites / 1,847 tests at kickoff → 213 / 1,860 at
close** — thirteen tests added, none deleted. **Five Assertion Book mutants required, five built, five died** — plus
seven the Book never asked for (the P&L copy, the A3 index swap, my deadlock probe, and the
reviewer's four against the remediation). Of those seven, one found a real defect (the P&L second
copy) and **one SURVIVED and became MINOR A** — which is the whole argument for building them:
a mutant that survives is worth more than one that dies, because it is the only thing that can tell
you an assertion does not do what its comment says. Five full `pnpm verify` runs, each exit 0 and each READ from
an exit file rather than through a pipe. The contention suite was run four times before it was
allowed onto `main`. **The one thing depth did not buy was MAJOR 1** — which is §2.102's whole point,
and the reason the reviewer is a gate rather than a courtesy.
