# S4 · Settlement — segment deep-dive
**Date:** 2026-08-28 · **Status:** working document, not approved
**Plan:** 22a (+ Plan 08 changes) · **Parent:** `03-JOURNEY-SEGMENTS.md` §5 · **Engine:** `02-PLAN-22A-PAYMENTS.md`

---

## 1. Scope

`02-PLAN-22A-PAYMENTS.md` is the **engine** — the intent, its states, the gateway. This
document is the **segment**: how money behaves when a real patient moves between channels,
and what breaks at every seam.

**Exit contract.** A receipt, **or** a pay-later booking with a stated deadline. Findable by
receipt no · UHID · booking no, **from the counter, instantly.** That last clause is where
double collection lives.

---

## 2. Channels

| Capability | `SELF` | `KIOSK` | `CNTR` | `CALL` |
|---|:--:|:--:|:--:|:--:|
| Pay by gateway (UPI/card/netbanking) | ✅ | — | — | link |
| Pay by physical POS | — | ✅ | ✅ | — |
| Pay cash | — | ❌ | ✅ | — |
| See a live intent's state | own | own | **all** | all |
| **Void a live intent to take cash** | — | — | ✅ | — |
| Send a payment link | — | — | ✅ | ✅ |
| Refund to source | — | — | request | request |
| Refund cash | — | — | ✅ | — |
| Print a receipt for an online payment | view | ✅ | ✅ | — |
| See a disputed debit | own | — | ✅ | ✅ |
| Apply a concession/waiver | — | — | ✅ approval | — |

**Three settlement rails, not two.**

| Rail | Channel | Reconciles against | Cashier session |
|---|---|---|---|
| Counter | cash · POS at a desk | The drawer + the existing CSV upload | **Yes** |
| Online | gateway | The gateway settlement file | **No** |
| **Kiosk** | Pine Labs POS, unattended | **The POS batch report — a third file** | **No** |

The kiosk is not "online with a card reader" and not "a counter without a person". It
settles on the POS acquirer's rail, so `channel` is `counter | online | kiosk`.

---

## 3. The channel collisions

Four races. All are resolved by the same discipline the materials ledger already uses:
**an ordered `FOR UPDATE` lock on the cart row**, taken by every path that can move money.

### 3.1 Online started, then cash at the counter

The most common. The rule depends entirely on the intent's state — which is exactly why
`initiated` and `pending` are separate states:

| Intent state | Cashier may take cash? | Behaviour |
|---|---|---|
| `draft` / `initiated` | ✅ | **Void the intent atomically, then take cash.** Nothing was attempted |
| `pending` | ❌ | **"An online payment is in progress. Wait, or ask the patient to complete it."** Money may already be moving — taking cash here is how you double-collect |
| `succeeded` | ❌ | **"Already paid online"**, with the receipt shown |

### 3.2 The reverse race — money lands mid-transaction

The cashier has the drawer open and the cash counted when the patient's earlier UPI settles.

**The webhook wins.** Money is money; we never refuse to record it. The counter transaction
fails on its lock with *"this was just paid online"* and the cashier returns the cash. Ugly
at the desk, correct in the ledger — and vastly better than the alternative.

### 3.3 Two counters

Patient gets impatient at counter 1 and goes to counter 2. Same lock, one winner, and the
loser's screen says why.

### 3.4 Kiosk POS against a pending online intent

Patient taps a card at the kiosk while a UPI collect is outstanding. Same rule as §3.1 —
the kiosk must read intent state before arming the terminal.

---

## 4. The kiosk POS rail

### 4.1 The failure that has no human in it

**The POS approves and the kiosk app crashes before recording.** The acquirer has the
money; we have no record; and there is nobody at the kiosk to complain to.

Three defences, in order of importance:

1. **Record the intent *before* arming the terminal**, carrying the POS reference. Even if
   the app dies mid-transaction the intent exists, and the POS batch reconciliation finds
   its counterpart the next morning.
2. **Integration mode decides how bad this is.** A cloud-API POS gives us a callback
   independent of the kiosk process; a local ECR link dies with the app. **This is why the
   Pine Labs integration mode is a blocking procurement question, not a detail.**
3. **The kiosk prints or displays a dispute reference** on any ambiguous outcome, so the
   patient walks to a counter with something in their hand.

### 4.2 Other kiosk-specific cases

- POS declines but the patient is debited — **failed-but-debited with no cashier present.**
  The dispute record must be raisable by the kiosk itself.
- Terminal battery dies mid-transaction.
- Someone unplugs the kiosk between approval and print.
- The patient walks away without their slip — the booking is real regardless; the slip is a
  pointer.

---

## 5. Multi-cart settlement

Mother and child in one visit. Carts stay **one patient each** (the wrong-patient defence,
E9) — so one payment must settle a **set** of carts.

```
payment_intents.cart_refs : text[]          -- a set, not a single reference
payment_intent_splits     : intent_id, cart_ref, patient_id, amount_paise
```

The split is **computed once and stored**, never recomputed at settlement.

`receipts.patientId` is `NOT NULL` (Plan 08 ruling R5), so a multi-cart intent produces
**one receipt per patient**, not one receipt for the payment. Intent → N receipts → N
allocations. A refund of one cart refunds that split, not the whole intent.

**Partial success:** if one booking confirms and the other loses its slot, the successful
one proceeds and the failed one's split becomes an unallocated advance on that patient plus
an automatic refund — §4.1 of the payments doc, applied per split.

---

## 6. Payer ≠ patient ≠ account holder ≠ invoice-to

Four distinct parties, routinely different people:

| Party | Example |
|---|---|
| **Patient** | The mother receiving care |
| **Payer** | The son, whose UPI was charged |
| **Account holder** | The daughter, on whose phone the app session runs |
| **Invoice-to** | The son's employer, for reimbursement |

Refund-to-source resolves payer identity **automatically** for online money — it returns to
the instrument that paid. Manual refunds are where Plan 08's refund-to-payer identity check
has to bite.

**Invoice-to is a separate field from patient**, and it is a real and frequent request
(corporate reimbursement). It must not be modelled by editing the patient's name.

---

## 7. Money that never touches a gateway

| Path | Behaviour |
|---|---|
| **Free revisit** | Resolved **before** money is requested. Plan 08 already branches new/renewal; the app must call the same resolver or we charge and refund all day |
| **Zero-rupee** | Membership or package covers it: `draft → succeeded`, no gateway, but a booking, an invoice and an allocation all exist |
| **Pay-later** | No intent at all. A booking, a deadline, a stated consequence |
| **TPA / corporate** | A booking with no patient payment, and the desk must not chase it |
| **Concession / waiver** | **New, and it exists in every real hospital.** Approval-gated, reason-classed, visible in the daily close. Not a discount typed into an amount field |
| **Existing advance** | Allocated from the patient's credit; `receipts` already treats a payment and an advance as one row |

---

## 8. Out of the box

Cases that do not appear on anyone's checklist. Several of them question decisions we have
already made in this series, which is why they are here.

### 8.1 These challenge our own design

| # | Scenario | Why it bites |
|---|---|---|
| **X-01** | **A tout at the gate pays for the patient's appointment from his own UPI.** | **Refund-to-source is our anti-fraud control (§7 of the payments doc) — and here it refunds the tout, not the patient.** The control and the harm point the same way. Recommend: refunds above a threshold on a payer who is not in the patient's household require a counter identity check, refund-to-source notwithstanding |
| **X-02** | **A family pays ₹1.9L cash in one day across four patients at three counters.** | The C-2 cash episode grain is **per patient per IST day** (shipped). A family splitting across members evades it while the hospital receives ₹1.9L from one household. **Is the episode grain right?** Raise with counsel — this is a shipped design, not a new one |
| **X-03** | **The daily close runs while a payment is `pending`.** | Plan 08's close assumes money is either in the drawer or not. An intent in flight at 23:59 belongs to neither day. Recommend: close never blocks on pending intents; they settle into the day their **capture** timestamp falls in, and the close reports them separately |
| **X-04** | **A refund costs more in gateway fees than the refund itself.** | A ₹5 correction is not worth a ₹3 fee and a settlement line. Recommend: a floor below which the hospital credits the patient's account instead, stated in the refund policy JSON |
| **X-05** | **The doctor tells the patient "don't pay, I'll handle it."** | The classic revenue-leakage path, and no software prevents it. What software *can* do: `fee_unsettled` stays true, the visit shows on the dues worklist, and the doctor's name is on it. Make it visible rather than pretending it cannot happen |
| **X-06** | **A patient pays for a slot, then the fee is reduced before the visit.** | Do they get the difference? We ruled the displayed fee binds for the hold (R-14) — that protects *us* on an increase. Symmetry says it protects the patient on a decrease too. Recommend: no automatic adjustment, but the counter may issue a credit note on request |

### 8.2 Adversarial

| # | Scenario | Required behaviour |
|---|---|---|
| **X-07** | **Card testing.** A fraudster uses our public checkout to validate stolen card numbers — small amounts, high volume. **The standard abuse of any public payment page, and nobody plans for it.** | No arbitrary-amount endpoint ever; amounts derive only from a real cart. Per-IP and per-device velocity limits. A failure-rate alarm on the gateway. This is a launch requirement, not a hardening task |
| **X-08** | Refund farming — book, pay, cancel inside the free window, repeatedly | Cancellation counters per household; the policy tightens after N |
| **X-09** | Chargeback abuse — pay, receive care, dispute | The encounter is the evidence. `payment_events` retains the raw payload for exactly this |
| **X-10** | **An insider issues a manual refund to their own instrument** | Refund-to-source blocks it online; a *manual* refund does not. Manual refunds need SoD (requester ≠ approver ≠ payee) and a payee-identity check |
| **X-11** | A payment link from the call centre is intercepted or forwarded | The link carries no PHI, expires, and is single-intent. Paying it is not an identity claim |
| **X-12** | A patient shows a ₹300 receipt for a ₹2,500 service | The receipt names the service, the doctor and the date. A bare amount is forgeable |
| **X-13** | A doctor's fee is mistyped as ₹0 and a hundred people book free | A tariff sanity gate: a change crossing a percentage band needs a second person, like any Class-A act |

### 8.3 Time, calendar and money physics

| # | Scenario | Required behaviour |
|---|---|---|
| **X-14** | Payment captured at 23:58, settled at 00:02 | One timestamp is authoritative for the accounting day — **capture**, not settlement, not redirect. Stated once, tested |
| **X-15** | **A payment straddles the financial-year boundary on 31 March** | Invoice series, GST period and the settlement file all roll differently. The invoice belongs to the day of supply; the settlement can land in the next FY |
| **X-16** | Diwali: the hospital is open, banks are closed, settlement is delayed three days | Reconciliation exceptions must tolerate a multi-day gap without alarming. Bank-holiday-aware |
| **X-17** | **An NRI pays with an international card** | FX means the **settled amount differs from the charged amount**, and the patient's bank may decline an Indian merchant outright. The tender must record charged and settled separately |
| **X-18** | GST rounding produces a half-paise | One rounding rule, at one place, tested to the paise. `assertPaise` at every boundary |
| **X-19** | Patient overpays by ₹1 (UPI permits it in some flows) | The excess becomes an advance. Never silently absorbed |
| **X-20** | A package covers four consults; this is the fifth | Partial coverage: part allocation, part payable. The arithmetic must be explicit, not emergent |

### 8.4 People, and what actually happens in a hospital

| # | Scenario | Required behaviour |
|---|---|---|
| **X-21** | **A patient dies between paying and attending** | Refund to whom? Not the deceased. `deceasedAt` is a hard stop on messaging, so the family cannot even be told automatically. Recommend: a counter-only path, identity of the claimant verified, approval-gated. **This will happen and there is no graceful automation of it** |
| **X-22** | An employer pays and the patient must not see the corporate rate | Invoice-to ≠ patient, and the patient's copy shows the service, not the negotiated price |
| **X-23** | A politician's office calls to waive a fee | The concession path (§7): approval-gated, reason-classed, visible in the close. Never an amount typed over |
| **X-24** | Two patients with the same name in one household; the payer picks wrong | Age-to-day and UHID on the confirm screen — the same defence as S3-04 |
| **X-25** | A patient insists on a cash refund for an online payment made three weeks ago and misremembers | The receipt shows the channel. The refusal is explainable in one sentence with the receipt in hand |
| **X-26** | A patient is admitted (IPD) between booking and attending an OPD slot | The advance follows the patient, not the encounter |
| **X-27** | Pharmacy dues and OPD dues on one patient; one payment arrives | Allocation is explicit and patient-visible. Never oldest-first by silent default |
| **X-28** | A patient pays against a **wrong UHID** typed at a counter | Money lands on a stranger's ledger. Detectable (an advance on a patient with no visit that day) and correctable by reallocation, not deletion |

### 8.5 Operations

| # | Scenario | Required behaviour |
|---|---|---|
| **X-29** | **The gateway suspends the merchant account** for a compliance review | A whole-hospital money outage on someone else's timetable. Degraded mode must be a *posture*, not a panic — and the counter is unaffected, which is the argument for never letting online become the only rail |
| **X-30** | The bank account changes | Settlement fails silently until someone notices. The reconciliation exception must fire on **absence**, not only on mismatch |
| **X-31** | The settlement file format changes after a gateway API version bump | Parse failures are exceptions with the raw file retained, never a skipped day |
| **X-32** | Two settlement files for the same day (a re-issue) | Idempotent on settlement reference |
| **X-33** | The reconciliation job fails silently for three days | **An absence watcher** — no reconciliation run is itself the alarm. The series calls these negative-space watchers |
| **X-34** | The hospital's GSTIN changes | Invoice series and tax rendering both move; historical documents keep the old one |

---

## 9. Rulings this segment needs

| # | Question | Recommendation |
|---|---|---|
| **S4-R1** | May a cashier take cash against a `pending` intent? | **No.** Wait or complete. This single rule prevents most double collection |
| **S4-R2** | Refund threshold above which a non-household payer needs an identity check (X-01) | Yes — recommend the same ₹10k Plan 08 already uses for bank transfers |
| **S4-R3** | Is the C-2 cash episode grain per patient or per household? (X-02) | **Raise with counsel.** Questions a shipped design; do not change it on our own judgment |
| **S4-R4** | Minimum refund amount; below it, credit the account (X-04) | Recommend ₹50 |
| **S4-R5** | Fee reduced after payment (X-06) | No automatic adjustment; counter may credit on request |
| **S4-R6** | Refund on death (X-21) | Counter-only, claimant verified, approval-gated |
| **S4-R7** | Multi-patient payment allowed at all? | **Yes** — it is the normal family case, and refusing it sends them to two queues |
| **S4-R8** | Concession/waiver approver and ceiling | Needed before go-live; every hospital does this from week one |

---

## 10. Build order within S4

1. **The cart lock** — ordered `FOR UPDATE` on every money path (§3). Without it every other
   task races
2. **Counter visibility of intent state** — the cashier's screen (§3.1). This is the double
   collection defence and it is mostly a read
3. **Void-intent-to-take-cash**, atomic
4. Multi-cart splits (§5) — cheap now, structural later
5. Concession/waiver path (§7) — needed from week one, always forgotten until week three
6. Kiosk POS rail (§4) — **blocked on the Pine Labs integration mode**
7. Card-testing defences (X-07) — a launch requirement, not hardening

**Do not open online payment before 1, 2, 3 and 7.** Without the first three you double-collect;
without the fourth you become a card-testing service for organised fraud.
