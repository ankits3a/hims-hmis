# Plan 22a-2 — Reconciliation, disputes, concessions, and the refund rails

**Written 2026-08-28 on the build host. NOT APPROVED FOR EXECUTION.** Two rulings were taken at write time, both from reading Plan 08 rather than from preference: **gateway refunds and refund vouchers are different objects that meet at the approval** (DD1, RULED) and **a concession is a credit note, never a reduced price** (DD2, RULED). Everything else is locked in [`../brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md`](../brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md) §4.

**Roadmap:** Track C · milestone **M2**, second half · register **R-261**. **Spec:** [`../specs/2026-08-10-hmis-architecture-design.md`](../specs/2026-08-10-hmis-architecture-design.md) §7 (billing, the two-never-mix seam, E-25/26), §11.11. **Working document:** [`../brainstorms/2026-08-27-patient-self-service/02-PLAN-22A-PAYMENTS.md`](../brainstorms/2026-08-27-patient-self-service/02-PLAN-22A-PAYMENTS.md) §8, §12. **Segment:** `05-S4-SETTLEMENT.md` §8 (the out-of-the-box cases, several of which land here).

**Slot: gated on 22a-1.** Money must be takeable before it is reconcilable.

**Executor seed (v3 §1):** this document, [`../AGENT-RULES.md`](../AGENT-RULES.md), ledger §5 (lines 1132–1146). **Do not read [`reports/EXECUTION-LESSONS.md`](reports/EXECUTION-LESSONS.md) in full: 377,112 bytes ≈ 94,278 tokens, re-billed per tool call (v3 §9.1).** Entries that bite: §2.101, §2.115.

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Eight tasks, one migration, **five CRITICAL**. Lower than 22a-1's seven-of-nine because three of these tasks compose shipped machinery — the approval kernel, the credit-note grammar, the tender reconcile lifecycle — rather than building new seams. The lane does not set verification depth (v3 §2); money still gets mutants.

Main session codes task by task under AGENT-RULES; mutants per rule 21; CI watched by full SHA; reviewers **FRESH, not resumed** (v3 §9.5, ledger §2.115).

### Stop-loss (v3 §6): **700,000 tokens**

`1.5 × (20,178 × 8) = 242,136` + two fresh passes `244,568 + 213,923 = 458,491` = **700,627 → 700,000.** Same known bias as every LIGHT phase in this series: the baseline rate is a review cost wearing an execution cost's clothes; main-session cost is unmeasurable (runbook **O3**).

### Context budget (v3 §9.2)

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | measure at kickoff | ≈ 7,500 |
| `AGENT-RULES.md` | 26,563 | 6,641 |
| ledger §5 only | ≈ 3,500 | 875 |
| **NOT pointed at:** the ledger in full | 377,112 | **94,278** |

---

## 1. Why this phase

22a-1 can take a rupee and give it back when the hospital is at fault. It cannot yet tell
whether the money actually arrived, cannot show a cashier a disputed debit, cannot split a
family's payment, cannot forgive a fee, and cannot refund anything a human has to decide.

**This phase is where online money stops being a separate world.** At close, a rupee taken
by a gateway is reconciled, disputable, refundable and forgivable through the same
machinery as a rupee taken across a counter.

---

## 2. Ground truth — measured 2026-08-28, **re-measure at kickoff** (AGENT-RULES §6)

| fact | value | consequence |
|---|---|---|
| **refund-to-payer identity already exists** | `refund_vouchers.payee_name`, `payee_id_type`, `payee_id_ref` — *"mandatory at PAY time"* | T6 extends a discipline; it does not invent one |
| **`refund_vouchers.approval_id` is `NOT NULL`** | every voucher carries an approval | **DD1** — 22a-1's automatic refunds therefore cannot be vouchers, and are not |
| refund methods today | `'cash' \| 'bank_transfer'` | Gains `'to_source'` |
| refund guards, shipped | `reason_class` (`mistake\|genuine`, guard 4), `guard_flags` (terminal_encounter / delivered_line, guards 2+3) | A gateway refund passes the same guards |
| **a discount precedent exists** | `credit_notes` kind `clearance_discount`, approval type `billing_clearance_discount`, on the **adjustment** side of §7's *"the two never mix"* seam | **DD2** — a concession follows this shape exactly |
| **approval bands can be cumulative** | `kernel/approvals/cumulative.ts` → `cumulativeAmount(tx, q)` | **DD3** — a ceiling that cannot be split |
| approvals API | `registerApprovalType`, `listApprovals`, `approveRequest`, `rejectRequest` | T5/T6 register types; they do not build a workflow |
| **an orphan scan already exists** | `daily-close.ts` → `orphanScan` flags an **encounter with a fee service and no charge**; a second run appends no duplicate | **DD4** — ours is a *different* orphan and must not share the name |
| tender reconcile lifecycle | `captured → reconciled \| mismatched`, `expected_net_paise` at capture, `settled_paise` on reconcile | T2 fills this in, unchanged |
| counter recon | `reconUpload({ csv, source: 'upi'\|'card' })` | The gateway file is a third source |
| `receipts.patient_id` | `NOT NULL`, real FK (ruling R5) | **DD6** — one intent over two patients is two receipts |

---

## 3. Spike — answered at kickoff, recorded in §6.3

| # | Question | Why it changes the work |
|---|---|---|
| **S1** | Does `cumulativeAmount` support *per-approver, per-rolling-window*? | DD3's ceiling depends on it. If it only aggregates per-patient, T5 needs a window query of its own |
| **S2** | What does the shipped `orphanScan` do with an encounter whose charge was settled online? | A false orphan on every self-service visit would be a daily-close full of noise from day one |
| **S3** | Can `refund_vouchers` take `method='to_source'` without disturbing the cash-drawer path or the daily close? | Decides whether T6 extends the table or sits beside it |
| **S4** | Settlement file format, cadence and re-issue behaviour for the chosen gateway | T2 cannot be specified without it. **Action P-1 before kickoff** |
| **S5** | Is `reconUpload`'s parser generic or shaped to the counter CSV? | Reuse versus a second parser |
| **S6** | What does `registerApprovalType` require, and which roles resolve to the three concession bands? | T5's band configuration is data, not code |

---

## 4. Design decisions

**DD1 — RULED: gateway refunds and refund vouchers are different objects that meet at the approval.** `refund_vouchers.approval_id` is `NOT NULL`, so 22a-1's automatic hospital-fault refunds cannot be vouchers — they are `payment_refunds`, the payment module's own object, and they are correct to be. **A *manual* refund of an online payment creates both:** a `refund_voucher` carrying Plan 08's approval, guards, reason class and payee identity, whose payment leg executes through the gateway with `method='to_source'`. The voucher is the decision; the `payment_refunds` row is the movement.

**DD2 — RULED: a concession is a credit note, never a reduced price.** The invoice records what the service costs; the concession records what the hospital chose to forgive. This follows the shipped `clearance_discount` precedent exactly, on the **adjustment** side of §7's *"the two never mix"* seam. Typing a smaller number into an amount field would make waived revenue invisible, uncountable and unauditable — and it is what every hospital's spreadsheet-era system did.

**DD3 — Concession ceilings are cumulative, so they cannot be split.** A supervisor with a ₹500 ceiling must not be able to waive ₹400 twenty times in an afternoon. `cumulativeAmount` exists for exactly this class of rule (S1).

**DD4 — Two different orphans, and the names must not collide.** The shipped **charge orphan** is *an encounter with a fee and no charge*. Ours is a **credit orphan**: *money settled with no intent*. Different scans, different tables, different reports. Reusing the word would make one report answer a question nobody asked.

**DD5 — The absence watcher: a reconciliation run that did not happen is itself the alarm.** A silent three-day gap is the failure mode, not a mismatch. The series names this class explicitly — an absence is the signal — and it is cheap here because the run has a cadence.

**DD6 — A multi-patient payment produces one receipt per patient.** `receipts.patient_id` is `NOT NULL` with a real FK (ruling R5), so mother and child settled from one intent is two receipts, two allocations, from a split **computed once and stored** — never recomputed at settlement, where a tariff change would silently redistribute it.

**DD7 — The debit-dispute surface is counter-first.** The patient raises it, but **the cashier is who needs it**: the patient will arrive holding a bank SMS, and today the cashier is blind. Build the counter view before the patient view.

**DD8 — Payment links carry no PHI, expire, and are single-intent.** Paying one is not an identity claim, so a forwarded link is not a leak.

**DD9 — The kiosk POS rail is not in this phase.** It is blocked on **O-2** (Pine Labs integration mode) and belongs to 22-K. `channel` already carries the value so no migration follows it.

---

## 4A. ROUTED TO THE OWNER

**S4 requires P-1 to be actioned** — the gateway must be chosen and a sandbox account opened before T2 can be specified. The decision is locked (Razorpay); the *account* is an owner action. **O-3** (concession ceilings) needs the owner's three rupee figures before T5 configures its bands; the recommended defaults (₹500 / ₹5,000 / owner) stand until then.

---

## 5. Tasks

Eight. Five CRITICAL.

### T1 — Migration `0040`: settlement lines, disputes, splits, concessions — **ROUTINE**

`payment_settlement_lines` (unique on settlement reference, for re-issue idempotency) · `payment_debit_disputes` · `payment_intent_splits` · `refund_vouchers.method` gains `'to_source'` · the concession credit-note kind and its approval type. Register FK-bearing tables in the patients truncate group (§3.12).

### T2 — Settlement parse, reconciliation, and the absence watcher — **CRITICAL**

#### Assertion Book — T2

| # | Assertion | Mutant |
|---|---|---|
| A1 | A settlement line matching a `succeeded` intent reconciles its tender and stamps `settled_paise` | Skip the stamp → `expected_net_paise` never verifies and fee variance is invisible forever |
| A2 | A line matching a `failed` or `pending` intent drives it to `succeeded` through 22a-1's transaction | Ignore it → **money we hold, against a booking we refused** |
| A3 | A line matching nothing raises a **credit orphan** (DD4) | Log it → the money is unattributable and nobody is told |
| A4 | A re-issued settlement file is idempotent on its reference | Reprocess → every reconciled tender is double-counted |
| A5 | A `succeeded` intent with no settlement line after N days raises an exception | Only check the other direction → we never learn that money we recorded never arrived |
| A6 | **A reconciliation run that did not happen raises an alarm** (DD5) | Alarm only on mismatch → a three-day silent gap looks like three clean days |
| A7 | Fee variance beyond tolerance is an exception a human works | Absorb it → the gateway's rate can drift and nobody notices |

### T3 — Debit disputes and the counter surface — **CRITICAL**

Lifecycle `raised → bank_reversed | credited_late | written_off`. Counter view first (DD7).

#### Assertion Book — T3

| # | Assertion | Mutant |
|---|---|---|
| A8 | A cashier finds a disputed debit by phone or UHID in one search | Patient-app only → the cashier is blind at the exact moment the patient is angriest |
| A9 | A dispute never alters the intent's state | Mark the intent `succeeded` on a claim → an unverified patient statement creates money |
| A10 | A late settlement credit auto-resolves the dispute to `credited_late` | Leave it open → a resolved case sits on a worklist forever |
| A11 | Raising a dispute does not release or re-take the slot | Couple them → a booking moves on a bank's timetable |

### T4 — Multi-cart splits — **CRITICAL**

#### Assertion Book — T4

| # | Assertion | Mutant |
|---|---|---|
| A12 | One intent over two carts produces **two** receipts, one per patient (DD6) | Write one receipt → the FK forces a patient choice and the other patient's money is unattributed |
| A13 | The split is stored, never recomputed | Recompute at settlement → a tariff change between capture and settlement silently redistributes the money |
| A14 | Σ splits equals the intent amount, to the paise | Round each independently → the classic one-paise leak, on every family payment |
| A15 | One cart's booking failing leaves the other confirmed; the failed split refunds | Fail both → a mother loses her slot because her child's was taken |

### T5 — Concessions and waivers — **CRITICAL**

A credit note of a new kind (DD2), approval-gated with cumulative bands (DD3), reason-classed, visible in the daily close.

#### Assertion Book — T5

| # | Assertion | Mutant |
|---|---|---|
| A16 | A concession is a credit note; the invoice amount is untouched | Reduce the invoice → forgiven revenue becomes invisible and uncountable |
| A17 | The band is evaluated **cumulatively** per approver per window | Evaluate per transaction → ₹400 twenty times clears a ₹500 ceiling |
| A18 | A concession without an approval cannot exist | Allow a direct write → the tiering is decorative |
| A19 | Every concession carries a reason class, never free text | Free text → the daily close cannot summarise and the pattern is unauditable |
| A20 | Concessions appear in the daily close and the day book | Omit them → the day's revenue picture is wrong in the one direction that matters |

### T6 — Manual refunds: the three rails — **CRITICAL**

Voucher + gateway leg per DD1. SoD on manual refunds; payee identity at pay time; the X-01 threshold.

#### Assertion Book — T6

| # | Assertion | Mutant |
|---|---|---|
| A21 | A manual refund of an online payment produces a voucher **and** a gateway refund | Voucher only → the paper says refunded and the money never moved |
| A22 | An online payment cannot be refunded as counter cash | Allow the cash rail → the stolen-instrument laundering path |
| A23 | Requester ≠ approver ≠ payee on every manual refund (X-10) | Collapse any two → an insider refunds to their own instrument |
| A24 | Above ₹10,000 with a payer outside the patient's household, a counter identity check is required (X-01) | Skip it → refund-to-source returns the money to the tout who paid |
| A25 | Refunds are idempotent on their own key | Retry without one → a double refund, which is worse than a double charge |
| A26 | Below ₹50 the patient's account is credited instead (S4-R4) | Refund anyway → the fee exceeds the refund |

### T7 — Payment links — **ROUTINE**

Issued from the counter and the call centre against an existing cart. No PHI, expiring, single-intent (DD8). **The most useful counter feature in the design, and nearly free once 22a-1 exists.**

### T8 — Degraded mode and the e2e — **ROUTINE**

Gateway unreachable → pay-later stays open, the truth is stated, the booking is never lost (Plan 08's E-24 posture). Gateway account suspended (X-29) is the same posture with a louder alarm — **the counter is unaffected, which is the argument for never letting online become the only rail.**

Two e2e: *pay online → settlement file → tender reconciled → daily close correct*; and *pay online → manual refund → voucher approved → gateway refund → ledger balanced*.

---

## 6. CLOSE

*(Filled by the executing session.)*

### 6.1 The commits
### 6.2 Findings
### 6.3 Spike answers S1–S6 — especially S2's false-orphan risk and S4's file format
### 6.4 The Assertion Book, corrected by execution
### 6.5 Mechanical verification, including the full 20-row golden suite from 22a-1 still green
### 6.6 The independent close review — **and the M2 milestone close**
