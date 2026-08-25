# Plan 09 — Memberships, Coupons & the Accrual Ledger

**Written 2026-08-25 on the build host, under [`EXECUTE-METHOD-V3.md`](../EXECUTE-METHOD-V3.md).**
Slot: **immediately after Plan 11h**, which closed at `d7a8981` with CI green. The plan-series
roadmap ([`2026-08-11-phase1-plan-series.md`](2026-08-11-phase1-plan-series.md) § Plan 09) is the
authority for WHY this phase exists and what re-shaped it; this document is the authority for
what gets built. Its one-line status amendment lands at this phase's CLOSE, not before.

**This document is TRACKED and the repository is PUBLIC.** The two context files
(`/opt/hmis-context/plan-09-channel-partners-2026-08-23.md`, the partner book, and
`/opt/hmis-context/plan-09-brainstorm-2026-08-25.md`, the approved brainstorm) are out of git by
owner ruling and are **referenced by path only**. No partner name, partner code, plan code, coupon
code, rate, price, card number, agreement reference or sample person from either file appears
anywhere in this document, in `apps/`, or in any fixture. See **DD3**, which makes that rule
checkable rather than merely stated.

---

## THE LANE — ruled at write time, v3 §2

**HEAVY — the FULL pipeline** ([`EXECUTE-METHOD.md`](../EXECUTE-METHOD.md) as the HEAVY-lane
manual, invoked by pointer per v3 §2). **Ruled by the owner in the execution prompt of 2026-08-25**,
and the ruling is well-founded on this project's own evidence rather than on preference: this is a
full two-module build (seventeen tables, one migration, two new Nest modules, a dispatcher consumer,
an import lane, a reconciliation lane and a counter surface) with **money arithmetic and lock
discipline in five of its eight tasks**. v3 §2 reserves HEAVY for exactly that — "many-task module
builds of the plan-05/07/08 shape" — and 11e/11f/11g/11h were all LIGHT because none of them
priced anything. Seven of eight tasks are CRITICAL; the Assertion Book count below is this phase's
own risk assessment, written before any code exists (EXECUTE-METHOD §8).

v3's other three clauses hold unchanged inside the HEAVY lane: **one document per phase** (this
one — no separate brainstorm prompt, spike brief, spike report, execute prompt, findings inbox or
gate report), **checks are scripts** (§4 — T1 ships the `loadConfig()` lint rule that F1 asked for
rather than another prose checklist line), and **actuals with a stop-loss, never a predicted
budget** (§6).

**Stop-loss (v3 §6): 4.5M subagent tokens.** Set at 1.5× the last comparable HEAVY phase's measured
actual — Plan 11d, **2,884,873 subagent tokens across 15 agents**. It is stated in SUBAGENT tokens
deliberately: three phases running, the all-sessions total has been unmeasurable from inside the
session (runbook O3, 11e/11g/11h CLOSE all say so), and a tripwire nobody can read is not a
tripwire. Subagent tokens are the dominant cost of a HEAVY pipeline and the Agent tool reports them
per call, so this number is one the running session can actually watch.
**Honest caveat, recorded in advance:** this phase carries eight tasks against 11d's five, so the
tripwire may fire on SCOPE rather than on waste. If it fires, the correct owner decision is
**split the phase at a task boundary** (T1–T4 ship recognition; T5–T8 ship the ledger), not
"spend more" — the task order in §6 is chosen so that boundary is clean.

**Frozen paths — nothing in this phase may commit a change to any of these:**
`apps/core/src/modules/tariff/**` — **the whole directory, not only `index.ts`** (DD2 explains why
the stronger freeze is free) · `apps/core/src/kernel/events/dispatcher.ts` ·
`apps/core/src/kernel/db/schema/billing.ts` · `apps/core/drizzle/**` except the ONE migration T1
generates and its `meta/` snapshot · `docker/prod/Caddyfile` and `docker/prod/docker-compose.prod.yml`
(§6.0 S11 measured that neither needs to change: every call already goes through the one `/api` door)
· `.github/workflows/**` (AGENT-RULES rule 10).

**How the HEAVY lane meets v3's one-document rule, since the two look like they collide.** v3 §1
retires the findings inbox as an artifact; EXECUTE-METHOD §2.16/§2.39 needs one, because under the
Workflow tool the waves run back-to-back and **the main session is not between them** — a finding
that names a later task has nowhere to go. Both are satisfied by making the relay **transient**:
this pipeline uses an UNTRACKED scratch file at `/opt/hmis/.plan-09-relay.md` that agents append to
and nobody commits, and **the main session folds its contents into §8 CLOSE at the end**. v3 retires
the inbox as a second *artifact*; it does not retire the mechanism, and an uncommitted relay whose
output lands in the one document is not a second artifact. Recorded here so the independent reviewer
reads it as the ruling it is rather than as a v3 violation.

**`docker/prod/deploy.sh` is deliberately NOT frozen** — T3 adds one seed line to it (§6.0 S14), and
that is the only edit any task may make there.

---

## 1. Why this phase

The hospital operates memberships, coupons, packages and referral arrangements **today**, through
two contracted channel partners, because a non-profit-trust medical-college hospital cannot run
them commercially direct. Those holders walk up to a counter that is about to be replaced. The new
counter does not know they exist — it cannot recognise a card, cannot apply the benefit the member
paid for, and cannot attribute anything to the partner who sold it. Every day the pilot runs
without this module is a day the counter either refuses a paying member or honours them off-system,
and the second is worse than the first because it produces a discount nobody can reconcile.

The ordering constraint is not a preference, it is arithmetic. The accrual side of this module has
a **replay property**: a commission is a function of `payment.received` plus attribution, so
attribution entered late can be backfilled from event history and the ledger comes out right.
Counter discounts have no such property — a benefit not applied at the moment of billing cannot be
applied afterwards without a credit note, an approval and a queue. **Recognition must therefore be
live before the counter bills its first member**, which is why this phase's tasks are ordered
recognition-first and why the runbook's flag flips are ordered rather than listed.

The third reason is that the ledger is where a trust hospital's exposure lives. Money flows to and
from partners under agreements with versioned terms; nothing is ever payable to an external RMP
(C-1); commission income for the trust sits under §11(4A) and is gated on counsel and the CA. This
phase builds the machinery so that when those answers arrive they are a **flag flip against tested
code**, not a new project. Everything gated by the CA/counsel register ships structurally OFF, in
the same shape as the sales lanes, and the owner flips it — that boundary is **O-8**, and it is the
one ruling this session did not take.

---

## 2. Ground truth — measured 2026-08-25 on the build host

Every line below was read or run on `/opt/hmis` at `d7a8981` this session. §2.21's shelf life
applies: these are facts about the tree at that SHA, and the compile sweep re-runs the ones that
move.

| | |
|---|---|
| HEAD | `d7a8981`, CI **GREEN** (`ci-watch-host.sh`, run 32822980941, 560 s) |
| migrations | **22 applied, head `0021_search_trigram`** (`drizzle/meta/_journal.json` idx 21). T1 generates `0022`. |
| modules under `apps/core/src/modules/` | four: `patients`, `tariff`, `opd`, `billing`. This phase adds two. |
| manifests | nine, in `kernel/modules/manifests.ts` `ALL_MANIFESTS`, installed by `app.module.ts` in ONE loop (11d D2). The worker installs its own set and `manifests.test.ts` pins BOTH and asserts the difference is deliberate. |
| worker consumers | `workerConsumers(db)` in `kernel/worker/worker.module.ts` — the one importable place the production map exists (Plan 10 T5). Two entries today: `kernel.alerts`, `kernel.notify`. |
| `AdjustmentSource` | `modules/tariff/types.ts`: `{ key, propose(ctx, line, grossPaise): AdjustmentCandidate[] }` — **PURE and SYNC**. `PricingContext.sources` is an array whose ORDER is tie-break precedence (D3). `loadPricingContext` hard-codes `[standingRuleSource, manualDiscountSource]`. |
| the contest | `runContest` sorts valid candidates by `amountPaise` DESC, then by `ctx.sources` order, then `ruleKey` asc with nulls last. **Best single benefit; rejected candidates are recorded, never dropped.** |
| the frozen index exports Plan 09 needs | `priceInvoiceLines`, `runContest`, `standingRuleSource`, `manualDiscountSource`, `assertPaise`, `divHalfUp`, `percentAmount`, `roundTotalToRupee`, `taxHead`, and `export * from "./types"` (so `AdjustmentSource`, `PricingContext`, `AdjustmentCandidate`, `InvoiceLineInput`, `PricedLine` are all reachable). **Everything this phase needs is already exported.** |
| billing's pricing seam | `priceDraft` in `modules/billing/invoices.ts:249` — `loadPricingContext` (outside the transaction, `Db` not `Tx`), then `assertBoundaryPaise`, then `priceInvoiceLines`. |
| `invoice_lines` columns this phase reads | `category`, `taxable_base_paise` (post-discount, pre-GST), `net_paise`, `candidates` jsonb (the D-8 contest record), `winner` jsonb. |
| `payment.received` payload | `{ receiptId, invoiceId, patientId, amountPaise }` — **no line detail**; the consumer reconstructs the base from the invoice (DD12). |
| `payment.refunded` payload | `{ voucherId, patientId, amountPaise, method }` — **no invoice**; `refund_vouchers` carries `invoiceId` and `creditNoteId`, reachable through billing's index. |
| append-only precedent | `drizzle/0012_billing_immutability.sql` — one `billing_forbid_mutation()` plpgsql function raising on `BEFORE UPDATE OR DELETE`, six triggers. Locking an immutable row is legal and billing already does it (`lockInvoice`, `.for("update")`). |
| the E-32 queue hook | ALREADY SHIPPED and unused: `opd_queue_entries.perk` boolean + `opd_config.perkEveryNth`; `queue-engine.ts:30` says in as many words *"Plan 07 never sets perk; Plan 09 does."* No OPD write path sets it today. |
| the 11h search seam | `ModuleManifest.search?: SearchProvider[]`, collected by `kernel/search/registry.ts`; `permission` is DECLARED so the fan-out decides before it runs; `assertProvidersDeclared` refuses an undeclared permission. |
| the DD8 rate limiter | `kernel/search/rate-limit.ts` — `checkSearchRate(db, actor, {limit, windowSec, now})`, counting `search_audit` over `(actor_id, at)`. Refusals are an EVENT, never an audit row (the self-reinforcement trap). |
| Devanagari | `kernel/search/normalize.ts` — `transliterateDevanagari` + `normalizeForSearch`, paired with the `0021` trigram index expression. **F7 stands: `\b` is ASCII-only.** |
| merge semantics | `resolvePatientId` follows the merge chain (5 hops max); `registration.ts:364` — **"merge never rewrites other modules' rows (§6)"**. R11 is therefore a READ-TIME resolution, not a re-link (DD11). |
| config | `loadConfig(env = process.env)`; every key added since Plan 10 is DEFAULTED because the schema is parsed through the whole environment by every caller (the B1 scar). `RETENTION_ENABLED` is the shape to copy for a boolean: `z.enum(["true","false"])`, never `z.coerce.boolean()`. |
| F1, live | `apps/core/.env` exists here and never in CI. **A test that calls bare `loadConfig()` passes on this host and fails in CI forever.** T1 ships the lint rule. |
| module isolation | `eslint.config.mjs` `no-restricted-imports` — a module may import another module's `index` and nothing deeper. |
| baseline suite | measured this session by detached `pnpm verify`; the number is recorded in CLOSE, not here, because CLOSE is the section that owns it (v3 §1's fact rule). |

---

## 3. Spike — questions written before, answers measured in place (v3 §1.2)

**OUTCOME, recorded at the top because it is the point of the section: the spike RAN 2026-08-25 and
it changed the plan.** Q1 resolved a conditional Assertion Book row to *struck* and added two
migration constraints. Q3 confirmed DD2 and found a silent precedence trap that became Book row B7.
**Q4 REFUTED half of DD12 and found a third money-carrying event DD7 had not subscribed to — DD12 is
rewritten, DD6 and DD7 amended, and DD19 exists only because of it.** Q6 confirmed DD10 and told T4
that the obvious contention-test shape does not discriminate. Four questions, ~188k subagent tokens,
one agent, one throwaway branch, no migration generated. Two of them refuted something.

EXECUTE-METHOD §1: build the riskiest 10% for real, throw the code away, write the plan against
measured behaviour. Four questions. **Q2 and Q5 were answered from this session by reading the
tree (11d's Question-B precedent — the cheapest honest way); Q1, Q3, Q4 and Q6 need something
built, and go to one throwaway-branch spike agent.**

**A hard constraint on the spike, because AGENT-RULES §6 makes it irreversible:** the spike
**generates no migration**. Every schema question is answered with raw SQL against a scratch
database the agent creates with an obviously-owned name and drops in the same task (rule 7's one
exception). A spike that runs `db:generate` mutates every per-worker database and `git checkout`
does not undo it — that is §2.20, and it cost 934k tokens once already.

### Q1 — Can `external_rmp` be made un-payable at the SCHEMA level, by composite FK, in this Postgres?
**Why it is the first question:** C-1 says "un-payable at the schema level (no payout path), not by
convention", and the whole of DD4 rests on the answer. The proposed mechanism is a UNIQUE index on
`counterparties (id, payee_class)`, a denormalised `payee_class` on the payable ledger row, a
composite FK `(counterparty_id, payee_class) REFERENCES counterparties (id, payee_class)`, and a
`CHECK (payee_class IN ('channel_partner','staff_internal'))` on the ledger.
**Measure:** create the two tables in a scratch DB by hand; insert an `external_rmp` counterparty;
attempt a payable row against it **four ways** — honest insert, insert with a forged `payee_class`,
`UPDATE` of a good row's `counterparty_id` to the RMP, and `UPDATE` of the counterparty's own class
to `external_rmp` after a good payable row exists. Report which of the four Postgres refuses and
with what error. **The fourth is the one that decides the design**: if updating the parent's class
is allowed while a payable child points at it, the composite FK is not enough on its own and the
counterparty table needs its own class-change guard.
**Answer — MEASURED 2026-08-25, and the condition resolves NEGATIVE.** All four probes were
refused by Postgres. Probe 1 by the CHECK; probes 2, 3 and **4** by the composite FK. Probe 4 is the
decider and it refused from the PARENT side — `update or delete on table "counterparties" violates
foreign key constraint … Key (id, payee_class)=(…, channel_partner) is still referenced from table
"commission_accruals"` — because the FK's default `ON UPDATE NO ACTION` is checked in both
directions. **T1 therefore needs NO `BEFORE UPDATE` trigger on `counterparties`, and Assertion Book
row A3 is struck as not-applicable with this measurement as its reason.** Four bypass attempts were
also closed by execution: delete-then-reinsert in one transaction, a receivable-only child, a
`DEFERRABLE INITIALLY DEFERRED` FK (which refuses at COMMIT), and laundering through `direction`.

Two findings the migration author must carry, both measured:

- **`ON UPDATE CASCADE` on this FK would be a live hazard.** Against a parallel table pair it still
  refused — *but only because the child's CHECK re-fired on the cascaded write*; the FK itself was
  satisfied. A future ledger table carrying the composite FK **without** the CHECK would be silently
  relabelled `external_rmp` by a cascade. **The FK ships with the default `NO ACTION`, and the
  migration says so in a comment.**
- **The composite FK freezes a counterparty's class while ANY accrual row exists — receivable rows
  included.** Stricter than DD4's prose implied, and almost certainly right, but it means
  *reclassify a counterparty* is not an operation this system has. **O-7's `terminated` path must
  therefore never be implemented as a class change** — it is `counterparties.status`, a different
  column, which is what O-7 already says.

Constraint mutants, run inside `BEGIN … ROLLBACK`: dropping the CHECK let probe 1 insert
(`INSERT 0 1`, row reads `external_rmp | payable`); dropping the composite FK let probes 2 and 4
succeed. **Each named constraint is individually load-bearing for exactly one probe.**

### Q2 — What is this repo's append-only mechanism, and can I reuse it verbatim?
**Answered from the tree, 2026-08-25.** Yes. `drizzle/0012_billing_immutability.sql` defines
`billing_forbid_mutation()` — a plpgsql function that unconditionally raises
`'billing_immutable: % rows are append-only (% refused)'` — attached by six `BEFORE UPDATE OR
DELETE ... FOR EACH ROW` triggers. Two consequences carried into DD5: (a) Plan 09 defines its own
function rather than attaching billing's, because the message names the wrong module and a shared
function makes one plan's migration able to change another's error text; (b) **locking an immutable
row is legal** — `receipts.ts:178` says so and `lockInvoice` does it — so DD10's `FOR UPDATE`
serializer and the append-only trigger are not in tension.

### Q3 — Can billing compose extra `AdjustmentSource`s onto a `PricingContext` without touching `modules/tariff`?
**Why:** DD2 claims the whole integration is `{...ctx, sources: [...ctx.sources, a, b]}` at the
billing layer, and if that claim is false, this phase has to amend a frozen money module and the
plan changes shape.
**Measure:** on the throwaway branch, write a scratch spec that builds a real `PricingContext` via
`loadPricingContext`, appends two trivial sources built by factories closing over a plain value,
prices two lines through `priceInvoiceLines`, and asserts (i) both appended sources appear in
`candidates`, (ii) the winner is the largest, (iii) an exact tie between an appended source and
`standingRuleSource` breaks toward the source EARLIER in the array, and (iv) `git status` shows no
file under `modules/tariff/` changed. Report the tie-break direction as OBSERVED, not as read.
**Answer — MEASURED 2026-08-25. DD2 is CONFIRMED by execution.** A scratch spec built a real
context via `loadPricingContext`, appended two factory-built sources closing over a plain value, and
priced two lines: 2 suites / 2 tests passed. (i) both appended sources appeared in `candidates` —
`["rule","manual"]` became `["rule","manual","membership","coupon"]`; (ii) the largest won, and the
taxable line's **GST was computed on the post-discount base**, so an appended source flows through
the whole engine rather than only the contest; (iii) **the tie-break direction was OBSERVED, not
read** — with three candidates at exactly 5 000 paise the winner was the source at index 0, and with
the rule leg removed it was the source at index 2; (iv) `git status --porcelain`, `git diff --stat`
and `find -newermt` over `apps/core/src/modules/tariff` were **all empty**. The tie-break mutant DIED
on both legs (`Expected: "rule" / Received: "coupon"`, and `Expected: "membership" / Received:
"coupon"`).

**One trap the spike found that DD2's prose did not carry, and T2 must.** `runContest` builds its
precedence map as `ctx.sources.forEach((s, i) => order.set(s.key, i))` and then looks the candidate
up by **`candidate.sourceKey`**, falling back to `Number.MAX_SAFE_INTEGER`. Two consequences: two
appended sources sharing a `key` string **collapse into one precedence slot**, and a candidate whose
`sourceKey` does not equal its own source's `key` **sorts silently LAST on every tie**. Neither
fails loudly. `membershipSource` and `couponSource` must emit `sourceKey === key`, and T2 carries an
assertion that pins it (Book row B7).

### Q4 — What can an accrual consumer actually reconstruct from `payment.received`, for a PARTIAL payment on a mixed invoice?
**Why:** the base is defined once (DD12) and three plausible wrong bases become mutants. Before
writing that definition I need to know what is reachable: `payment.received` carries only
`{receiptId, invoiceId, patientId, amountPaise}`, and an invoice can be paid in parts by several
receipts (`allocateReceipt` appends its own `payment.received` per apply).
**Measure:** on the throwaway branch, issue one invoice with three lines in two different service
categories, pay it in two parts through the shipped billing API, and dump every
`payment.received` row with its payload. Then answer, with the rows quoted: does each event's
`amountPaise` name the increment or the running total? Is `invoices.net_payable_paise` the right
denominator for scaling a part-payment onto the eligible pre-GST base? And does a credit note
issued between the two payments change that denominator?
**Answer — MEASURED 2026-08-25. Half of DD12 is confirmed; the other half is REFUTED, and DD12 is
rewritten below because of it.**

**Confirmed — `amountPaise` is an INCREMENT.** A three-line, two-category invoice paid in two parts
emitted `[60000, 41000]`; a running total would have read `[60000, 101000]`. `allocateReceipt`
writes `amountPaise: input.amountPaise` per apply.

**Confirmed — §170 rounding does not distort the denominator.** On a fixture with a `-35p` rounding,
`Σ payment.received` equalled `net_payable_paise` exactly at full settlement, so the rounding cancels.

**REFUTED — `invoices.net_payable_paise` is the wrong denominator, and `invoice_lines.taxable_base_paise`
is an equally stale numerator, the moment a credit note or an allocation reversal exists.** On a
fully SETTLED invoice that carried a credit note the run measured `Σ amountPaise = 101 000` against
`net_payable_paise = 151 000`, and DD12's formula produced a base of **63 543** where the economically
correct answer is **45 000**. The invoice row never moved (`151000` before the credit note and
`151000` after — `invoices` is immutable under `0012` and settlement is derived), and **all three
line rows were byte-identical after the credit note**, so a credited eligible line still contributed
its full base. Numerator and denominator were both pre-credit while the money was post-credit.
**The invariant is `Σ payment.received.amountPaise ≤ invoices.net_payable_paise`, with equality if
and only if no credit note and no allocation reversal touched the invoice.** DD12 is rewritten.

**A THIRD event carries collected money off an invoice, and DD7 did not subscribe to it.**
`reverseAllocation` and `markEnteredInError` both emit **`allocation.reversed`**
(`{allocationId, receiptId, invoiceId, amountPaise, reason}`) and **neither emits
`payment.refunded`**. Measured: pay in full, then reverse — `payment.received 100000`, then
`allocation.reversed 100000`, settlement back to `unpaid`. A consumer subscribed to DD7's original
two names would have accrued and never reversed. **`credit_note.issued`
(`{creditNoteId, creditNoteNo, invoiceId, kind, netPaise}`) is invoice-scoped too**, and is the hook
DD9's release/restore needs. Both are added to DD7's declared set.

**A fixture trap, cheap to hit and stated nowhere:** `issueCreditNote({ lines: [{ invoiceLineId }] })`
takes the **stored `invoice_lines.id`**, not the caller's draft `lineId`; passing the draft id fails
`BillingError: line … is not on invoice …`. T4's and T6's fixtures read the stored ids back.

### Q5 — What is the "void" of an invoice in this system, and what does releasing a coupon redemption have to hook onto?
**Answered from the tree, 2026-08-25.** There is no void. Two mechanisms exist and they are
different: `markEnteredInError` (`receipts.ts`) writes a separate `entered_in_error` document row
and reverses that receipt's live allocations in the same transaction — money leaves the live set
without any row being edited — and `issueCreditNote` (kinds `refund | clearance_discount |
correction`) is *"the ONLY way an issued invoice's receivable shrinks"*. Both are append-shaped,
which is what O-4's release mechanism has to be too. Carried into **DD9**.

### Q6 — Does a `SELECT … FOR UPDATE` on a parent counter row actually serialise two concurrent consumes in this harness?
**Why:** C3 (last-unit race) and K1 (double redemption) are the two concurrency claims this phase
makes, and rule 21 forbids predicting a lock's behaviour. Plan 06.2 shipped a raw-pg lock-holding
contention pattern (`modules/tariff/versions.contention.test.ts`) — the question is whether it
transplants.
**Measure:** on the throwaway branch, reproduce the pattern against two scratch tables (a parent
with a granted quantity and an append-only movement child): two raw `pg` clients, both `BEGIN`,
both `SELECT … FOR UPDATE` the same parent, both compute remaining and insert. Report whether the
second BLOCKS (and for how long), what it computes after the first commits, and **what happens
with the `FOR UPDATE` removed** — the negative control that proves the lock is load-bearing rather
than decorative. Also report whether `pgrep -af jest` showed any other suite running (rule 20, and
read the matched LINES, not the count — §2.53).
**Answer — MEASURED 2026-08-25. DD10 is CONFIRMED, with a negative control that discriminates
20/20.** Two raw `pg` clients against a scratch counter with one unit left. Under a forced
interleave, B's `SELECT … FOR UPDATE` **blocked for the full 605 ms and released within 0 ms of A's
COMMIT**; with `FOR UPDATE` removed it returned in 2 ms. Under a natural race the window opens on its
own in READ COMMITTED — **over-consumption in 0/20 trials with the lock and 20/20 without it**
(single-run detail: `A: remainingSeen=1 inserted=true · B: remainingSeen=1 inserted=true ·
remaining_after=-1`). Observed, not engineered.

**A warning about the test shape T4 must write, and it is §2.21/§3.21's class recurring.** The forced
interleave alone **does not discriminate the OUTCOME**: both runs ended `remaining_after=0` with one
movement row, because the forced ordering serialises the compute step anyway. A contention test that
asserted only "one movement row" under that interleave **would pass against a lock-less
implementation** — which is `versions.contention.test.ts`'s own recorded lesson recurring. **The
block/no-block observation is the discriminating half**, and T4's test must assert it.

**DD10's belt was measured without its braces.** With the lock removed and the partial unique index
live, the index fired **10/10** (`ERROR 23505 … duplicate key value violates unique constraint
"coupon_redemptions_single_use_uq"`) and the double redemption never landed; with both present, the
refusal was a clean typed one 10/10 and the index never fired. **The lock's job is to turn a raw
23505 into a clean refusal; the index's job is that the second redemption never lands.** Both of
DD10's mutants discriminate.

---

## 4. The rulings register — O-1…O-9

Taken **this session, 2026-08-25, under the owner's delegation in the execution prompt**: *"for
O-1..O-9 in the brainstorm §6, take the brainstorm's recommended/default readings as session-taken
rulings under this delegation and record each one in the phase doc with its reason."* Where the
brainstorm carried a default, it is taken and named as such. Where it carried only a question
(O-3, O-4), the ruling is this session's and the reason is written out at length, because a
delegation is not a licence to decide quietly. **O-8 is excepted by the prompt in as many words and
is NOT taken.**

**O-1 — grace-honor at the counter: allowed with approval.** *(brainstorm default, taken)*
Default is **refuse-with-event**; a named grace-honor path exists behind a new approval type
(`membership_grace_honor`, approver `billing_manager`, `actFirstAllowed: false`) and emits
`instrument.grace_honored`. **Reason:** a card the book does not know is either partner feed lag —
which the partner book names as a routine occurrence — or fraud, and the counter cannot tell them
apart. Refusing outright makes the system the enemy of a member who paid; honouring silently makes
the ledger wrong in a way nobody can find later. An approval makes it rare, attributable and
reversible. **One consequence, and it is the load-bearing half:** a grace-honored instance is
created with `origin = 'grace'` and **accrues nothing** until a real book row arrives and matches
it, because there is no partner sale reference to attribute to. That is C-17's rule (verify before
accrual eligibility) applied to the one case that most invites skipping it.

**O-2 — validity is evaluated at the money moment; no episode pin in Phase 1.** *(brainstorm
default, taken and narrowed)*
Percentage benefits are evaluated at **invoice issue**; entitlement counters at **consumption**;
a bundle's own validity governs its counters, independently of any membership validity.
**Reason:** `loadPricingContext(db, {at: now})` already pins the tariff at invoice time, and
billing in Phase 1 has no episode concept at all — IPD is a later phase. Inventing an episode pin
now would create a second time authority inside the money path with no consumer to test it against,
which is how a dormant defect gets armed two plans later (§2.86's class). The IPD phase inherits
the question with this reason attached; it is in §7.

**O-3 — mid-year covered-member add: free, within cap, to the parent instrument's existing
expiry.** *(no brainstorm default — this session's ruling)*
**Reason, three parts.** (a) Sales lanes are config-OFF, so in Phase 1 there is no price to
prorate; a proration formula would ship with no caller and no test that could distinguish it from
a wrong one — §2.49's vacuous-assertion trap, bought in advance. (b) The family cap already exists
as the control, and an over-cap add refuses through the same path as R6/I7. (c) A newborn added
mid-year is the sympathetic case that makes a health card worth having at a trust hospital, and
free-to-existing-expiry is the reading a member would call fair without being told the rule.
Revisit in Phase 2 if a partner's real terms price it — the schema does not preclude either shape.

**O-4 — a coupon on a corrected invoice is RELEASED, not burned; a partial credit note does not
release it.** *(no brainstorm default — this session's ruling)*
**Reason.** The instrument model's whole spine is that a consumption is reversible by a negating
row (C1 for counters). A coupon redemption that survived the cancellation of the very sale it was
consumed against would be the one asymmetry in the model, and it punishes the member for the
hospital's own correction. The fraud loop it invites (redeem → cancel → redeem) is bounded by what
already exists: `markEnteredInError` and a `correction` credit note both require authority and both
leave audit; the release itself is an event (`coupon.redemption_released`). **The narrowing
matters:** release happens only on `markEnteredInError` of the invoice's receipt or a
`correction`-kind credit note for the invoice's full value — a partial refund releases nothing,
because the sale the coupon was consumed against really did happen.

**O-5 — over-cap covered members at import: honour to cap, flag loudly, never quarantine the
row.** *(brainstorm default I7, taken)*
The instance is created, members are honoured up to the plan cap in the file's own row order, and
the overflow is recorded on the instance with its provenance and surfaced in the reconcile queue.
**Reason:** the member paid; the overflow is the partner's data error. Quarantining the whole row
makes a paying family invisible at the counter, which converts a partner's clerical mistake into
the hospital's refusal. Loud, not silent — and the deterministic order is stated so two imports of
the same drop honour the same people.

**O-6 — the volume kicker is keyed on the ACTIVATION instant, never on the sale date; recompute is
an append-only adjustment, and a settled quarter is closed.** *(brainstorm default P3, taken and
completed)*
**Reason:** keying on activation is what makes book-stuffing before a threshold cut-off
unprofitable by construction rather than by detection — the dual activation trigger is already
the definition, so the kicker simply counts activated instruments. Retroactivity is real (the
agreement shape allows a threshold to apply to a whole period), so recompute exists, but it lands
as a NEW adjustment accrual row naming the period it corrects, never as an edit — that is DD5.
A period whose partner statement has been settled is closed to recompute; re-opening it is an
owner action, evented.

**O-7 — partner suspension: honouring continues, accrual freezes into `escrowed`.** *(brainstorm
default P2, taken)*
`counterparties.status ∈ active | suspended | terminated`. **Suspended:** recognition and honouring
are untouched — **members are innocent** — and every accrual that would be written is written
instead with `state = 'escrowed'`; no payable total includes an escrowed row. Release or write-off
is an owner action and is evented. **Terminated:** new accruals stop at the term date; honouring
continues to each instrument's own expiry (the member-protection clause the agreement shape
carries); receivables stay collectible. **Reason for writing the row rather than skipping it:** the
replay property is only true if the event's consequence is recorded somewhere. A skipped accrual is
indistinguishable from an event that never arrived; an escrowed row is a decision with a date on it.

**O-8 — the CA/counsel register: NOT RULED. Stays the owner's.** *(excepted from the delegation by
the prompt)*
Every lane gated by the register's five items ships structurally OFF, exactly like the sales lanes,
with the flip documented in the runbook (T8). The mapping from register item to flag is stated once,
in **DD14**, and nowhere else.

**O-9 — the synthetic-book substitution stands for planning, fixtures and seeds — and is
STRENGTHENED.** *(brainstorm default, taken, with the loophole closed)*
The brainstorm offered the context file's sample rows "for fixtures/seeds". **They may not be
used.** The owner's standing instruction is that neither context file may be *quoted into tracked
files*, and a fixture is a tracked file. The ruling is therefore: this phase **invents its own
in-repo synthetic corpus, class for class** — every dirt class the partner book names gets a
fixture row, written fresh here, with invented codes and invented people. No row, code, rate or
name is transcribed. **Reason:** it is the only reading under which both instructions are
simultaneously true, and it costs nothing — the fixtures are testing the CLASS (duplicate key,
mixed script, over-cap family, inverted validity range, shared phone, re-sent file), and a class
does not care which invented name carries it. DD3 makes it checkable.

---

## 5. Design decisions

### DD1 — TWO modules, not one, and the import direction is fixed by the accrual consumer (RULED)

`modules/membership` owns instruments: plans, instances, covered members, entitlement counters,
coupons, recognition, the holder-book import, and the two `AdjustmentSource`s.
`modules/partners` owns counterparties: partners, versioned agreements, the accrual ledger,
receivable expectations, statements, reconciliation and the channel P&L read model.

**Why not one module.** The accrual consumer must read an invoice's lines to compute its base
(Q4), so `partners → billing`. The pricing integration must read resolved instruments, so
`billing → membership`. Put both halves in one module and those two facts become an import cycle
through `billing/index.ts` — and the module-isolation lint rule permits index-to-index imports, so
**nothing in the toolchain would refuse it**; it would surface as a runtime `undefined` in whichever
module happened to initialise second, in the money path, under a green suite. The split makes the
graph acyclic by construction: `billing → membership`, `partners → billing`, `partners →
membership`. It is written down here because the cycle is invisible until T6, six tasks after the
decision that would have caused it.

The two modules share one migration and one schema commit (T1) but no source file.

### DD2 — Membership and coupon compose as `AdjustmentSource`s AT THE BILLING LAYER; `modules/tariff` is byte-untouched (RULED)

`AdjustmentSource.propose` is **pure and synchronous**. Benefits therefore cannot be looked up
inside it, and the naive integration — teaching `loadPricingContext` about memberships — would
amend a frozen money module.

The shape that avoids it entirely: **source factories**.

```
membershipSource(resolved: ResolvedInstruments): AdjustmentSource
couponSource(resolved: ResolvedInstruments): AdjustmentSource
```

Each returns an `AdjustmentSource` closing over a plain value that `resolveInstruments(db, …)`
produced BEFORE the transaction, in exactly the place `loadPricingContext` already runs outside
one. Billing then composes:

```
const base = await loadPricingContext(db, { at: now, tags });
const ctx  = { ...base, sources: [...base.sources, membershipSource(r), couponSource(r)] };
```

**Four properties this buys, and they are the reason it is the ruling.** (1) `modules/tariff`
is not touched at all — not `index.ts`, not `context.ts`, not `fixture-schema.ts` — so the freeze
can be the whole directory rather than one file, and the frozen-path audit at close becomes a
one-line grep instead of a judgement. (2) `propose` stays pure, so the contest stays deterministic
and golden-testable with no database. (3) The contest's own machinery does all the work the plan
needs: best-single-benefit, rejected candidates recorded, tie-break by array order — R7 and R8 are
not new code, they are new fixtures. (4) Every existing tariff test keeps passing untouched,
because from the engine's point of view nothing changed.

**Source order is `[rule, manual, membership, coupon]`, and the order is a ruling, not an
accident.** `runContest` sorts by amount first; order decides EXACT ties only. On a tie, a standing
hospital rule (charity, scheme) should beat a commercial instrument, and a membership — a paid,
durable relationship — should beat a one-shot coupon. That is explainable to a member at a counter,
which is the test a tie-break rule has to pass.

**Plan 09 ships its own golden harness** (`modules/membership/golden/`), importing
`priceInvoiceLines`, `standingRuleSource`, `manualDiscountSource` and the types from `../tariff`'s
frozen index — all already exported (§2). It does not extend Plan 06's `fixture-schema.ts`, whose
discriminated union and pinned fixture manifest would both have to change.

### DD3 — Every catalog is DATA; the repo ships no partner, plan, coupon code or rate (RULED)

Plans, coupon definitions, partners and agreement terms are **configuration rows**, seeded at
commissioning from files the owner supplies. Nothing in `apps/` contains a plan code, a partner
code, a commission rate, a card price or a card number.

**The check is structural, and it is structural on purpose.** A grep-for-forbidden-values guard
would require committing the forbidden values, which is precisely what the owner's instruction
forbids. So the enforced property is the one that can be stated without them: **a freshly migrated
database has empty catalogs.** T1 ships `catalogs-empty.test.ts` — boot against a fresh test
database, assert every catalog reader returns `[]`, and assert no seed script under
`apps/core/scripts/` writes to any of the six catalog tables. A hard-coded catalog cannot survive
that test, and the test names no secret.

Fixtures invent their own people and codes (O-9). The commissioning path — import files and config
rows — is T5 and T8.

### DD4 — `external_rmp` is un-payable by COMPOSITE FOREIGN KEY, not by a status flag (RULED)

C-1 requires "un-payable at the schema level (no payout path), not by convention". The mechanism:

- `counterparties (id, payee_class)` carries a **UNIQUE index on the pair** — redundant against the
  primary key by design, and it exists solely so a child can point at the pair.
- The ledger's payable rows carry a denormalised `payee_class` with a **composite FK**
  `(counterparty_id, payee_class) REFERENCES counterparties (id, payee_class)` — so the class on
  the ledger row cannot disagree with the counterparty's own.
- Plus `CHECK (direction <> 'payable' OR payee_class IN ('channel_partner','staff_internal'))`.

Together: a payable row naming an `external_rmp` counterparty cannot be inserted, cannot be forged
by writing a different class into the child, and cannot be created by re-pointing an existing row.
**Q1's fourth probe RESOLVED NEGATIVE, measured 2026-08-25 (§3 Q1): no fourth clause is needed.**
Postgres refuses the parent-side class change from the FK itself, because `ON UPDATE NO ACTION` is
checked in both directions. **T1 adds no trigger and Book row A3 is struck.** Two conditions come
with it: the FK ships with the **default `NO ACTION`** and the migration says so in a comment (with
`ON UPDATE CASCADE` the FK is satisfied and only a child CHECK saves it — so any later ledger table
without that CHECK would be silently relabelled), and **a counterparty's class is frozen while ANY
accrual row exists, receivable rows included** — so O-7's `terminated` path is `counterparties.status`
and must never be a class change.

An external-RMP counterparty may still EXIST — attribution and reporting need it. What cannot exist
is money owed to one. The `payout.class_blocked` event stays for the attempt path.

### DD5 — The accrual ledger is append-only by trigger; reversal, escrow and correction are all ROWS (RULED)

`partner_ledger_forbid_mutation()` mirrors `billing_forbid_mutation()` in shape and raises with this
module's own message (Q2: a shared function would let one plan's migration change another's error
text). Attached `BEFORE UPDATE OR DELETE FOR EACH ROW` to `commission_accruals`,
`entitlement_movements` and `coupon_redemptions`.

Consequences, each of which is a design commitment rather than a note:
- **The ledger is a stream of SIGNED DELTAS** (DD12): what is payable for an invoice is their sum.
  A reversal is a negative row naming its own basis event. "Total reversal never exceeds total
  accrual" is structural rather than checked — `target ≥ 0` and `Σ deltas = target` — which is
  strictly better than the writer-enforced cap the first draft specified.
- **Escrow is a state chosen at INSERT** (O-7), never a later update. A suspension therefore
  changes what the consumer writes next, not what it wrote before.
- A statement's late correction (V3) is an **adjustment row** naming the period it corrects.
- The kicker recompute (O-6) is the same shape.
- Lifecycle state that genuinely does move — a receivable walking `expected → matched → disputed →
  written_off` — lives on `receivable_expectations`, which is **not** append-only and is
  deliberately a different table from the ledger. The ledger records money; the expectation
  records a claim. Mixing them is what makes an append-only ledger need an UPDATE.

### DD6 — Agreements are versioned and effective-dated (the tariff-version pattern), and the rate is SNAPSHOTTED onto the accrual row (RULED)

`partner_agreements (counterparty_id, version_no, effective_from, effective_to, terms jsonb,
status)` — deliberately the same shape as `tariff_versions`, because the same problem (a priced
decision must be reproducible against the terms that were live when it was made) already has a
solved shape in this codebase.

Every accrual row carries `agreement_id` **and** `rate_snapshot` jsonb — the resolved numbers, not
a pointer.

**The version is resolved at the INVOICE's issue instant, not at each payment's** — and that is a
consequence of DD12's rewrite rather than a free choice. Under delta-to-target, a later payment
recomputes the whole invoice's target; if it recomputed it at a later rate, an amendment would
retroactively rewrite every earlier accrual for that invoice, which is precisely what this section
exists to forbid. Pinning at issue makes each invoice single-versioned and gives A6 a definite
answer: **the terms live when the hospital billed are the terms that govern the commission on that
bill.** It is the same pinning discipline `loadPricingContext` already applies to the tariff, and
O-2's reasoning verbatim.

**The dispatcher still hands the consumer `occurredAt` — the event's own instant, never the worker's
clock** (`kernel/events/subscriptions.ts`, Plan 10 D5). That is what orders the stream and what the
kicker counts by; it is no longer what selects the rate.

### DD7 — The accrual consumer registers ALWAYS and advances its cursor ALWAYS; the CA-gated flag decides only whether it WRITES (RULED)

This is the phase's most consequential wiring decision and it inverts the obvious one.

The obvious implementation of "the lane is config-OFF" is to register the subscription only when
the flag is on. That is **check-on-execute wearing a manifest's clothes**, and the roadmap forbids
it in as many words. Worse, it is silently lossy: a subscription that was never registered has no
cursor, so flipping the flag later starts from `now` and every event before the flip is gone.

So: `partnersManifest.subscriptions` declares its events unconditionally, `workerConsumers(db)`
carries the handler unconditionally, and the handler reads the flag and — when it is off —
**advances without writing**.

**The declared set is FOUR names, not two, and the spike is why.** `payment.received` ·
`payment.refunded` · **`allocation.reversed`** · **`credit_note.issued`**. Money leaves an invoice
through `allocation.reversed` (emitted by both `reverseAllocation` and `markEnteredInError`, and
neither of those emits a refund event) and a credit note changes what is settleable — measured in
§3 Q4. Under DD12's delta-to-target the handler body does not branch on which of the four arrived:
every one of them re-reads the invoice and appends whatever delta the new state implies. That is the
whole reason the rewrite was worth taking — **four subscriptions, one code path.** Turning the lane on is then two steps
that are both tested: flip the flag, run the **replay job**, and the ledger fills in from event
history. That is the replay property the roadmap promises, made load-bearing instead of asserted.

Three things follow, and all three are Assertion Book rows: with the flag off no accrual row exists
(the flag is load-bearing); with the flag off the cursor still advances (nothing is stuck); after
flag-on + replay the ledger equals what live processing would have produced (the replay is
faithful). **The manifest and `workerConsumers` are ONE edit** — `buildSubscriptionBus` turns a
declared subscription with no matching handler into a boot error, and both halves living in one
task is the Plan 10 D13 lesson.

### DD8 — Recognition ships and deploys before the counter is armed, and the ordering is STRUCTURAL (RULED)

The standing ruling — counter discounts cannot backfill — orders the tasks: **T3 (recognition)
before T4 (billing integration)**. Two mechanisms make it more than a preference:

1. The billing integration calls `resolveInstruments()` from the membership index. Without T3 there
   is nothing to call, so T4 cannot ship early by accident.
2. `MEMBER_BENEFITS_ENABLED` (DD14) gates the composition in `priceDraft`. The runbook (T8) orders
   the flips: recognition deployed → import run → reconcile queue cleared → benefits armed. An
   ordered flip list is the operable form of the ruling; a prose sentence is not.

### DD9 — Coupon release and entitlement restore hook onto the two append-shaped mechanisms billing already has (RULED)

Q5 measured that this system has no "void": it has `markEnteredInError` (a separate document row
plus in-transaction allocation reversal) and `issueCreditNote` (the only way a receivable shrinks).
O-4 and C1/C2 therefore hook onto those two and nothing else:

- **Restore an entitlement counter** on any credit note that reverses the line that consumed it —
  proportional to the reversed line, never to the invoice (C2).
- **Release a coupon redemption** only on `markEnteredInError` of the invoice's receipt, or a
  full-value `correction` credit note (O-4's narrowing).
- **The hooks are named, measured (§3 Q4):** `credit_note.issued` carries
  `{creditNoteId, creditNoteNo, invoiceId, kind, netPaise}` and `allocation.reversed` carries
  `{allocationId, receiptId, invoiceId, amountPaise, reason}` — both invoice-scoped, both sufficient.
- **A fixture trap, stated so nobody rediscovers it:** `issueCreditNote({ lines: [{ invoiceLineId }] })`
  wants the **stored `invoice_lines.id`**, not the caller's draft `lineId`. Read the ids back.
- **C5 — restore after the counter's own validity has lapsed happens anyway, and is flagged.**
  Refusing would silently keep money the patient did not receive value for. The flag is what the
  reconcile queue shows.

### DD10 — Entitlement counters: an append-only movement log under a locked parent row (RULED)

`entitlement_counters` holds the grant (`granted_qty`, validity, state);
`entitlement_movements` holds every consume and restore as a signed row. Remaining is computed, not
stored.

**The serializer is `SELECT … FOR UPDATE` on the parent counter row, taken inside the invoice
transaction**, before remaining is computed. That is the Plan 06.2 lock discipline, and Q6 measures
that it transplants before a line is written. The same shape serialises coupon redemption: lock
`coupon_definitions`, count redemptions inside the lock.

**Confirmed by execution before a line was written (§3 Q6): 0/20 over-consumption with the lock,
20/20 without it.** And the spike returned a warning that changes the TEST rather than the code:
**a forced interleave alone does not discriminate the outcome** — both runs end with one movement
row, because the forced ordering serialises the compute step anyway, so a contention test asserting
only "one movement row" passes against a lock-less implementation. **The block/no-block observation
is the discriminating half**, and T4's contention test asserts it.

**Belt as well as braces for the single-use coupon:** a partial UNIQUE index on
`coupon_redemptions (coupon_id) WHERE single_use AND state = 'redeemed'`, with `single_use`
denormalised at insert. The lock is the mechanism; the index is what survives a future writer that
forgets the lock. **Both get mutants** — remove the lock, remove the index — because a belt that has
never been tested without its braces is a comment.

### DD11 — Patient merge is resolved at READ time; instruments are never re-linked (RULED)

`registration.ts` is explicit: *merge never rewrites other modules' rows (§6)*. R11 therefore
resolves through `resolvePatientId` at recognition time, the way Plan 07's encounters already do.

**The half that needs deciding is double benefit.** Two instruments that survive a merge and are
both valid produce two candidates in the contest — and best-single-benefit already refuses to stack
them, so percentage benefits are safe by the engine's own rule. **Entitlement counters are not**:
two cards' free consults are two separate counters and both would be consumable. The ruling:
counters are consumable per instrument, and the merge surfaces the duplicate in the reconcile queue
for a human. **Reason:** the alternative — silently voiding one of two things a patient paid for
because the hospital merged its own duplicate records — is a worse error than the one it prevents,
and it would be invisible to the person it happened to.

### DD12 — The accrual base is defined ONCE, here — CREDIT-AWARE, and appended as a DELTA TO TARGET (RULED, rewritten 2026-08-25 after the spike refuted the first version)

**What the spike refuted.** The first version scaled the eligible pre-GST base by
`amountPaise / invoices.net_payable_paise`. Measured, that produced 63 543 where 45 000 was correct,
because `invoices` is immutable and `invoice_lines` is immutable: a credit note moves neither, so
both numerator and denominator stayed pre-credit while the money was post-credit. And `payment.received`
plus `payment.refunded` are not the whole story — `allocation.reversed` carries collected money off
an invoice too, from two different callers, and emits no refund event.

**The rewrite fixes both by changing WHAT is appended.** The ledger stops recording "the commission
for this payment" and starts recording **the delta that brings this invoice's accrual to its correct
total.** For an invoice `I` under agreement version `A`:

```
liveBase(L)   = L.taxableBasePaise − creditedBasePaise(L)          per line, floored at 0
eligibleBase  = Σ liveBase(L)  for L.category ∈ A.eligibleCategories
settleable    = netPayablePaise − creditedPaise                     floored at 0
collected     = allocatedPaise − refundedPaise                      floored at 0
targetBase    = settleable === 0 ? 0 : divHalfUp(eligibleBase × collected, settleable)
target        = percentAmount(targetBase, A.rateBps)
delta         = target − Σ(rows already appended for (I, A, direction))
```

`divHalfUp` and `percentAmount` are Plan 06's, imported from the frozen tariff index — this phase
writes no rounding of its own. An invoice marked `entered_in_error` has `target = 0`, so everything
reverses.

**Five properties this buys, and each is why it is the ruling.**

1. **It is correct on the spike's own counter-example.** eligibleBase 45 000 · settleable 101 000 ·
   collected 101 000 → 45 000, against the old formula's 63 543.
2. **DD12's original property survives, now correctly conditioned:** with no credit note and no
   reversal, `collected = settleable = netPayable` and `targetBase` reduces exactly to
   `eligibleBase`. That is still the fixture that pins it.
3. **Reversal stops being separate arithmetic.** A refund, an `allocation.reversed`, a credit note
   and an entered-in-error mark all move `collected` or `settleable`, so all four produce a negative
   delta through the SAME line of code. There is no proportional-reversal formula left to get wrong,
   and "total reversal can never exceed total accrual" becomes structural rather than checked:
   `target ≥ 0` and `Σ deltas = target`.
4. **It is order-independent at rest.** Pay-then-credit and credit-then-pay converge to the same
   total, which is what makes replay (DD7) faithful rather than approximately faithful.
5. **It is still append-only.** Every row is a signed delta naming its basis event; nothing is ever
   updated. DD5 is unchanged in kind — "reversal rows negate, never delete" is now the only shape
   there is.

**The three wrong bases stay mutants**, and the rewrite adds a fourth: ignore `creditedPaise` and
`creditedBasePaise` — i.e. **ship the refuted first version** — which the spike's own fixture kills
at 63 543 vs 45 000.

**Concurrency.** Two different events for one invoice can be processed by two dispatch cycles at
once (the alerts consumer's docstring records that being observed), and a delta-to-target read
followed by an append is a read-modify-write. The serializer is DD10's shape reused: a
`commission_accrual_subjects` row unique on `(agreement_id, invoice_id, direction)`, upserted then
locked `FOR UPDATE`, with the sum and the append inside the lock. Idempotency on `basis_event_id`
stays as the second guard, exactly as DD10 keeps its index behind its lock.

### DD19 — ONE new billing export is the seam the accrual consumer reads through (RULED, from the spike)

DD12 needs an invoice's live money and its per-line credited base. Billing keeps
`creditedPaiseOf`, `allocatedPaiseOf` and `enteredInErrorDocIds` private, and `invoiceSettlement`
returns only `{state, outstandingPaise}` — from which `credited` and `allocated` cannot be
separated. The module-isolation lint means `partners` may read billing's `index` and nothing deeper,
so there are exactly two options: break the isolation rule, or add a reader.

**The reader.** `apps/core/src/modules/billing/accrual-view.ts` exports one function through
billing's index:

```
invoiceAccrualView(exec, invoiceId): {
  invoiceId, issuedAt, enteredInError,
  netPayablePaise, creditedPaise, allocatedPaise, refundedPaise,
  lines: { lineId, category, taxableBasePaise, creditedBasePaise }[]
} | null
```

**T4 ships it, T6 consumes it** — §2.47's resolution exactly: the earlier task ships the seam, the
later one fills it. It lives in billing because that is where the tables are, and it is the only new
cross-module surface this phase opens.

**§2.49 binds T4 here harder than anywhere else in this phase.** This is a seam with no caller until
T6, and "nothing calls it yet" plus an assertion about it is how a vacuous test is born. Its tests
therefore run against real invoices carrying a credit note on an eligible line, an allocation
reversal, and an entered-in-error mark — fixtures whose numbers **differ from each other**, so an
implementation that returned the pre-credit numbers fails them.

### DD13 — Attribution is single-partner at issuance; statements join on IDs, never fuzzily (RULED)

An outbound referral issues **one** attribution id, to one partner, at referral time — printed as
a code and a QR on the slip (the 11h barcode wedge reads it back). V6's both-partners-claim-one
referral is therefore not a conflict to resolve but a rule to state: **the partner whose id is on
the slip is the partner with the claim**, and a statement line quoting a different partner's id is
`disputed`.

A partner's own reference space is joined through an explicit mapping table
(`partner_ref_map`). **Fuzzy joins are forbidden** — V7 — because a fuzzy match that is wrong once
in a thousand rows produces a reconciliation nobody can audit and a dispute nobody can settle.

An expectation that is never confirmed expires after a configured number of days (V5) into
`written_off`, evented, and appears in the aging read model before it does.

### DD14 — Structural-OFF: five flags, all defaulted false, all two-string enums (RULED)

Added to `configSchema` in `kernel/config.ts`, every one **defaulted** (the B1 scar — this schema is
parsed through the whole environment by every caller, so nothing new may be required in any `.env`,
on the server or in CI) and every one spelled `z.enum(["true","false"]).default("false")`, never
`z.coerce.boolean()`, which reads the string `"false"` as true.

| flag | what it gates | gated by |
|---|---|---|
| `MEMBERSHIP_SALES_ENABLED` | selling an instrument at the hospital counter (the sale lane) | standing ruling: sales open next phase. **E-32 guardrails ship anyway.** |
| `MEMBER_BENEFITS_ENABLED` | composing the two `AdjustmentSource`s into `priceDraft` | DD8's ordered flip, not a legal gate |
| `COMMISSION_ACCRUAL_ENABLED` | whether the accrual consumer WRITES payable rows (DD7) | CA/counsel register items 2 and 3 — **O-8, owner** |
| `RECEIVABLE_COMMISSION_ENABLED` | expectation creation and statement matching | CA/counsel register item 2 — **O-8, owner** |
| `COUPON_ISSUANCE_ENABLED` | issuing new coupon codes (campaign creation) | CA/counsel register item 5, advertising rules — **O-8, owner** |

**What is ON and unflagged:** recognition, honouring an already-issued instrument, entitlement
consume/restore, redemption of an already-issued coupon, the holder-book import, the reconcile
queue, and the P&L read model (which reads whatever rows exist and therefore reads zeros while the
lanes are off). That set is exactly "the module goes live for recognition, accrual and testing"
minus the accrual writes the CA gate holds.

**Register item 4 — cooling-off refunds on partner-sold instruments — has no code lane in Phase 1**
because there is no sale lane to refund. It is recorded in §7 as the owner's, attached to the sale
lane it will gate when that opens. Saying so here is cheaper than a reader later concluding the
register was partially ignored.

### DD15 — Partner-facing output carries instrument ids and never patient identity (RULED)

The 11h independent review found a sealed patient reachable through a chip-scoped query that was
correct on its own — two correct halves, jointly blind (§2.89's class). This phase applies that
lesson at design time rather than at review time.

- Every export, statement-reconciliation view and partner-visible read model is built from
  **instrument ids, attribution ids and amounts**. No name, no UHID, no phone, no patient id.
- The rule is enforced by a test that walks the exported row SHAPE and refuses any field whose
  source is the patients table — the same discipline as the alerts consumer's "no alert column ever
  carries patient identity", which is mutant-enforced there and will be here.
- **The recognition surface must not become an enumeration oracle.** Card-code lookup goes through
  `checkSearchRate` — the DD8 limiter, reused, not reinvented — and a refusal is an EVENT, never an
  audit row, because writing refusals to the counted table makes every retry extend the block.
- Sealed and restricted patients are invisible to recognition-by-patient exactly as they are to
  search: through `visiblePatientIds()`, the helper 11h's remediation made the single gate, never
  a re-implementation.

### DD16 — The E-32 perk hook is FILLED, not built (RULED)

`opd_queue_entries.perk` and `opd_config.perkEveryNth` already exist and `queue-engine.ts` says in
its own comment that Plan 09 is what sets them. This phase writes `perk = true` on queue entry when
the patient holds a valid instrument whose plan config grants the queue perk, and does it **through
the OPD module's index**, never its tables.

E-32's guardrails ship with it regardless of the sales flag: no ER or bedside sale path exists at
all, disclosure is rendered at honouring time (T3), no counter screen shows a sales KPI, and the
cooling-off refund obligation is recorded as the owner's (§7). Guardrails that ship with a disabled
lane are the whole point of the structural-OFF pattern.

### DD17 — Every actor column in this phase is PLAIN TEXT, never an FK into `users` (RULED)

`coupon_redemptions.actor_id`, `entitlement_movements.actor_id`, `patient_match_queue.resolved_by`,
`holder_book_imports.imported_by`, `attribution_ids.issued_by` — all plain text, following
`events.actor_id`, `approvals`' actor columns, `retention_legal_holds.created_by` and
`schema/ops.ts`'s entire actor surface.

**Two reasons, and the second is the one that pays.** An actor may be a system or an agent, not only
a row in `users` — the actor fabric has been polymorphic since Plan 02. And by §3.35/§3.12, a table
with no FK pointing at `users` has **no claim on the users truncate statement**, so sixteen new
tables cost `truncateAll` exactly the edits their patient/invoice FKs actually require and not one
more. Plan 11h's `search_audit` and 11g's `auth_throttle` each recorded this reasoning in place; this
is the same ruling, taken once for the whole phase.

### DD18 — The role model for this phase: recognition to the desks that already work the counter, everything partner-facing to `NOT_YET_MODELLED` with its reason (RULED)

S9 forces the decision; this is it, and it deliberately mints as little authority as possible.

**Granted in `ROLE_MODEL`** — the permissions a counter cannot function without, to roles that
already hold the neighbouring capability: reading and recognising an instrument goes to the roles
that already issue invoices and register patients; requesting a grace-honor goes with them;
approving one belongs with the role that already approves every other billing exception.

**Entered in `NOT_YET_MODELLED`, each with its reason** — the catalog-management, partner,
agreement, ledger-read, statement-import, receivable-operation and channel-P&L permissions.
**Reason, and it is the tariff precedent word for word:** no role model for these is published
anywhere, the pilot's catalogs are seeded by script rather than maintained by a human at a route
(DD3), and **the lanes they guard ship structurally OFF pending O-8**. Granting them now would mint
authority nobody has asked for, on a trust hospital, for routes that refuse to do anything.

The register's own header is explicit that it is **not** an exceptions list — "a decision waiting to
be made rather than a door deliberately nailed shut" — and that is exactly the right reading here:
the day the owner rules O-8, these entries leave the list, the census fails, and the commit that
grants them has to say so. That is the mechanism working, not a gap.

---

## 6. Tasks

Eight tasks. Tier, Files list, acceptance criteria, commit message, and — for CRITICAL tasks —
Assertion Book rows inline (assertion · mutant · discriminating input), per v3 §1.4.

**Every Files list below is EXPLICIT — one full path per entry, no `+ tests`, no brace groups, no
globs except the two fixture directories, which are named as directories on purpose.** That is not
tidiness: §2.25 makes the brief's frozen-path block GENERATED from these lists, and §2.54 requires
the pipeline script's `files` arrays to equal them **both directions, per task**. A list a script
cannot be compared against mechanically is a list that will drift, and the drift silently forbids
what the plan requires.

The order is recognition-first (DD8), and the **T4/T5 boundary is where the phase splits** if the
stop-loss fires.

### 6.0 — The compile-time sweep, run 2026-08-25 BEFORE any brief was written

EXECUTE-METHOD §3's nine items, run mechanically against the tree at `d7a8981`. Seven findings,
all resolved into the document below in the same commit that carries the pipeline script.

- **Item 1 — paths resolve.** 87 path tokens extracted from §6 and resolved: **every modify-target
  EXISTS, every create-target is ABSENT.** Passed. It also produced **S1**.
- **S1 — the Files lists were not mechanically comparable.** The first draft wrote
  `` `{index,manifest,errors}.ts` + tests ``. Brace groups and "+ tests" cannot be diffed against a
  script's `files` array, which is exactly the reconciliation §2.54 says nothing performs.
  **Resolved:** every list below is explicit, and the pre-flight asserts equality both directions.
- **S2 — a forward reference the dependency order hid (§2.47).** T6 installs `partnersManifest`
  into the WORKER registry, and `kernel/modules/manifests.test.ts` pins BOTH registries and asserts
  their difference is deliberate — so T6 must edit a file only T1's list named. **Resolved the way
  §2.47 prescribes: the earlier task ships the seam, the later one fills it.** T1 creates
  `partnersManifest` with `subscriptions: []` and installs it **app-only**, recording in
  `manifests.test.ts` that partners is app-only until T6. T6 then makes the Plan-10-D13 edit —
  subscriptions, handler, worker install and census **in one commit** — and `manifests.test.ts`
  joins T6's Files list. There is now no window in which a declared subscription has no handler,
  which `buildSubscriptionBus` would turn into a boot error.
- **S3 — nobody owned the seed path (§2.71's class).** T3 creates an approval type; approval types
  reach a real deployment only through a `seed:*` script (`seed-roles.ts:278` says so in as many
  words). Without one, the type is registered in tests and nowhere else — every task correctly
  declines, and the deployed hospital has a grace-honor path that cannot be approved.
  **Resolved:** T3 owns `apps/core/scripts/seed-membership.ts` and its `package.json` entry.
- **S4 — the pipeline template named by the ledger DOES NOT EXIST on this host.** §2.51's rule is
  *stat it before you grep it*, and stat says
  `/root/.claude/routing.parked/skills/execute/SKILL.md`: **No such file or directory**; there is no
  `execute` skill under `/root/.claude/skills/` either. **An empty grep against a missing file reads
  identically to an empty grep against a present one**, so every "I checked the template" claim made
  since it vanished discharged nothing. **Resolved:** the live template is the committed pipeline
  scripts plus [`pipelines/README.md`](../pipelines/README.md); this phase compiles against
  `plan-11a-deployment.js`'s shape and the ledger's §2 header line is corrected in the same commit
  as this phase's script, per §2.7's own remedy.
- **S5 — `check:config-present` must NOT learn about this phase, and the reason has to be written
  down.** Plan 11g's deploy gate refuses a deployment whose config rows are missing. Plan 09's
  catalogs are **legitimately empty until commissioning** (DD3), so adding them to that gate would
  refuse every deploy from now until the owner's import files land — 11g's own third leg exists to
  prevent exactly that mistake. **Resolved:** recorded as an explicit non-goal in T8, with the
  reason, so the next reader does not "complete" the gate.
- **S6 — a conditional Assertion Book row would stall an agent (§3.3).** T1's row A3 is written
  "conditional on Q1's fourth probe". **Resolved by process, not by text:** the spike answers Q1
  before T1's brief is compiled, and A3 is marked live or dead **in place** before the pipeline is
  built. A brief never ships carrying the condition.
- **S8 — a second file no task named, and this one HALTS (§3.12 + §2.46's blind spot).**
  `apps/core/test/helpers/db.ts`'s `truncateAll` is hand-maintained, and the ledger's two
  transcribed rules are unforgiving: Postgres checks whether an FK constraint POINTS AT the table
  being truncated — **constraint existence, never row counts and never statement order** (§3.35) —
  and a new table that FKs into an existing group **must be named in that group's own statement**
  (§3.12). Plan 09's instrument tables FK into `patients`, `invoices` and `invoice_lines`, all of
  which live in one enormous statement. T1's Files list did not name that helper, so its very first
  `truncateAll` would have failed with *cannot truncate a table referenced in a foreign key
  constraint* — and the coder's only compliant move would have been to halt, because fixing it
  reaches outside its Files list (§2.72's shape exactly). **Resolved:** `apps/core/test/helpers/db.ts`
  joins T1's Files list, and DD17 rules the actor columns to plain text so the `users` statement
  needs no change at all.

- **S9 — a THIRD file no task named, and it fails the build by design (§2.65/§2.82 — walk the
  assert-on graph transitively).** `apps/core/test/seed-roles.test.ts` holds a **reachability
  invariant**: *every declared permission is held by a role, or named in `NOT_YET_MODELLED` with a
  reason* — and its own comment says it "fails the build the day a module adds a permission and
  forgets the role model, which is the failure mode that produced MAJOR 4 twice." It also pins
  `allPermissions()` at a fixed length in three separate assertions and pins a per-module permission
  census as an object literal. **T1 declares two manifests' worth of new permissions**, so all of
  that goes red the moment T1 commits — and neither `apps/core/scripts/seed-roles.ts` nor its test
  was in any Files list. This is not a mechanical fix either: it demands a decision about WHO holds
  each new permission. **Resolved:** both files join T1's Files list, and **DD18** rules the role
  model.

- **S10 — the search entity union is CLOSED, and it lives in another package.** T3 registers a
  `membership.instrument` search provider, and `SearchProvider.entity` is typed `SearchEntity` — a
  closed union in `packages/contracts/src/search.ts`, beside the `@alias` table a desk actually
  types. Neither file was in any Files list, and neither is in `apps/core`. Checked transitively for
  the §2.82 hazard: every reader of the union uses `Partial<Record<…>>` or passes it through — there
  is **no exhaustive switch anywhere** — so widening it breaks nothing. **Resolved:**
  `packages/contracts/src/search.ts` and `packages/contracts/src/search.test.ts` join T3's Files
  list, and the union's own comment already anticipates this: *"A new module EXTENDS THIS UNION and
  registers a provider on its own manifest; it never edits the route."*

- **S11 — the SPA route census is PINNED AT A NUMBER, in a core test, and four tasks move it.**
  `apps/core/test/caddyfile-parity.test.ts` parses `apps/web/src`'s TanStack route table and asserts
  `routes).toHaveLength(20)`. This phase adds four screens, so T3, T5, T7 and T8 each move it by one
  — and none of them named the file. **Resolved:** it joins all four Files lists; waves are
  sequential and one task each, so four tasks touching one number cannot collide. Checked and NOT a
  problem: `API_BASE` is `/api` and every call goes through that one door, so new endpoints need
  **no `docker/prod/Caddyfile` change** — that file stays frozen. The route-shadowing leg is also
  satisfied by construction, since no new SPA route begins with `/api`.
- **S12 — a sweep that binds T4's DIFF without changing any file.** `modules/billing/billing-purity.test.ts`
  greps **every file under `modules/billing`, fixtures and tests included**, for float tokens —
  `Math.round`, `toFixed`, `parseFloat`, `* 0.` and **`z.coerce`** — with the token list assembled
  from fragments so the sweep covers its own file too. T4 edits three files in that directory and
  extends `golden-billing.test.ts`. **Resolved:** no Files-list change is needed; the constraint goes
  in T4's brief as a stated one — every division goes through the tariff engine's `divHalfUp`, and a
  zod coercion is not available in that directory. The pure-core leg does not bind: none of the
  three files T4 edits is in `PURE_FILES`.

- **S13 — the README is PINNED TO THE ROLE MODEL, cell for cell, in both directions.**
  `seed-roles.test.ts`'s V3 leg parses the README's two markdown permission tables and compares them
  against `ROLE_MODEL` both ways, with one escape hatch: a `NON_TABLE_PAIRS` union of grants
  authorised by a **quoted README prose line**. Two prior rulings — owner ruling 7's `patients.*`
  grants and the 2026-08-23 workflow ruling — each landed that way, as a named constant plus a prose
  sentence the test quotes verbatim. DD18's grants have no README column either, so they take the
  same shape, and **`README.md` therefore belongs in T1's Files list, not only T8's**. Resolved: it
  is in both — T1 for the ruling's prose and its pairs constant, T8 for the flag runbook.
- **Checked and clear: `deploy-parity.test.ts`.** It parses `docker-compose.prod.yml` and
  `deploy.sh` for service/config/restart parity. This phase changes no compose service, no config
  directory and no restart loop, so it is untouched — recorded because "the deploy parity test
  enumerates things" is exactly the shape that looks like a hazard until somebody reads it.

- **S14 — S3's other half: a seed script nobody runs (§2.71 again, one layer out).** S3 gave T3 a
  `seed:membership` script. `docker/prod/deploy.sh` runs **five** seeds, in a **load-bearing order**
  its own comments spell out, and a seed absent from that list is registered in tests and nowhere
  else — which is precisely the gap that left production with an empty `billing_config` on
  2026-08-24. **Resolved:** `docker/prod/deploy.sh` joins T3's Files list. `seed:membership` runs
  **beside `seed:billing`/`seed:tariff` and BEFORE `seed:roles`**, because `seed-roles`' census
  counts what other seeds have already granted, and it must be **non-destructive on re-run**
  (`onConflictDoNothing`) — the house convention Plan 11g brought the last exception into.
  **Deliberately NOT added to deploy.sh: `import-holder-book`** (T5). It is an operator command run
  against a partner drop, not deployed configuration; a deploy that imported a holder book would be
  importing data nobody asked it for, which is the same reasoning that keeps `seed:admin` out.

- **S15 — found by the SPIKE, not by the sweep, and it is the one the sweep could not have found.**
  DD12's rewrite needs an invoice's live money and per-line credited base; billing keeps those
  readers private and the module-isolation lint stops `partners` reaching past billing's `index`.
  **Resolved by DD19:** T4 ships one new export, T6 consumes it, and
  `apps/core/src/modules/billing/index.ts` plus `accrual-view.ts` join T4's Files list. Recorded here
  rather than only in DD19 because it is a **Files-list** consequence, and the pre-flight compares
  Files lists.

- **Item 5 — tasks with no in-pipeline verdict (§2.50).** One: T8, the only ROUTINE task. It gets a
  mechanical-check agent so the wave-stall break stays alive for it. T1 applies a migration and is
  CRITICAL, so it already has a gate.
- **Item 6 — a commit message per task.** Present on all eight, verbatim below.
- **Items 2/§2.65/§2.82 — widened symbols and their readers.** `AppConfig` gains five keys; no test
  asserts it exhaustively (`toEqual`/`Object.keys` do not appear in `config.test.ts`), so the
  widening breaks nothing. `ModuleManifest` is not widened — `search?` is already optional.
  `ALL_MANIFESTS` widens from nine to eleven and its census test is named by T1. **`router.tsx` is
  named by four tasks** (T3, T5, T7, T8); waves are strictly sequential and one task each, so
  §2.62's coalesced-push hole and merge conflicts are both closed by construction.
- **Item 3 — fork-open branches.** None. This document resolves every fork it opens in place.
- **Item 4 — what the plan asserts about anything the spike proves unused.** Held open until the
  spike reports; §2.49's vacuous-assertion check runs against its answers, and the one already
  identified is T8's export-shape test, which is given a synthetic leg that can fail.
- **Items 8 and 9 — the script's `files` arrays and CI per commit.** Discharged by the pre-flight
  and by `ci-watch-host.sh` respectively; both are named in §8's mechanical verification.

### T1 — CRITICAL — schema, both modules, the flags, and the lint rule F1 asked for

**Scope.** One migration (`0022`) creating **seventeen** tables across two schema files — sixteen,
plus `commission_accrual_subjects`, the per-invoice serializer DD12's rewrite requires; both module
skeletons (manifest, Nest module, index, errors, events) installed through `ALL_MANIFESTS`
**app-side only** (S2); the five config flags; `catalogs-empty.test.ts` (DD3); and the eslint rule
banning bare `loadConfig()` under `**/*.test.ts`.

**Why the lint rule is here and not in T8.** F1 cost the last phase a red CI commit and about an
hour, and this phase adds roughly eight test files that will each be tempted to call
`loadConfig()`. A guard that lands after the tests it guards is a guard that never fires. It is a
few lines in `eslint.config.mjs` and it is v3 §4 applied literally: the check becomes executable or
it is not method.

**Files — create**
```
apps/core/src/kernel/db/schema/membership.ts
apps/core/src/kernel/db/schema/membership.test.ts
apps/core/src/kernel/db/schema/partners.ts
apps/core/src/kernel/db/schema/partners.test.ts
apps/core/src/modules/membership/index.ts
apps/core/src/modules/membership/manifest.ts
apps/core/src/modules/membership/membership.module.ts
apps/core/src/modules/membership/errors.ts
apps/core/src/modules/membership/events.ts
apps/core/src/modules/membership/events.test.ts
apps/core/src/modules/membership/catalogs-empty.test.ts
apps/core/src/modules/partners/index.ts
apps/core/src/modules/partners/manifest.ts
apps/core/src/modules/partners/partners.module.ts
apps/core/src/modules/partners/errors.ts
apps/core/src/modules/partners/events.ts
apps/core/src/modules/partners/events.test.ts
apps/core/drizzle/0022_<generated-name>.sql
apps/core/drizzle/meta/0022_snapshot.json
```
**Files — modify**
```
apps/core/drizzle/meta/_journal.json
apps/core/src/kernel/db/schema/index.ts
apps/core/src/kernel/modules/manifests.ts
apps/core/src/kernel/modules/manifests.test.ts
apps/core/src/app.module.ts
apps/core/src/kernel/config.ts
apps/core/src/kernel/config.test.ts
apps/core/test/helpers/db.ts
apps/core/scripts/seed-roles.ts
apps/core/test/seed-roles.test.ts
README.md
eslint.config.mjs
```
`README.md` is named because of S13 — the role model and the README's permission tables are pinned
to each other in both directions. DD18's grants have no README column, so they follow the two
existing precedents exactly: a **named pairs constant** in the test plus a **README prose line the
test quotes verbatim** as the authorisation. Add the paragraph and the constant; do not restructure
the existing tables.

`apps/core/scripts/seed-roles.ts` and its test are named because of S9: the reachability invariant
fails the build unless every permission this task declares is either granted in `ROLE_MODEL` or
entered in `NOT_YET_MODELLED` **with its reason**, and the census counts and the per-module map are
re-measured from what the task actually declares — never transcribed from this document (v3 §1's
fact rule: that number is owned by the manifests, not by the plan).

`apps/core/test/helpers/db.ts` is named because of S8 — every new table that FKs into `patients`,
`invoices` or `invoice_lines` must join THAT group's own truncate statement, and a table with no
inbound FK takes its own statement (the `search_audit` and `auth_throttle` precedents, both
documented in place in that file).

The drizzle `meta/` entries are named because F5 caught a snapshot missing from the commit that
carried its migration; the generated name is filled in by the task and reported.

**Two migration facts measured by the spike (§3 Q1), not to be re-derived.** The composite FK ships
with the **default `ON UPDATE NO ACTION`** and a comment saying why (`CASCADE` leaves the FK
satisfied and relies on a child CHECK that a later table might not have). And a counterparty's class
is frozen while any accrual row exists — receivable included — so nothing in this phase may
implement a status change as a class change.

**Acceptance.** The migration applies cleanly to a fresh database and to the per-worker databases ·
`manifests.test.ts`'s census goes nine → eleven and still pins the app/worker difference as
deliberate, now recording that partners is app-only until T6 · every new permission string is
declared on a manifest · all five flags parse `false` from an env object containing none of them ·
`catalogs-empty.test.ts` green · the lint rule is demonstrated to FIRE on a deliberately-added bare
`loadConfig()` in a scratch test file, and that file is removed before the commit · `pnpm verify`
exit 0 read from a file · `git status --porcelain` empty.

**Assertion Book (inline).**
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| A1 | a payable accrual naming an `external_rmp` counterparty is refused by the DATABASE | drop the `CHECK` from a copy of the migration | honest insert of a payable row against an `external_rmp` counterparty |
| A2 | the class on a payable row cannot disagree with its counterparty's | drop the composite FK, keep the CHECK | insert with an RMP `counterparty_id` and a forged `payee_class = 'channel_partner'` |
| ~~A3~~ | ~~a counterparty's class cannot become `external_rmp` while payable rows point at it~~ **STRUCK 2026-08-25, S6 resolved:** §3 Q1 measured that the composite FK already refuses this from the parent side (`ON UPDATE NO ACTION`, checked both ways). There is no trigger to mutate, so there is no row. The property is real and is covered by A2's constraint. | — | — |
| A4 | ledger rows are append-only | drop the trigger from a copy of the migration | `UPDATE commission_accruals SET amount_paise = …` |
| A5 | the single-use redemption index is real | drop the partial unique index | two `state='redeemed'` rows for one single-use coupon |
| A6 | every catalog is empty in a fresh database | a mutant seed script inserting one plan row | `catalogs-empty.test.ts` against the mutant seed |

**Commit.** `feat(core): partner, instrument and accrual-ledger schema — external RMP unpayable at the schema level (09 T1)`

### T2 — CRITICAL — the pure benefit resolver contract, the two `AdjustmentSource`s, and Plan 09's golden harness

**Scope.** `ResolvedInstruments` (the value T3 will produce), `membershipSource` and `couponSource`
factories, the coupon validity predicate (date window, weekday mask, IST time-of-day window,
min-bill threshold, percentage cap), and a golden fixture harness with **hand-computed `workings` on
every fixture** — Plan 06's `workings: z.string().min(20)` discipline copied deliberately, so a
fixture without real arithmetic shown fails to PARSE.

No database, no billing, no `modules/tariff` edit. Everything imports through the frozen index.

**Files — create**
```
apps/core/src/modules/membership/instruments.ts
apps/core/src/modules/membership/instruments.test.ts
apps/core/src/modules/membership/sources.ts
apps/core/src/modules/membership/sources.test.ts
apps/core/src/modules/membership/coupon-rules.ts
apps/core/src/modules/membership/coupon-rules.test.ts
apps/core/src/modules/membership/golden/fixture-schema.ts
apps/core/src/modules/membership/golden/golden.test.ts
apps/core/src/modules/membership/golden/fixtures/          (directory — every fixture .json in it is this task's)
```
**Files — modify**
```
apps/core/src/modules/membership/index.ts
```

**Acceptance.** The fixture manifest is pinned by name and the directory is asserted to contain
nothing else (Plan 06's two anti-vacuity tests, copied) · every fixture prices at least one line ·
a member+coupon contest, a GST-exempt line under a coupon, a percentage-cap exact hit (K3), an
off-peak window boundary at 11:59:59 IST (K8), an IST-midnight expiry (K7), a min-bill threshold met
only before another discount applies (K4), a zero-amount line (K5) and a three-instrument contest
recording all rejected candidates (R7) each have a fixture · `git show --stat` shows **zero files
under `apps/core/src/modules/tariff/`**.

**Assertion Book (inline).**
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| B1 | the contest picks the single best benefit and never stacks | a source returning the SUM of membership and coupon as one candidate | a line eligible for both, where sum ≠ max |
| B2 | an exact tie breaks toward the earlier source in the array | swap the appended order | a membership and a coupon computing identical paise on one line |
| B3 | a rejected candidate is recorded, not dropped | return `[]` instead of a rejected candidate | an over-cap coupon on an otherwise-eligible line |
| B4 | the percentage cap applies to the ASK, not to the clamped amount | cap the clamped value | a benefit whose raw value exceeds both the cap and the line gross |
| B5 | the off-peak window closes at its stated second, in IST | compare in UTC | 11:59:59 and 12:00:00 IST on an in-window weekday |
| B6 | expiry is evaluated at the IST day boundary | compare `Date` in UTC | an instrument expiring on a date, priced at 18:31 UTC the same day |
| B7 | every candidate's `sourceKey` EQUALS its source's `key`, and the two sources' keys differ | emit a `sourceKey` that differs from the source's `key` | an exact tie the mismatched source should win on order and instead loses — §3 Q3's measured trap: `runContest` indexes precedence by `sourceKey` and falls back to `MAX_SAFE_INTEGER`, silently |

**Commit.** `feat(core): membership and coupon adjustment sources — pure, golden-fixtured, tariff untouched (09 T2)`

### T3 — CRITICAL — recognition at the counter: lookup, the sealed gate, the rate limit, grace-honor

**Scope.** `resolveInstruments(db, {patientId, presentedCodes, at})` producing T2's value; lookup by
card code, phone and patient through the 11h search seam (a `membership.instrument` provider
declared on the manifest); `visiblePatientIds()` as the ONLY sealed/restricted gate; Devanagari
holder names findable (F7's ASCII-`\b` trap named in the brief); `checkSearchRate` on code lookup;
the grace-honor approval type, **its seed script (S3)** and its event; the disclosure line rendered
at honouring time (E-32); the counter surface in `apps/web`; and DD16's `perk` write through the
OPD module's index.

**Files — create**
```
apps/core/src/modules/membership/recognition.ts
apps/core/src/modules/membership/recognition.test.ts
apps/core/src/modules/membership/search-providers.ts
apps/core/src/modules/membership/search-providers.test.ts
apps/core/src/modules/membership/approval-types.ts
apps/core/src/modules/membership/approval-types.test.ts
apps/core/src/modules/membership/membership.controller.ts
apps/core/scripts/seed-membership.ts
apps/core/test/membership-recognition.e2e.test.ts
apps/web/src/lib/membership-api.ts
apps/web/src/screens/counter-instruments.tsx
apps/web/src/screens/counter-instruments.test.tsx
```
**Files — modify**
```
apps/core/src/modules/membership/index.ts
apps/core/src/modules/membership/manifest.ts
apps/core/src/modules/membership/events.ts
apps/core/src/modules/membership/membership.module.ts
apps/core/package.json
docker/prod/deploy.sh
packages/contracts/src/search.ts
packages/contracts/src/search.test.ts
apps/web/src/router.tsx
apps/core/test/caddyfile-parity.test.ts
apps/web/src/screens/billing-counter.tsx
apps/web/src/locales/en.json
apps/web/src/locales/hi.json
```
The two `packages/contracts` files are named because of S10 — the entity union and its alias table
are the seam a new search provider extends. **Add a member and an alias; change nothing else in that
package.**

Both locale files are named because a new screen needs its `nav.*` and body keys in each, and F5
caught a locale file reformatted wholesale to add one key — **add keys, do not re-serialise the
file**.

**Acceptance.** A sealed patient's instrument is invisible to a caller without the confidential
permission **in the same query that produces the count**, never by post-filtering · a
Devanagari-stored holder is found by a Latin query and vice versa · lookup past the limit is refused
with `Retry-After` and logs an EVENT, not an audit row · grace-honor without an approval is refused ·
the honouring response carries the disclosure text · a recognised instrument sets `perk` only
through the OPD module's index · the e2e covers the null-auth case (11h's MAJOR-5 lesson) ·
`seed:membership` registers the approval type and is idempotent on a second run.

**Assertion Book (inline).**
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| C1 | the sealed gate is in the SQL, and `total` is counted by the same query | compute `total` with the gate removed | a sealed patient holding an instrument, queried by a non-confidential actor |
| C2 | code lookup is rate limited per actor | remove the window predicate | limit+1 lookups inside the window by one actor, and the same by two actors |
| C3 | a refusal does not extend the block | write refusals to the counted table | limit+5 lookups, then one at window+1s |
| C4 | grace-honor requires an approval | drop the approval check | a grace-honor call with no `approvalId` |
| C5 | Devanagari and Latin spellings of one holder both match | remove the transliteration leg | one invented holder stored in one script, queried in the other |

**Commit.** `feat(core,web): instrument recognition at the counter — sealed-gated, rate-limited, grace-honor by approval (09 T3)`

### T4 — CRITICAL — the billing integration: compose, consume, redeem — and restore, release, reverse

**Scope.** DD2's composition into `priceDraft` behind `MEMBER_BENEFITS_ENABLED`; the redemption row
and the entitlement consume inside the invoice transaction under DD10's lock; and the SYMMETRIC half
in the same task — restore on credit note, release on `markEnteredInError` or a full `correction`
(DD9). **Consume and restore ship together on purpose:** they are one property, and the class where
one task ships a mechanism dormant and another arms it (§2.86) is exactly what splitting them would
invite.

**Files — create**
```
apps/core/src/modules/membership/entitlements.ts
apps/core/src/modules/membership/entitlements.test.ts
apps/core/src/modules/membership/entitlements.contention.test.ts
apps/core/src/modules/membership/redemptions.ts
apps/core/src/modules/membership/redemptions.test.ts
apps/core/src/modules/billing/accrual-view.ts
apps/core/src/modules/billing/accrual-view.test.ts
```
**Files — modify**
```
apps/core/src/modules/membership/index.ts
apps/core/src/modules/billing/index.ts
apps/core/src/modules/billing/invoices.ts
apps/core/src/modules/billing/credit-notes.ts
apps/core/src/modules/billing/receipts.ts
apps/core/src/modules/billing/golden-billing.test.ts
```

**This task also ships DD19's seam, and §2.49 binds hardest there.** `invoiceAccrualView` has no
caller until T6. Its tests run against invoices that carry a credit note **on an eligible line**, an
allocation reversal, and an entered-in-error mark — fixtures whose numbers differ from one another,
so an implementation returning the pre-credit numbers fails. **Read the stored `invoice_lines.id`
back before building a credit note**: `issueCreditNote` refuses a draft `lineId` (§3 Q4).

**The contention test's shape is prescribed, because the obvious shape does not discriminate.**
§3 Q6 measured that a forced interleave alone ends identically with and without the lock — one
movement row either way. **Assert the BLOCK**: that the second client's `SELECT … FOR UPDATE` does
not settle while the first holds, and does settle within milliseconds of its COMMIT; then run the
natural race and report the OBSERVED over-consumption rate both ways (the spike saw 0/20 and 20/20).
Rule 20 and §2.53 apply — read the matched command LINES.

**A constraint on this task's DIFF, not on its Files list (S12).** `billing-purity.test.ts` greps
every file under `modules/billing` — fixtures and tests included — for `Math.round`, `toFixed`,
`parseFloat`, `* 0.` and **`z.coerce`**. Every division in the three files this task edits goes
through the tariff engine's `divHalfUp`, imported from the frozen index, and a zod coercion is not
available in that directory.

**Acceptance.** With the flag off, `priceDraft` composes nothing and every existing billing test
passes unchanged · with it on, a member's benefit appears in `invoice_lines.candidates` and, when it
wins, in `winner` · a partial credit note restores only the entitled line's counter (C2) · restore
after the counter's validity lapsed succeeds and is flagged (C5) · a partial refund releases no
coupon (O-4) · the contention test proves the lock, with `pgrep -af jest` read as LINES (§2.53) and
observed interference stated either way (rule 20).

**Assertion Book (inline).**
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| D1 | `MEMBER_BENEFITS_ENABLED` is load-bearing | compose unconditionally | one invoice for a member, flag off |
| D2 | the last unit cannot be consumed twice | remove `FOR UPDATE` on the parent counter | two concurrent invoices against a counter with one unit left |
| D3 | a single-use coupon cannot be redeemed twice | two mutants: remove the lock keeping the index, then remove the index keeping the lock | two concurrent invoices redeeming one code |
| D4 | a partial credit note restores only the reversed line | restore the whole counter | a two-line invoice, one line credited |
| D5 | a partial refund does not release a redemption | release on any credit note | a 50%-value `refund` credit note |
| D6 | restore is a NEGATING ROW, not an update | `UPDATE` the movement row | any restore, with the append-only trigger live |

**Commit.** `fix(core): member benefits at the counter — consume and restore as one property (09 T4)`

### T5 — CRITICAL — the holder-book import, the quarantine lane and the reconcile queue

**Scope.** Versioned column maps per drop; whole-row quarantine (never last-wins); idempotency on
`(counterparty, partner_sale_ref)`; fuzzy patient match to a manual queue that **never auto-links**;
provenance (import id, row number) on every produced row; dormant holders imported inert; over-cap
members honoured to cap and flagged (O-5); an admin screen for the queue. I1–I10.

**Files — create**
```
apps/core/src/modules/membership/import/column-maps.ts
apps/core/src/modules/membership/import/column-maps.test.ts
apps/core/src/modules/membership/import/importer.ts
apps/core/src/modules/membership/import/importer.test.ts
apps/core/src/modules/membership/import/quarantine.ts
apps/core/src/modules/membership/import/quarantine.test.ts
apps/core/src/modules/membership/import/match-queue.ts
apps/core/src/modules/membership/import/match-queue.test.ts
apps/core/src/modules/membership/import/fixtures/          (directory — every .csv in it is invented by this task, O-9)
apps/core/scripts/import-holder-book.ts
apps/web/src/screens/instrument-reconcile.tsx
apps/web/src/screens/instrument-reconcile.test.tsx
```
**Files — modify**
```
apps/core/src/modules/membership/index.ts
apps/core/src/modules/membership/manifest.ts
apps/core/src/modules/membership/events.ts
apps/core/src/modules/membership/membership.controller.ts
apps/core/src/modules/membership/membership.module.ts
apps/core/package.json
apps/web/src/lib/membership-api.ts
apps/web/src/router.tsx
apps/core/test/caddyfile-parity.test.ts
apps/web/src/locales/en.json
apps/web/src/locales/hi.json
```

**Acceptance.** Re-importing the same file produces zero new rows and says so · a duplicate key
within one drop quarantines BOTH rows with a reason and neither wins · an inverted validity range
quarantines · an unknown column shape fails loudly rather than mapping by position · a holder who
fuzzy-matches an existing patient lands in the queue and is NOT linked · a shared family phone
imports cleanly · every produced instance carries its file and row number · **the fixtures were
invented by this task and transcribe nothing from the out-of-git context file (O-9)** — the reviewer
checks it.

**Assertion Book (inline).**
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| E1 | re-import is idempotent on the partner sale reference | key on the card number alone | the same drop twice, where one holder's card number was reissued |
| E2 | an in-drop duplicate quarantines both rows | last-wins | two rows sharing a card number with different holders |
| E3 | a fuzzy patient match never auto-links | auto-link above a similarity threshold | an invented holder whose name is one edit from a registered patient |
| E4 | over-cap members are honoured to cap in file order, not dropped silently | drop the overflow with no record | a family row exceeding its plan cap by two |
| E5 | an unknown column shape refuses | fall back to positional mapping | a drop with two columns transposed |

**Commit.** `feat(core,web): the holder-book import — quarantine, provenance and a reconcile queue that never auto-links (09 T5)`

### T6 — CRITICAL — the accrual consumer on the 08.5 seam, the rate snapshot, reversal, replay, escrow

**Scope.** DD7's registration — **FOUR subscriptions** (`payment.received`, `payment.refunded`,
`allocation.reversed`, `credit_note.issued`), handler, worker install and the manifests census
**in ONE commit** (S2, Plan 10 D13); DD12's **credit-aware delta-to-target** base, read through
DD19's `invoiceAccrualView`, serialised by the `commission_accrual_subjects` row lock; DD6's
issue-instant version pin and snapshot; C-17's unverified-attribution flag instead of an accrual;
escrow under suspension (O-7); the activation-keyed kicker recompute (O-6); the replay/backfill job;
dead-letter parking that does not halt the lane (A8).

**There is no separate reversal path, and that is the point.** All four events run the same code:
re-read the invoice, compute the target, append the delta. A refund, a reversal, a credit note and
an entered-in-error mark all move `collected` or `settleable` and all produce a negative delta
through that one line.

**Files — create**
```
apps/core/src/modules/partners/accrual.ts
apps/core/src/modules/partners/accrual.test.ts
apps/core/src/modules/partners/agreements.ts
apps/core/src/modules/partners/agreements.test.ts
apps/core/src/modules/partners/consumer.ts
apps/core/src/modules/partners/consumer.test.ts
apps/core/src/modules/partners/replay.ts
apps/core/src/modules/partners/replay.test.ts
apps/core/src/modules/partners/kicker.ts
apps/core/src/modules/partners/kicker.test.ts
apps/core/src/modules/partners/golden/fixture-schema.ts
apps/core/src/modules/partners/golden/golden.test.ts
apps/core/src/modules/partners/golden/fixtures/            (directory — every fixture .json in it is this task's)
```
**Files — modify**
```
apps/core/src/modules/partners/index.ts
apps/core/src/modules/partners/manifest.ts
apps/core/src/modules/partners/events.ts
apps/core/src/modules/partners/partners.module.ts
apps/core/src/kernel/worker/worker.module.ts
apps/core/src/kernel/modules/manifests.ts
apps/core/src/kernel/modules/manifests.test.ts
apps/core/test/worker-runtime.e2e.test.ts
```

**Acceptance.** The consumer is declared on the manifest AND present in `workerConsumers(db)`, and
the e2e that compares the two lists is extended · the flag-off path advances the cursor and writes
nothing · flag-on + replay reproduces the ledger exactly · a redelivered event produces no second
accrual · an accrual straddling an amendment uses the version effective at the event's `occurredAt`
and its snapshot proves it · a poison row parks and the next event still processes · every money
path has a golden fixture with hand-computed workings.

**Assertion Book (inline).**
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| F1 | the base is post-discount | use `gross_paise` | an invoice line carrying a winning discount |
| F2 | the base is pre-GST | use `net_paise` | a taxable (non-exempt) eligible line |
| F3 | the base is COLLECTED, not invoiced | use the full eligible base regardless of `collected` | a part-payment of a mixed invoice |
| F3b | the base is CREDIT-AWARE — **the refuted first version is the mutant** | ignore `creditedPaise` and `creditedBasePaise` and scale by `netPayable` | §3 Q4's own fixture: settled invoice with a credit note on an eligible line — 45 000 correct against the mutant's 63 543 |
| F3c | `allocation.reversed` reverses | subscribe to `payment.received`/`payment.refunded` only | pay in full, then `reverseAllocation` — the mutant accrues and never gives it back |
| F4 | `COMMISSION_ACCRUAL_ENABLED` is load-bearing | write regardless | one `payment.received`, flag off |
| F5 | the cursor advances with the flag off | return early before the cursor write | two events with the flag off, then flag on with no replay |
| F6 | the consumer is idempotent under redelivery | drop the uniqueness on the basis event | the same event delivered twice |
| F7 | the rate SNAPSHOT wins over the current agreement, and the version is pinned at the INVOICE's issue instant | two mutants: read the rate at report time; resolve the version at each payment's instant | an invoice issued before an amendment and paid in two parts straddling it |
| F8 | a partial refund produces a proportional NEGATIVE delta, and the sum can never go below zero | reverse the full accrual on any refund | a 40% refund of a fully-paid invoice, then a second refund |
| F11 | two events for one invoice cannot double-append | remove the `FOR UPDATE` on the subject row | two dispatch cycles handling two different events for one invoice concurrently |
| F9 | suspension escrows rather than skips | skip the write | a `payment.received` for a suspended partner |
| F10 | the kicker counts ACTIVATED, not fed | count fed rows | a drop of backdated rows landing after a period closed |

**Commit.** `feat(core): the accrual consumer — replay-safe, snapshot-rated, and inert until the CA gate opens (09 T6)`

### T7 — CRITICAL — the receivable instrument: attribution, statement import, reconciliation, aging

**Scope.** Attribution issuance at referral time with a printable code and QR (the 11h barcode wedge
reads it back); the expectation lifecycle `expected → matched → disputed → written_off`; statement
import with its own column maps and the partner-ref mapping table (DD13); V1–V7; the aging read
model.

**Files — create**
```
apps/core/src/modules/partners/attribution.ts
apps/core/src/modules/partners/attribution.test.ts
apps/core/src/modules/partners/statements.ts
apps/core/src/modules/partners/statements.test.ts
apps/core/src/modules/partners/reconcile.ts
apps/core/src/modules/partners/reconcile.test.ts
apps/core/src/modules/partners/aging.ts
apps/core/src/modules/partners/aging.test.ts
apps/core/src/modules/partners/partners.controller.ts
apps/core/test/partners-receivables.e2e.test.ts
apps/web/src/lib/partners-api.ts
apps/web/src/screens/partner-receivables.tsx
apps/web/src/screens/partner-receivables.test.tsx
```
**Files — modify**
```
apps/core/src/modules/partners/index.ts
apps/core/src/modules/partners/manifest.ts
apps/core/src/modules/partners/events.ts
apps/core/src/modules/partners/partners.module.ts
apps/web/src/router.tsx
apps/core/test/caddyfile-parity.test.ts
apps/web/src/locales/en.json
apps/web/src/locales/hi.json
```

**Acceptance.** A statement line with no hospital attribution becomes `disputed`, never silently
accepted (V1) · a hospital attribution absent from a statement ages and appears in the report (V2) ·
a late correction lands as an adjustment row and edits nothing (V3) · a cancelled test voids its
expectation (V4) · an unclaimed slip expires after the configured days (V5) · a statement quoting
another partner's attribution id is disputed (V6) · the mapping table is the only join, and a test
proves no fuzzy fallback exists (V7).

**Assertion Book (inline).**
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| G1 | an unmatched statement line disputes rather than accrues | accrue on any statement line | a line whose attribution id does not exist |
| G2 | the attribution's partner is the one on the slip | match on the statement's partner instead | a statement from one partner quoting another's id |
| G3 | there is no fuzzy join | add a similarity fallback | a statement ref differing from a mapped ref by one character |
| G4 | a late correction appends | update the prior row | a statement amending a prior period, trigger live |
| G5 | `RECEIVABLE_COMMISSION_ENABLED` is load-bearing | create expectations regardless | one referral, flag off |

**Commit.** `feat(core,web): the receivable-commission instrument — attribution, statements and an aging report (09 T7)`

### T8 — ROUTINE — guardrails, identity-free exports, the channel P&L, and the runbook

**Scope.** E-32's enforcement points collected and tested in one place; DD15's export-shape test;
the per-partner P&L read model (cards active, member spend, payable, receivable
expected/matched/disputed, net channel margin); and the **runbook**: which flag the owner flips, in
what order, and which CA/counsel register item gates each — the operable form of O-8.

**Explicit non-goal, and it is a finding from the sweep (S5): `check:config-present` does NOT learn
about this phase.** Plan 09's catalogs are legitimately empty until commissioning (DD3), and 11g's
deploy gate has a third leg specifically to avoid refusing every deploy on config that is correctly
absent. A comment in `guardrails.test.ts` records this so the next reader does not "complete" the
gate.

**Files — create**
```
apps/core/src/modules/partners/pnl.ts
apps/core/src/modules/partners/pnl.test.ts
apps/core/src/modules/partners/exports.ts
apps/core/src/modules/partners/exports.test.ts
apps/core/src/modules/membership/guardrails.test.ts
apps/web/src/screens/partner-pnl.tsx
apps/web/src/screens/partner-pnl.test.tsx
```
**Files — modify**
```
apps/core/src/modules/partners/index.ts
apps/core/src/modules/partners/manifest.ts
apps/core/src/modules/partners/partners.controller.ts
apps/web/src/lib/partners-api.ts
apps/web/src/router.tsx
apps/core/test/caddyfile-parity.test.ts
apps/web/src/locales/en.json
apps/web/src/locales/hi.json
README.md
docs/superpowers/plans/2026-08-25-phase1-09-memberships-coupons-accrual-ledger.md
```

**Acceptance.** No exported field resolves to a patients-table column, proven by walking the row
SHAPE rather than by reading the code · no counter screen renders a sales figure · the P&L reads
zeros with the lanes off and does not error · the runbook names all five flags, their order, and
their gate · `pnpm verify` exit 0 · CI green by full SHA before close.

**ROUTINE means no mutants are owed** (AGENT-RULES §3). If this task NOTICES an assertion that
cannot discriminate — particularly the export-shape test, which is exactly the kind that passes
vacuously when the shape is empty (§2.49) — it says so as a finding rather than building a mutant
nobody asked for. The export test therefore ships with a synthetic leg that CAN fail: a row shape
deliberately carrying a patient field, asserted to be refused.

**Commit.** `feat(core,web): channel P&L, identity-free exports and the flag runbook (09 T8)`

---

## 7. Routed to the owner — NOT this phase's, named so they are not lost

1. **O-8, the CA/counsel register** (context file §7, five items). Nothing in a gated lane goes live
   without the sign-off recorded as an owner ruling. The runbook (T8) is where the flip is written
   down; this is the decision that authorises it.
2. **Register item 4 — cooling-off refunds on partner-sold instruments.** It has no code lane in
   Phase 1 because there is no sale lane; it gates the sale lane when Phase 2 opens it.
3. **Real terms, as config and import files.** Agreements, plan catalogs, coupon families and the
   holder book arrive at commissioning. Nothing in the repo will contain them (DD3).
4. **O-2's successor: benefit validity across an IPD episode.** Deliberately not decided here, with
   the reason recorded in O-2. The IPD phase inherits it.
5. **Whether a merged patient's duplicate entitlement counters are consumable** — DD11 rules them
   consumable and queues the duplicate for a human; if the owner wants the stricter rule, it is a
   config decision, not a rebuild.
6. **The `gh` credential** (standing, from 11f/11h). This phase watches CI with `ci-watch-host.sh`
   and will again be unable to read job LOGS on a red.
7. **The all-sessions token total** (runbook O3, outstanding for four phases). The stop-loss above is
   stated in subagent tokens precisely because of this.

---

## 8. CLOSE — appended as the phase runs (v3 §1.5)

_This section is the findings inbox and the gate report. Nothing below is written in advance._

### Task ledger
| task | commit | tier | verdict |
|---|---|---|---|
| phase document | `e7a6f05` | — | CI **GREEN** by full SHA (`ci-watch-host.sh`, exit 0) |
| _appended as each task lands_ | | | |

### Findings — this session's own, in the order they were found

- **F1 — the compile-time sweep found THIRTEEN defects before a brief was written, four of which
  would have HALTED a task.** They are recorded in §6.0 with their resolutions (S1–S15). The four
  halting ones: S8 (`truncateAll` and §3.12's constraint-existence rule), S9 (the role-model
  reachability invariant, which fails the build by design), S13 (the README pinned cell-for-cell to
  the role model) and S14 (a seed script in no deploy path — the same gap that left production with
  an empty `billing_config` on 2026-08-24). **Every one of them is a file no task's Files list
  named**, which is §2.46's stated blind spot and §2.65/§2.82's assert-on graph, both earning their
  place again.
- **F2 — the pipeline template the ledger names DOES NOT EXIST on this host.** `stat` on
  `/root/.claude/routing.parked/skills/execute/SKILL.md`: *No such file or directory*, and there is
  no `execute` skill under `/root/.claude/skills/` either. §2.51's rule is *stat it before you grep
  it*, and its own artefact had rotted out from under it — so every "I checked the template" claim
  made since it vanished discharged nothing. The live template is the committed pipeline scripts
  plus `pipelines/README.md`. **Ledger-bound** (§2 header line).
- **F3 — the spike refuted the plan twice, which is exactly what 50k of spike is for.** DD12's base
  formula was wrong for any invoice carrying a credit note or an allocation reversal (63 543 against
  a correct 45 000, measured on the spike's own fixture), and DD7 was subscribed to two of the
  **three** events that carry collected money off an invoice. Both were rewritten before a line of
  T6 existed. §3 Q4 holds the measurement.
- **F4 — a leftover scratch database from an earlier plan is still in the dev cluster:
  `hmis_spike85_1`.** Not this phase's, not created or dropped by anyone here, and reported rather
  than touched (rule 8). AGENT-RULES rule 7 requires a scratch database to be dropped in the task
  that made it; this one outlived Plan 08.5. Named so it is somebody's decision rather than
  nobody's.

### The independent reviewer (v3 §3.4 / EXECUTE-METHOD §4's discovery review)

### Mechanical verification

**Baseline, measured 2026-08-25 at `d7a8981` by detached `pnpm verify` with the exit VALUE read
from a file (rules 16–18): exit 0.** `apps/core` **166 suites / 1310 tests** · `apps/web`
**38 files / 210 tests** · `packages/contracts` **4 suites / 20 tests**. AGENT-RULES §4 governs
what happens to these: the workspace total must not decrease and no task's diff may delete a test.

### Actuals (v3 §6)

| | |
|---|---|
| stop-loss | 4.5M subagent tokens (§ THE LANE) |
| spent so far | **188,357 subagent tokens** — one agent, the spike (55 tool calls, 14 m 49 s) |
| tasks landed | 0 of 8 |
| mutants | 8 built by the spike against scratch schema/tests, all DIED |
| tokens, all sessions | **owner-held** (`/cost`) — runbook O3, outstanding for four phases |

### Ledger entries this phase earned

### The ARCHIVE pass (v3 §5)
