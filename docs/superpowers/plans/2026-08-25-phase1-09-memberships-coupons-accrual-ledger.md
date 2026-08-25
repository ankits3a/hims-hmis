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
full two-module build (sixteen tables, one migration, two new Nest modules, a dispatcher consumer,
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
generates and its `meta/` snapshot · `.github/workflows/**` (AGENT-RULES rule 10).

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
**Answer (measured):** _appended by the spike._

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
**Answer (measured):** _appended by the spike._

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
**Answer (measured):** _appended by the spike._

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
**Answer (measured):** _appended by the spike._

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
**Q1's fourth probe decides whether a fourth clause is needed** — a guard on changing a
counterparty's class while payable children exist. If Postgres permits that update, T1 adds a
`BEFORE UPDATE` trigger on `counterparties` and the Assertion Book grows a row.

An external-RMP counterparty may still EXIST — attribution and reporting need it. What cannot exist
is money owed to one. The `payout.class_blocked` event stays for the attempt path.

### DD5 — The accrual ledger is append-only by trigger; reversal, escrow and correction are all ROWS (RULED)

`partner_ledger_forbid_mutation()` mirrors `billing_forbid_mutation()` in shape and raises with this
module's own message (Q2: a shared function would let one plan's migration change another's error
text). Attached `BEFORE UPDATE OR DELETE FOR EACH ROW` to `commission_accruals`,
`entitlement_movements` and `coupon_redemptions`.

Consequences, each of which is a design commitment rather than a note:
- A reversal is a **negating row** carrying `reverses_accrual_id`. Sum of reversals against an
  accrual may never exceed it — enforced in the writer under the row lock and pinned by a test.
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
a pointer. A6 (an amendment mid-period) is then not a special case: the accrual that straddles it
computed from whichever version was effective at the basis event's `occurred_at`, and the snapshot
proves which. **The dispatcher hands the consumer `occurredAt` — the event's own instant, never the
worker's clock** (`kernel/events/subscriptions.ts`, Plan 10 D5), which is exactly what makes a
replayed accrual compute the same answer it would have computed the first time.

### DD7 — The accrual consumer registers ALWAYS and advances its cursor ALWAYS; the CA-gated flag decides only whether it WRITES (RULED)

This is the phase's most consequential wiring decision and it inverts the obvious one.

The obvious implementation of "the lane is config-OFF" is to register the subscription only when
the flag is on. That is **check-on-execute wearing a manifest's clothes**, and the roadmap forbids
it in as many words. Worse, it is silently lossy: a subscription that was never registered has no
cursor, so flipping the flag later starts from `now` and every event before the flip is gone.

So: `partnersManifest.subscriptions` declares `payment.received` and `payment.refunded`
unconditionally, `workerConsumers(db)` carries the handler unconditionally, and the handler reads
the flag and — when it is off — **advances without writing**. Turning the lane on is then two steps
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

### DD12 — The accrual base is defined ONCE, here (RULED)

For a `payment.received` carrying `{invoiceId, amountPaise}` against an agreement whose terms name
an eligible service-category set:

```
eligibleBase   = Σ invoice_lines.taxable_base_paise  where category ∈ eligible
invoiceBase    = invoices.net_payable_paise
collectedBase  = divHalfUp(eligibleBase × amountPaise, invoiceBase)
accrual        = percentAmount(collectedBase, rateBps)
```

`divHalfUp` and `percentAmount` are Plan 06's, imported from the frozen tariff index — this phase
does not write its own rounding. At full payment `amountPaise = invoiceBase` and `collectedBase`
reduces to `eligibleBase`, which is the property a fixture pins.

**Post-discount** (`taxable_base_paise` is already net of the winning adjustment), **pre-GST**
(it excludes `cgst`/`sgst`), **collected** (scaled by what was actually paid). The three plausible
wrong bases — gross instead of post-discount, GST-inclusive instead of pre-GST, invoiced instead of
collected — are **three built mutants** against one golden fixture with hand-computed workings.
Q4's measurement decides the denominator; if `payment.received` turns out to carry a running total
rather than an increment, the formula above changes and this section is amended before T6 compiles.

**Reversal (A2)** is proportional against the accrual rows for that invoice, half-up, appended with
`reverses_accrual_id`, and capped so total reversal can never exceed total accrual.

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

---

## 6. Tasks

Eight tasks. Tier, Files list, acceptance criteria, commit message, and — for CRITICAL tasks —
Assertion Book rows inline (assertion · mutant · discriminating input), per v3 §1.4.
**Files lists are authoritative for the frozen-path block the compiler generates from them
(§2.25/§2.54): the compile sweep asserts the pipeline script's `files` arrays equal these lists,
both directions, per task.**

The order is recognition-first (DD8) and the T4/T5 boundary is where the phase splits if the
stop-loss fires.

### T1 — CRITICAL — schema, both modules, the flags, and the lint rule F1 asked for

**Scope.** One migration (`0022`) creating sixteen tables across two schema files; both module
skeletons (manifest, Nest module, index, errors, events) installed through `ALL_MANIFESTS`; the
five config flags; `catalogs-empty.test.ts` (DD3); and the eslint rule banning bare `loadConfig()`
under `**/*.test.ts`.

**Why the lint rule is here and not in T8.** F1 cost the last phase a red CI commit and about an
hour, and this phase adds roughly eight test files that will each be tempted to call
`loadConfig()`. A guard that lands after the tests it guards is a guard that never fires. It is
four lines in `eslint.config.mjs` and it is v3 §4's rule applied literally: the check becomes
executable or it is not method.

**Files** — create: `apps/core/src/kernel/db/schema/membership.ts`,
`apps/core/src/kernel/db/schema/partners.ts`,
`apps/core/src/kernel/db/schema/membership.test.ts`,
`apps/core/src/kernel/db/schema/partners.test.ts`,
`apps/core/src/modules/membership/{index,manifest,membership.module,errors,events,events.test}.ts`,
`apps/core/src/modules/partners/{index,manifest,partners.module,errors,events,events.test}.ts`,
`apps/core/src/modules/membership/catalogs-empty.test.ts`,
`apps/core/drizzle/0022_*.sql` (+ its `meta/` snapshot — §F5: the snapshot ships in the same
commit as its migration).
Modify: `apps/core/src/kernel/db/schema/index.ts`, `apps/core/src/kernel/modules/manifests.ts`,
`apps/core/src/kernel/modules/manifests.test.ts`, `apps/core/src/app.module.ts`,
`apps/core/src/kernel/config.ts`, `apps/core/src/kernel/config.test.ts`, `eslint.config.mjs`.

**Acceptance.** Migration applies cleanly to a fresh database and to the per-worker databases ·
`manifests.test.ts` census updated from nine to eleven and still pins the app/worker difference as
deliberate · every new permission string declared on a manifest · all five flags parse false by
default from an env object containing none of them · `catalogs-empty.test.ts` green · the new lint
rule fires on a deliberately-added bare `loadConfig()` in a scratch test file and is removed before
commit · `pnpm verify` exit 0 read from a file · `git status --porcelain` clean.

**Assertion Book (inline).**
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| A1 | a payable accrual naming an `external_rmp` counterparty is refused by the DATABASE | drop the `CHECK` from the migration copy | honest insert of a payable row against an `external_rmp` counterparty |
| A2 | the class on a payable row cannot disagree with its counterparty's | drop the composite FK, keep the CHECK | insert with `counterparty_id` of an RMP and a forged `payee_class = 'channel_partner'` |
| A3 | *(conditional on Q1's fourth probe)* a counterparty's class cannot become `external_rmp` while payable rows point at it | drop the `BEFORE UPDATE` guard | `UPDATE counterparties SET payee_class='external_rmp'` after a payable row exists |
| A4 | ledger rows are append-only | drop the trigger from the migration copy | `UPDATE commission_accruals SET amount_paise = …` |
| A5 | the single-use redemption index is real | drop the partial unique index | two `state='redeemed'` rows for one single-use coupon |
| A6 | every catalog is empty in a fresh database | a mutant seed script that inserts one plan row | `catalogs-empty.test.ts` against the mutant seed |

**Commit.** `feat(core): partner, instrument and accrual-ledger schema — external RMP unpayable at the schema level (09 T1)`

### T2 — CRITICAL — the pure benefit resolver contract, the two `AdjustmentSource`s, and Plan 09's golden harness

**Scope.** `ResolvedInstruments` (the value T3 will produce), `membershipSource` and `couponSource`
factories, the coupon validity predicate (date window, weekday mask, IST time-of-day window,
min-bill threshold, percentage cap), and a golden fixture harness with **hand-computed `workings`
on every fixture** — Plan 06's `workings: z.string().min(20)` discipline, copied deliberately so a
fixture without real arithmetic shown fails to PARSE.

No database, no billing, no `modules/tariff` edit. Everything imports through the frozen index.

**Files** — create: `apps/core/src/modules/membership/{instruments,sources,coupon-rules}.ts` and
their `.test.ts`, `apps/core/src/modules/membership/golden/{fixture-schema.ts,golden.test.ts}`,
`apps/core/src/modules/membership/golden/fixtures/*.json`.
Modify: `apps/core/src/modules/membership/index.ts`.

**Acceptance.** The fixture manifest is pinned by name and the directory is asserted to contain
nothing else (Plan 06's two anti-vacuity tests, copied) · every fixture prices at least one line ·
a member+coupon contest, a GST-exempt line under a coupon, a percentage cap exact-hit (K3), an
off-peak window boundary at 11:59:59 IST (K8), an IST-midnight expiry (K7), a min-bill threshold
met only before another discount applies (K4), a zero-amount line (K5) and a three-instrument
contest recording all rejected candidates (R7) each have a fixture · `git diff --stat` shows
**zero files under `modules/tariff/`**.

**Assertion Book (inline).**
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| B1 | the contest picks the single best benefit and never stacks | a source that returns the SUM of membership and coupon as one candidate | an invoice line eligible for both, where sum ≠ max |
| B2 | an exact tie breaks toward the earlier source in the array | swap the appended order | a membership and a coupon computing the identical paise on one line |
| B3 | a rejected candidate is recorded, not dropped | return `[]` instead of a rejected candidate | an over-cap coupon on an otherwise-eligible line |
| B4 | the percentage cap is applied to the ASK, not to the clamped amount | cap the clamped value | a percentage benefit whose raw value exceeds both the cap and the line gross |
| B5 | the off-peak window is closed at its stated second, in IST | compare in UTC | 11:59:59 and 12:00:00 IST on an in-window weekday |
| B6 | expiry is evaluated at the IST day boundary | compare `Date` in UTC | an instrument expiring on a date, priced at 18:31 UTC the same day |

**Commit.** `feat(core): membership and coupon adjustment sources — pure, golden-fixtured, tariff untouched (09 T2)`

### T3 — CRITICAL — recognition at the counter: lookup, the sealed gate, the rate limit, grace-honor

**Scope.** `resolveInstruments(db, {patientId, presentedCodes, at})` producing T2's value; lookup by
card code, phone and patient through the 11h search seam (a `membership.instrument` provider on the
manifest); `visiblePatientIds()` as the ONLY sealed/restricted gate; Devanagari holder names
findable (F7's `\b` trap named in the task); `checkSearchRate` on code lookup; the grace-honor
approval type and its event; the disclosure line rendered at honouring time (E-32); the counter
surface in `apps/web`; and DD16's `perk` write through the OPD index.

**Files** — create: `apps/core/src/modules/membership/{recognition,search-providers,approval-types}.ts`
+ tests, `apps/core/src/modules/membership/membership.controller.ts` + `.e2e` test,
`apps/web/src/screens/counter-instruments.tsx` + `.test.tsx`.
Modify: `apps/core/src/modules/membership/{index,manifest,events}.ts`,
`apps/web/src/screens/billing-counter.tsx`, `apps/web/src/router.tsx`.

**Acceptance.** A sealed patient's instrument is invisible to a caller without the confidential
permission, in the SAME query that produces the count (never a post-filter) · a Devanagari-stored
holder is found by a Latin query and vice versa · lookup past the limit is refused with
`Retry-After` and logs an EVENT, not an audit row · grace-honor without an approval is refused ·
the honouring response carries the disclosure text · a recognised instrument sets `perk` only
through the OPD index · e2e covers the null-auth case (11h's MAJOR-5 lesson).

**Assertion Book (inline).**
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| C1 | the sealed gate is in the SQL, and the total is counted by the same query | compute `total` with the gate removed | a sealed patient holding an instrument, queried by a non-confidential actor |
| C2 | code lookup is rate limited per actor | remove the window predicate | limit+1 lookups inside the window by one actor, and the same by two actors |
| C3 | a refusal does not extend the block | write refusals to the counted table | limit+5 lookups, then one at window+1s |
| C4 | grace-honor requires an approval | drop the approval check | a grace-honor call with no `approvalId` |
| C5 | Devanagari and Latin spellings of one holder both match | remove the transliteration leg | the same invented holder stored in one script, queried in the other |

**Commit.** `feat(core,web): instrument recognition at the counter — sealed-gated, rate-limited, grace-honor by approval (09 T3)`

### T4 — CRITICAL — the billing integration: compose, consume, redeem — and restore, release, reverse

**Scope.** The composition of DD2 into `priceDraft` behind `MEMBER_BENEFITS_ENABLED`; the
redemption row and the entitlement consume inside the invoice transaction under DD10's lock; and
the SYMMETRIC half in the same task — restore on credit note, release on `markEnteredInError` or a
full `correction` (DD9). **Consume and restore ship together on purpose:** they are one property,
and the class of defect where one task ships a mechanism dormant and another arms it (§2.86) is
exactly what splitting them would invite.

**Files** — create: `apps/core/src/modules/membership/{entitlements,redemptions}.ts` + tests +
`entitlements.contention.test.ts`.
Modify: `apps/core/src/modules/billing/invoices.ts`, `apps/core/src/modules/billing/credit-notes.ts`,
`apps/core/src/modules/billing/receipts.ts`, `apps/core/src/modules/membership/index.ts`,
`apps/core/src/modules/billing/golden-billing.test.ts`.

**Acceptance.** With the flag off, `priceDraft` composes nothing and every existing billing test is
byte-unchanged in behaviour · with it on, a member's benefit appears in `invoice_lines.candidates`
and, when it wins, in `winner` · a partial credit note restores only the entitled line's counter
(C2) · restore after the counter's validity lapsed succeeds and is flagged (C5) · a partial refund
releases no coupon (O-4) · contention test proves the lock, with `pgrep -af jest` read as LINES
(§2.53) and interference stated either way (rule 20).

**Assertion Book (inline).**
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| D1 | `MEMBER_BENEFITS_ENABLED` is load-bearing | compose unconditionally | one invoice for a member, flag off |
| D2 | the last unit cannot be consumed twice | remove `FOR UPDATE` on the parent counter | two concurrent invoices against a counter with one unit left |
| D3 | a single-use coupon cannot be redeemed twice | remove the lock, keep the index; then remove the index, keep the lock | two concurrent invoices redeeming one code |
| D4 | a partial credit note restores only the reversed line | restore the whole counter | a two-line invoice, one line credited |
| D5 | a partial refund does not release a redemption | release on any credit note | a 50%-value `refund` credit note |
| D6 | restore is a NEGATING ROW, not an update | `UPDATE` the movement row | any restore, with the append-only trigger live |

**Commit.** `fix(core): member benefits at the counter — consume and restore as one property (09 T4)`

### T5 — CRITICAL — the holder-book import, the quarantine lane and the reconcile queue

**Scope.** Versioned column maps per drop; whole-row quarantine (never last-wins); idempotency on
`(counterparty, partner_sale_ref)`; fuzzy patient match to a manual queue that **never auto-links**;
provenance (import id, row number) on every produced row; dormant holders imported inert; over-cap
members honoured to cap and flagged (O-5); an admin screen for the queue. I1–I10.

**Files** — create: `apps/core/src/modules/membership/import/{column-maps,importer,quarantine,match-queue}.ts`
+ tests, `apps/core/src/modules/membership/import/fixtures/*.csv` (invented rows, O-9),
`apps/core/scripts/import-holder-book.ts`, `apps/web/src/screens/instrument-reconcile.tsx` + test.
Modify: `apps/core/src/modules/membership/{index,manifest,events,membership.controller}.ts`,
`apps/web/src/router.tsx`.

**Acceptance.** Re-importing the same file produces zero new rows and says so · a duplicate key
within one drop quarantines BOTH rows with a reason, and neither wins · an inverted validity range
quarantines · an unknown column shape fails loudly rather than mapping by position · a holder who
fuzzy-matches an existing patient lands in the queue and is NOT linked · a shared family phone
imports cleanly (no unique constraint on phone) · every produced instance carries its file and row
number · **`git grep` over the fixtures shows no value from the context file** (O-9 — the reviewer
checks this, and the fixtures were invented by this task).

**Assertion Book (inline).**
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| E1 | re-import is idempotent on the partner sale reference | make the key `card_no` alone | the same drop twice, where one holder's card number was reissued |
| E2 | an in-drop duplicate quarantines both rows | last-wins | two rows sharing a card number with different holders |
| E3 | a fuzzy patient match never auto-links | auto-link above a similarity threshold | an invented holder whose name is one edit from a registered patient |
| E4 | over-cap members are honoured to cap in file order, not dropped silently | drop the overflow with no record | a family row exceeding its plan cap by two |
| E5 | an unknown column shape refuses | fall back to positional mapping | a drop with two columns transposed |

**Commit.** `feat(core,web): the holder-book import — quarantine, provenance and a reconcile queue that never auto-links (09 T5)`

### T6 — CRITICAL — the accrual consumer on the 08.5 seam, the rate snapshot, reversal, replay, escrow

**Scope.** DD7's registration (manifest + `workerConsumers` as ONE edit); DD12's base; DD6's
snapshot; proportional reversal on `payment.refunded`; C-17's unverified-attribution flag instead of
an accrual; escrow under suspension (O-7); the activation-keyed kicker recompute (O-6); the replay/
backfill job; dead-letter parking that does not halt the lane (A8).

**Files** — create: `apps/core/src/modules/partners/{accrual,consumer,replay,agreements,kicker}.ts`
+ tests, `apps/core/src/modules/partners/golden/{fixture-schema.ts,golden.test.ts}` +
`fixtures/*.json` (hand-computed workings on every money path).
Modify: `apps/core/src/modules/partners/{index,manifest,events}.ts`,
`apps/core/src/kernel/worker/worker.module.ts`, `apps/core/test/worker-runtime.e2e.test.ts`.

**Acceptance.** The consumer is declared on the manifest and present in `workerConsumers(db)`, and
the e2e that compares the two lists is extended · the flag-off path advances the cursor and writes
nothing · flag-on + replay reproduces the ledger exactly · a redelivered event produces no second
accrual · an accrual straddling an amendment uses the version effective at the event's
`occurredAt`, and its snapshot proves it · a poison row parks and the next event still processes.

**Assertion Book (inline).**
| # | assertion | mutant | discriminating input |
|---|---|---|---|
| F1 | the base is post-discount | use `gross_paise` | an invoice line carrying a winning discount |
| F2 | the base is pre-GST | use `net_paise` | a taxable (non-exempt) eligible line |
| F3 | the base is COLLECTED, not invoiced | ignore `amountPaise` and use the full eligible base | a part-payment of a mixed invoice |
| F4 | `COMMISSION_ACCRUAL_ENABLED` is load-bearing | write regardless | one `payment.received`, flag off |
| F5 | the cursor advances with the flag off | return early before the cursor write | two events with the flag off, then flag on with no replay |
| F6 | the consumer is idempotent under redelivery | drop the uniqueness on the basis event | the same event delivered twice |
| F7 | the rate SNAPSHOT wins over the current agreement | read the rate at report time | an accrual, then an amendment, then a report |
| F8 | reversal is proportional and capped | reverse the full accrual on any refund | a 40% refund of a fully-paid invoice, then a second refund |
| F9 | suspension escrows rather than skips | skip the write | a `payment.received` for a suspended partner |
| F10 | the kicker counts ACTIVATED, not fed | count fed rows | a drop of backdated rows landing after a period closed |

**Commit.** `feat(core): the accrual consumer — replay-safe, snapshot-rated, and inert until the CA gate opens (09 T6)`

### T7 — CRITICAL — the receivable instrument: attribution, statement import, reconciliation, aging

**Scope.** Attribution issuance at referral time with a printable code and QR (the 11h wedge reads
it back); the expectation lifecycle `expected → matched → disputed → written_off`; statement import
with its own column maps and the partner-ref mapping table (DD13); V1–V7; the aging read model.

**Files** — create: `apps/core/src/modules/partners/{attribution,statements,reconcile,aging}.ts`
+ tests, `apps/core/src/modules/partners/partners.controller.ts` + `.e2e` test,
`apps/web/src/screens/partner-receivables.tsx` + test.
Modify: `apps/core/src/modules/partners/{index,manifest,events}.ts`, `apps/web/src/router.tsx`.

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
| G2 | the attribution's partner is the one on the slip | match on the statement's partner instead | a statement from partner B quoting partner A's id |
| G3 | there is no fuzzy join | add a similarity fallback | a statement ref differing from a mapped ref by one character |
| G4 | a late correction appends | update the prior row | a statement amending a prior period, trigger live |
| G5 | `RECEIVABLE_COMMISSION_ENABLED` is load-bearing | create expectations regardless | one referral, flag off |

**Commit.** `feat(core,web): the receivable-commission instrument — attribution, statements and an aging report (09 T7)`

### T8 — ROUTINE — guardrails, identity-free exports, the channel P&L, and the runbook

**Scope.** E-32 enforcement points collected and tested in one place; DD15's export shape test; the
per-partner P&L read model (cards active, member spend, payable, receivable expected/matched/
disputed, net channel margin); and the **runbook**: which flag the owner flips, in what order, and
which CA/counsel register item gates each — the operable form of O-8.

**Files** — create: `apps/core/src/modules/partners/{pnl,exports}.ts` + tests,
`apps/core/src/modules/membership/guardrails.test.ts`,
`apps/web/src/screens/partner-pnl.tsx` + test.
Modify: `apps/core/src/modules/partners/{index,manifest}.ts`, `apps/web/src/router.tsx`,
`README.md` (the runbook section), this document's §7 and CLOSE.

**Acceptance.** No exported field resolves to a patients-table column, proven by walking the row
shape rather than by reading the code · no counter screen renders a sales figure · the P&L reads
zeros with the lanes off and does not error · the runbook names all five flags, their order, and
their gate · `pnpm verify` exit 0 · CI green by full SHA before close.

**ROUTINE means no mutants are owed** (AGENT-RULES §3). If this task NOTICES an assertion that
cannot discriminate — particularly the export-shape test, which is the kind that passes vacuously
when the shape is empty (§2.49) — it says so as a finding rather than building a mutant nobody
asked for. The export test therefore ships with a synthetic leg that CAN fail: a row shape
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
| _appended as each task lands_ | | | |

### Findings — this session's own, in the order they were found

### The independent reviewer (v3 §3.4 / EXECUTE-METHOD §4's discovery review)

### Mechanical verification

**Baseline, measured 2026-08-25 at `d7a8981` by detached `pnpm verify` with the exit VALUE read
from a file (rules 16–18): exit 0.** `apps/core` **166 suites / 1310 tests** · `apps/web`
**38 files / 210 tests** · `packages/contracts` **4 suites / 20 tests**. AGENT-RULES §4 governs
what happens to these: the workspace total must not decrease and no task's diff may delete a test.

### Actuals (v3 §6)

### Ledger entries this phase earned

### The ARCHIVE pass (v3 §5)
