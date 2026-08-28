# Plan 22a-1 — Payments: taking a rupee, and giving it back

**Written 2026-08-28 on the build host. NOT APPROVED FOR EXECUTION.** One ruling was taken at write time: **22a is two phase documents** (§1.2, RULED — the working document's seventeen tasks are a module build, and the safe minimum for taking money includes giving it back automatically). Everything else is locked in [`../brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md`](../brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md) §4.

**Roadmap:** Track C · milestone **M2** · register **R-261**. Consumed later by 23 · 24 · 26 · 27 · 16f — **this is the one payment adapter the house gets.** **Spec:** [`../specs/2026-08-10-hmis-architecture-design.md`](../specs/2026-08-10-hmis-architecture-design.md) §7 (billing, cash law C-2, E-24/25/26), §11.11 (money). **Working document:** [`../brainstorms/2026-08-27-patient-self-service/02-PLAN-22A-PAYMENTS.md`](../brainstorms/2026-08-27-patient-self-service/02-PLAN-22A-PAYMENTS.md) — the state machine, the two clocks, the three sources of truth and the 20-test golden suite. **Segment:** `05-S4-SETTLEMENT.md` — the channel collisions and 34 out-of-the-box cases. **This plan argues from those and does not restate them.**

**Slot: gated on 22c-C.** There is no cart to pay for until M1 closes.

**Executor seed (v3 §1):** this document, [`../AGENT-RULES.md`](../AGENT-RULES.md), ledger §5 (lines 1132–1146), and the working document's §2 (the state machine) and §12 (the golden suite). **Do not read [`reports/EXECUTION-LESSONS.md`](reports/EXECUTION-LESSONS.md) in full: 377,112 bytes ≈ 94,278 tokens, re-billed per tool call (v3 §9.1).** Entries that bite: §2.101, §2.115.

---

## THE LANE — ruled at write time, v3 §2

**LIGHT, and this phase is unusual: seven of nine tasks are CRITICAL.** That ratio is not caution, it is the honest description of a payment path — every task in it can lose real rupees, and the failure modes are silent. v3 §2 is explicit that the lane sets dispatch and not verification depth, so the lane stays LIGHT and the tiering carries the weight.

Main session codes task by task under AGENT-RULES; mutants per rule 21; CI watched by full SHA; reviewers **FRESH, not resumed** (v3 §9.5, ledger §2.115).

### Stop-loss (v3 §6): **730,000 tokens**, and the escalation is named rather than padded

- **Per-task rate — 20,178** (Plan 16a; [`../pipelines/token-baselines.json`](../pipelines/token-baselines.json)). Same known bias: for a LIGHT phase this is a review cost wearing an execution cost's clothes; main-session cost is unmeasurable (runbook **O3**).
- **Task term:** `1.5 × (20,178 × 9) = 272,403`.
- **Review term — TWO FRESH passes: `244,568 + 213,923 = 458,491`** (Plan 14 actuals; two fresh beat Plan 13's resumed chain).
- **Total: 730,894 → 730,000.**

**The escalation, stated so it is not taken silently.** A payment phase invites a third review pass, and padding the number to allow one would defeat what a stop-loss is for. So: **if the first pass finds a CRITICAL in T6 or T7, stop and get owner authorisation for a third fresh pass** rather than quietly exceeding. Those two tasks are where a defect is both most likely and most expensive.

### Context budget (v3 §9.2)

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | measure at kickoff | ≈ 8,000 |
| `AGENT-RULES.md` | 26,563 | 6,641 |
| ledger §5 only | ≈ 3,500 | 875 |
| working doc §2 + §12 | ≈ 6,000 | 1,500 |
| **NOT pointed at:** the ledger in full | 377,112 | **94,278** |

---

## 1. Why this phase

### 1.1 The point

The hospital can already take money — at a counter, into a drawer, under a cashier's session. This phase teaches it to take money from someone who is not standing in front of a cashier, **without breaking any of the machinery that makes the drawer trustworthy.**

That constraint is the whole difficulty. Plan 08's daily close, variance approval and cash-law episode all assume money arrives in a drawer. Online money must land in the same ledger and touch none of them.

### 1.2 THE SLICE — ruled at write time

The working document lists seventeen tasks. That is a module build. **22a is two phase documents:**

| | Phase | Scope |
|---|---|---|
| **this** | **22a-1** | Take a rupee and give it back automatically: migration, adapter + fake, intents, webhook, poll, the success transaction, the cart lock and counter defences, auto refund-to-source, card-testing defences |
| next | **22a-2** | Settlement reconciliation, the absence watcher, debit disputes and their counter surface, multi-cart splits, concessions and waivers, approval-gated manual refunds, payment links, degraded mode |

**Automatic refund-to-source is in this phase, not the next one.** Two of the golden suite's own rows require it — *paid but the booking lost its slot* and *hold expired, slot taken* — and a system that can take money it cannot return is not a safe minimum.

---

## 2. Ground truth — measured 2026-08-28, **re-measure at kickoff** (AGENT-RULES §6)

| fact | value | consequence |
|---|---|---|
| **the blocker** | `receipts.cashier_session_id text NOT NULL REFERENCES cashier_sessions(id)` | **T1.** Every rupee this system has taken came through a named cashier's drawer |
| `receipts` is **immutable** | it carries `BEFORE UPDATE OR DELETE` triggers, with `credit_note_lines` and `allocations` | An online receipt can never be edited — correct, and it means every online-money correction is a new row |
| **FK group** | `invoices`, `receipts`, `refund_vouchers` carry **real** FKs into `patients` (owner ruling R5) | A new payments table referencing any of them **joins the patients truncate statement** in `test/helpers/db.ts` — Postgres refuses to TRUNCATE a table an FK points at (§3.12) |
| **idempotency, already built** | `idempotency_keys (actor_id, route, key)` unique, `request_hash`, `response` replayed verbatim, claim deleted if the work failed | **T3 extends this; it does not invent one** |
| **tender lifecycle, already built** | `receipt_tenders.state`: `captured → reconciled \| mismatched`, `expected_net_paise` stamped at capture, `settled_paise` on reconcile | Built for counter UPI/card recon; the gateway settlement file fits it unchanged (22a-2) |
| receipts semantics | *"a bill payment and an advance are the SAME row — the difference is allocation"* | The late-landing case (working doc §4.1) needs no special path |
| tender modes | `cash \| upi \| card` | `channel` is added, **not** a new mode |
| counter recon exists | `POST` `reconUpload({ csv, source: 'upi'\|'card' })` | The gateway settlement file is a **third** source, not a variant of this |
| worker | `kernel/worker/` — `jobs.ts`, `scheduler.ts` | **T5's poll sweep has a home** |
| **claim pattern, already reasoned** | `notify/pump.ts` uses `FOR UPDATE SKIP LOCKED`, documents *why* the claim sits where it does, and flags a stuck row rather than re-sending it | T4/T5 follow it rather than inventing a claim placement |
| config | `feeBps { upi, card }`, `refundBankAbovePaise`, degraded tender mode (E-24) | Fee accounting and thresholds exist |
| cash law | C-2 excludes non-cash **at the SQL level** | Nothing to change. Everything to test |
| `@Public()` precedent | `auth.controller.ts`, each route throttled | The webhook's seam |

---

## 3. Spike — answered at kickoff, recorded in §6.3

| # | Question | Why it changes the work |
|---|---|---|
| **S1** | **What does the daily close do with a tender still in `captured` at close time?** | X-03: a payment in flight at 23:59 belongs to neither day. If the close blocks on it, T6 must resolve before the close runs — a sequencing constraint, not a preference |
| **S2** | Does `receipts`' immutability trigger permit `ALTER TABLE`, and what lock does dropping the `NOT NULL` take at production row counts? | Sizes T1's maintenance window |
| **S3** | Does `kernel/worker/scheduler.ts` support a job that claims rows, or only whole-job scheduling? | Decides whether T5 reuses the scheduler or borrows `pump.ts`'s claim directly |
| **S4** | Is `reconUpload`'s parser generic, or shaped to the counter's CSV? | Tells 22a-2 whether the settlement file reuses it |
| **S5** | Which roles hold refund and approval permissions today? | T8's automatic path must sit **below** them, not beside them |
| **S6** | Does any consumer read `receipts.cashier_session_id` without a null guard? | The audit T1 owes; a missed reader is a runtime crash on the first online receipt |

---

## 4. Design decisions

**DD1 — `channel`, not a tender mode.** `mode` answers *was it UPI or card* for `feeBps`; cash law asks *is it cash*. Both are orthogonal to where money was taken. `channel ∈ counter | online | kiosk` — **three values from the start**, because S4 established the kiosk POS settles on its own acquirer rail (22a-2 builds it; the column must not need a second migration).

**DD2 — A synthetic "online" cashier session is forbidden.** It would work on day one and then poison variance, daily close and every session-grouped report forever with a cashier who does not exist. The check constraint makes it impossible rather than discouraged.

**DD3 — The redirect is never consulted.** Truth comes from webhook, poll and settlement. The redirect updates a screen and nothing else. Any code that reads a query parameter to decide state is the defect.

**DD4 — The webhook records before it interprets.** Signature first; then persist the raw event; then process idempotently on `gateway_event_id`. Following `pump.ts`'s reasoning about claim placement rather than re-deriving it. **A payment event must never be lost because processing failed.**

**DD5 — State only moves forward.** A late webhook carrying an earlier state is persisted and marked `applied = false`. Out-of-order delivery is normal.

**DD6 — The fake adapter is a deliverable, not tooling.** No golden-suite row is runnable against a live gateway. The fake must be drivable into every state including the ones a real gateway makes hard to produce: lost redirect, webhook-before-redirect, duplicate delivery, forged signature, late settlement against a failed intent.

**DD7 — Automatic refunds sit below the approval threshold, never beside it.** T8 covers exactly two paths — *paid but the booking failed* and *hold expired, slot taken* — both hospital-fault, both below the auto-refund threshold (index §4 theme 18). Every other refund is 22a-2 and keeps its approval.

**DD8 — Card-testing defences are a launch requirement (X-07).** No endpoint accepts an amount; amounts derive only from a server-computed cart. Velocity limits per IP and per device. A gateway failure-rate alarm. **Without these we are a card-testing service for organised fraud, and the acquirer notices before we do.**

---

## 4A. ROUTED TO THE OWNER

**None at kickoff.** P-1 (Razorpay), P-2 (separate settlement account), P-3 (hospital absorbs the fee) and P-5 (the two-clock model) are all locked. S1's answer may impose a sequencing constraint between T6 and the daily close — a §6.3 finding.

---

## 5. Tasks

Nine. **Seven CRITICAL.**

### T1 — Migration `0039`: `channel`, the nullable session, and the payment tables — **ROUTINE**

`receipts.channel` (default `'counter'`), `cashier_session_id` nullable, the check constraint (working doc §1.2). `payment_intents`, `payment_events` (unique on `gateway_event_id`), `payment_refunds`. **Register the new tables in `test/helpers/db.ts`'s patients truncate group** if they carry an FK into the money group (§3.12). **Audit every reader of `cashier_session_id`** (S6).

### T2 — The adapter, Razorpay, and the fake — **CRITICAL**

Five functions: `createOrder` · `verify` · `refund` · `parseWebhook` · `fetchSettlement`. Everything gateway-specific behind them.

#### Assertion Book — T2

| # | Assertion | Mutant |
|---|---|---|
| A1 | `parseWebhook` verifies the signature over **raw bytes** | Parse to JSON and re-stringify before verifying → every legitimate webhook fails, or worse, a forged one passes |
| A2 | The fake can produce every golden-suite state (DD6) | Remove the lost-redirect mode → suite rows 2–4 become unrunnable and the phase ships untested |
| A3 | No gateway-specific type escapes the adapter boundary | Leak a Razorpay shape into the intent → the adapter stops being swappable, which is R-261's whole point |

### T3 — `payment_intents`, the state machine, idempotency — **CRITICAL**

#### Assertion Book — T3

| # | Assertion | Mutant |
|---|---|---|
| A4 | The amount is server-computed and frozen at `initiated` | Accept a client amount → the patient pays what they choose |
| A5 | A second create for the same cart returns the first intent | Create a new one → two live intents, two charges |
| A6 | `pending` cannot be cancelled | Allow it → cancel races a debit and the money is unattributable |
| A7 | State never moves backward (DD5) | Apply a late `pending` webhook → a succeeded payment un-succeeds and the booking evaporates |
| A8 | `succeeded` is terminal; refunds are child rows | Rewind on refund → the ledger loses the fact that money was ever taken |

### T4 — The webhook — **CRITICAL**

#### Assertion Book — T4

| # | Assertion | Mutant |
|---|---|---|
| A9 | Signature verified **before** any state is read | Verify after loading the intent → an unauthenticated caller enumerates intents by probing |
| A10 | The raw event is persisted before processing (DD4) | Process first → a handler crash loses a payment event permanently |
| A11 | Five deliveries of one event produce **one** receipt | Drop the `gateway_event_id` uniqueness → five receipts, five allocations, one payment |
| A12 | A rejected signature appends `payment.webhook_rejected` and changes nothing else | Silently 200 → a forgery campaign is invisible |
| A13 | The endpoint responds fast enough not to trigger gateway retries | Do the success transaction inline before responding → retries pile onto a slow path and multiply |

### T5 — The verify/poll sweep — **ROUTINE**

Any intent in `initiated`/`pending` past its window is verified against the gateway. Runs on `kernel/worker`, claiming with `FOR UPDATE SKIP LOCKED` per `pump.ts`. A row that cannot be resolved is **flagged, never retried forever** — `pump.ts`'s stuck-row discipline.

### T6 — The success transaction — **CRITICAL**

Intent → receipt → tender → allocation → booking, in one transaction. **The riskiest task in the phase.**

#### Assertion Book — T6

| # | Assertion | Mutant |
|---|---|---|
| A14 | All six steps commit together or none do | Commit the receipt outside the transaction → money recorded against a booking that does not exist |
| A15 | The receipt has `channel='online'` and `cashier_session_id IS NULL` | Attach a session → the drawer's variance inherits money nobody counted |
| A16 | Booking lost its slot ⇒ receipt still written, allocation omitted, refund raised | Refuse to write the receipt → **we hold money with no record of it** |
| A17 | `fee_unsettled` clears the instant the transaction commits | Clear it in a follow-up job → a paid patient is stopped at the consult door |
| A18 | A `revisit` never reaches this path at all | Allow a zero-amount intent → we charge for a free visit and refund it at the desk |
| A19 | The cash-law C-2 episode is unchanged by any online tender | Include `channel='online'` in the cash sum → a family hits a PAN threshold on money that left a bank |

### T7 — The cart lock, counter visibility, and void-to-take-cash — **CRITICAL**

Ordered `FOR UPDATE` on the cart row from every money path. The cashier's screen reads live intent state.

#### Assertion Book — T7

| # | Assertion | Mutant |
|---|---|---|
| A20 | A cashier **cannot** take cash against a `pending` intent (S4-R1) | Allow it → the double-collection case, which is the most common real-world payment complaint |
| A21 | Taking cash against `draft`/`initiated` voids the intent atomically | Void in a second statement → the gap is the race |
| A22 | Two counters on one cart: exactly one succeeds, the other is told why | No lock → both take money |
| A23 | A webhook landing mid-counter-transaction wins; the counter fails cleanly | Let the counter win → money is recorded twice and one of them has no gateway record |

### T8 — Automatic refund-to-source — **CRITICAL**

Exactly the two hospital-fault paths (DD7), idempotent, below the approval threshold.

#### Assertion Book — T8

| # | Assertion | Mutant |
|---|---|---|
| A24 | A refund is idempotent on its own key | Retry without one → a double refund, which is worse than a double charge |
| A25 | An online payment cannot be refunded as counter cash | Allow the counter rail → the stolen-instrument laundering path |
| A26 | An automatic refund above the threshold is refused and escalated | Auto-refund any amount → the approval gate is decorative |
| A27 | A refund never rewinds the intent's state | Set `failed` on refund → the ledger forgets the money was taken |

### T9 — Card-testing defences and the golden suite — **CRITICAL**

DD8's three defences, then the working document's twenty rows, all green.

#### Assertion Book — T9

| # | Assertion | Mutant |
|---|---|---|
| A28 | No endpoint accepts an amount from the client | Add one "for testing" → the classic public-checkout abuse |
| A29 | Velocity limits fire per IP and per device | Limit per patient only → an anonymous checkout is unlimited |
| A30 | A failure-rate spike raises an alarm | Log only → the acquirer tells us first |

---

## 6. CLOSE

*(Filled by the executing session.)*

### 6.1 The commits
### 6.2 Findings
### 6.3 Spike answers S1–S6 — especially S1's sequencing constraint against the daily close
### 6.4 The golden suite, twenty rows, with evidence
### 6.5 Mechanical verification
### 6.6 The independent close review — and whether a third pass was authorised (§ stop-loss)
