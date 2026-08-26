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
invariant always meant. Migration `0026`.

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
| T1 — the clamp | _pending push_ | **A1 DIED**; 18/18 accrual, 14/14 golden |
| _appended as each lands_ | | |

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

### Findings

### The independent reviewer (v3 §3.4)

### Mechanical verification

### Actuals, and the §9 test
_The token audit runs here (v3 §9.2). The question it must answer: did context-per-call fall against
Plan 09's 374,461, and did this phase's four fixes cost anything in verification depth?_
