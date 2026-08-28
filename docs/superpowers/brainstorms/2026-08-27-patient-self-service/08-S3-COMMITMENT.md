# S3 · Commitment — hold, bind, cart — segment deep-dive
**Date:** 2026-08-28 · **Status:** working document, not approved
**Plan:** 22c-C · **Parent:** `03-JOURNEY-SEGMENTS.md` §4 · **Phase doc:** `../../plans/2026-08-28-phase1-22cC-browse-and-book.md`

---

## 1. Scope

S3 is the gap between *"I want that slot"* and *"the hospital has agreed"*. It exists at all
because self-service opens a gap the counter never had: at a desk, choosing and paying are
the same ten seconds.

**Exit contract.** A **hold** and a **cart** bound to exactly one patient, findable by
phone · UHID · QR · cart id, and convertible by any channel.

---

## 2. The hold is the segment

Everything else here is a form. The hold is a *promise made to one patient at the expense
of everyone else*, and every property it needs follows from that sentence.

| Property | Why |
|---|---|
| It blocks other bookers | Otherwise it is not a promise |
| It expires on its own | Otherwise one abandoned browse takes a 9 a.m. cardiology slot off the market forever |
| It is reclaimable by its owner | A dropped connection must not cost the slot the patient is about to pay for |
| It is convertible at a counter | The patient may walk in and finish there (the design law) |
| It costs nothing to abandon | Which is exactly why it must be capped and expired |

### 2.1 State

```
      hold requested
            │
      ┌─────▼─────┐   TTL 10 min     ┌──────────┐
      │   held    ├─────────────────►│ released │
      └─────┬─────┘                  └──────────┘
            │ converted (payment, pay-later, or counter)
      ┌─────▼─────┐
      │  booked   │
      └───────────┘
```

`held` lives **inside `opd_appointments`**, not beside it — the shipped partial unique
index on `(doctor_id, slot_start)` is already the sole arbiter of slot contention, and a
second table would mean two arbiters racing each other (22c-C DD1).

### 2.2 Two clocks, and where the boundary sits

The interaction clock (10 min) belongs to this segment. The **pending clock** — the extra
window while a payment attempt is in flight — belongs to S4, because only S4 knows an
attempt exists. S3 must therefore expose *extend* and *release* as operations S4 can call,
and must not itself know what a payment is.

---

## 3. Channel variants

| | `SELF` | `KIOSK` | `CNTR` | `CALL` |
|---|:--:|:--:|:--:|:--:|
| Take a hold | ✅ | ✅ | rarely | ✅ |
| **See a hold as "held by this patient"** | own | own | ✅ | ✅ |
| Convert a hold | ✅ | ✅ | ✅ | ✅ |
| Book with no hold at all | — | — | ✅ | ✅ |
| Build a cart | ✅ | ✅ | ✅ | ✅ |
| Send a payment link for a cart | — | — | ✅ | ✅ |

**The counter mostly does not need holds** — choosing and paying are one action there. It
needs to *see and convert* them, which is the whole handoff. A cashier who cannot tell a
patient's own hold from a stranger's booking will fight it, and that is the most
infuriating possible bug in this segment.

---

## 4. The cart

One patient (E9, 22c-C DD8). A cart that spans people is a wrong-patient defect waiting
for a busy morning, and the family case is solved one layer up: **one payment settling a
set of carts** (S4 §5), not one cart holding a set of patients.

`carts` · `cart_lines` · a bound `patient_id` · a computed total that the **server** owns.

---

## 5. Edge cases, expanded

Extends `03-JOURNEY-SEGMENTS.md` §4. Each row carries its test assertion.

### 5.1 Holds and contention

| # | Scenario | Behaviour | Assertion |
|---|---|---|---|
| S3-01 | Held on the app, then the same patient calls the call centre | Agent sees **"held by this patient"** and converts it | The agent surface distinguishes own-hold from taken |
| S3-02 | Held on the phone, patient walks to a counter | Cashier converts, never fights | A cashier can convert a hold without cancelling it first |
| S3-03 | Session dies; patient returns on another device | Reclaimable by the same patient | A hold survives a session and is keyed to the patient, not the session |
| S3-21 | Two devices of one patient both hold the same slot | Idempotent — one hold | Second request returns the first hold |
| S3-22 | Two different patients race one hold | Exactly one wins, via the index | Concurrent attempts → one `held` row |
| S3-14 | Tab closed at the cart | TTL releases; nothing left behind | No orphan cart line, no consumed `appointment_no` |
| S3-15 | Patient returns to their **own** expired hold | *"Your hold expired"*, never *"slot taken"* | Distinct error codes, distinct copy |
| S3-11 | Patient holds one slot, then holds another | The first releases immediately, not on TTL | Second hold request releases the first in the same transaction |
| S3-20 | One household holds five doctors' slots | Cap at 2 concurrent (R-15) | The third is refused with the reason |
| S3-23 | A hold outlives a schedule change that deletes its slot | Fails loudly at conversion, never books a slot that no longer exists | Conversion against a removed template → explicit refusal |
| S3-24 | The doctor declares leave while a slot is held | The hold is released and the patient told, not silently converted later | `needs_rebooking` is for bookings; a hold simply dies with a message |

### 5.2 Binding

| # | Scenario | Behaviour | Assertion |
|---|---|---|---|
| S3-04 | Wrong family member bound, caught in the cart | "Change" **recomputes the fee** — revisit branch, age band and membership all differ within one family | Fee after change ≠ fee before, for a family with mixed history |
| S3-25 | The header's viewing profile differs from the bound patient | The bound patient always wins; the header never leaks into a transaction | Binding never reads the viewing context |
| S3-17 | Add-profile mid-checkout, under time pressure | 22c-B's dedup gate still runs | A duplicate created at checkout is impossible without passing the gate |
| S3-26 | The bound patient is bound in two open carts simultaneously | Allowed, but overlapping slots warn | Two carts for one patient are legal; overlapping times raise a warning |
| S3-13 | A proxy binds someone outside their household | Refused (locked) | An unlinked patient cannot be bound from a household session |

### 5.3 Cart and handoff

| # | Scenario | Behaviour | Assertion |
|---|---|---|---|
| S3-05 | Cart built on the app, paid at a counter | Cashier opens it by phone, UHID or QR | Cart is retrievable by all three keys |
| S3-06 | Cart built at a counter, paid from the patient's phone | A payment link — **the most useful counter feature in the design** | A counter-created cart is payable by a patient session |
| S3-07 | Hold expires while the patient walks from the gate to the counter | Cashier re-takes it in **one action** | A one-click re-hold exists; not a re-search |
| S3-08 | **Mother and child in one visit** | Two carts, **one payment** — the intent references a set (S4 §5) | Two carts settle from one intent, producing two receipts |
| S3-09 | Kiosk cart abandoned; the next patient walks up | Hard session clear on idle and on print | No cart state survives a kiosk session end |
| S3-12 | Tariff changes between cart build and payment | The displayed fee binds for the hold's life (R-14) | A tariff edit mid-hold does not change the cart total |
| S3-16 | Cart contains a service the patient is not eligible for | Blocked at binding with the reason | Age-band and sex-restricted services refuse at bind, not at the desk |
| S3-27 | A cart line's doctor goes inactive while the cart sits | Flagged, priced out, total recomputed before payment | The cart cannot be paid in a state that cannot be delivered |
| S3-28 | Two counters open one cart | Ordered `FOR UPDATE` on the cart row; one wins | Second cashier's screen explains rather than double-books |

---

## 6. What this segment must expose to its neighbours

| Consumer | Operation | Why |
|---|---|---|
| S4 | `extendHold(holdId, until)` · `releaseHold(holdId)` | The pending clock lives in S4; the hold does not know what a payment is |
| S4 | `lockCart(cartId)` — ordered `FOR UPDATE` | Every money path takes it; this is the double-collection defence |
| S5 | `hold → booked` conversion result | Check-in needs a booking, never a hold |
| Counter | `findCartsByPatient(key)` for phone · UHID · QR | The handoff contract, and the reason the segment exists |

---

## 7. Rulings

All locked. R-14 (displayed fee binds; no auto-adjust on a decrease) · R-15 (2 concurrent
holds) · P-5 (two-clock model) · E9/DD8 (one patient per cart) · proxy binding outside a
household refused. **Nothing in S3 is open.**
