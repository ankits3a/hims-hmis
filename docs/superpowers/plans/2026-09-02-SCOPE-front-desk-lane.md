# SCOPE — the front-desk lane, 2026-09-02: what runs next, in what order, and what the owner holds

**Lane `lane/front-desk`**, owning `apps/core/src/modules/opd`, the `registration-*`, `counter-*`,
`opd-*`, `desk*` and billing-counter screens, and `apps/web/src/lib/keyboard.tsx`. `patients` and
`billing` are hubs: an `index.ts` export or shared-type change is its own tiny PR, merged first
each morning, named in its description. Migration numbers are taken at rebase. One full core run
on the box at a time (`tools/lane.sh status` first).

## Order

| # | phase | doc | gate |
|---|---|---|---|
| 1 | **VD-2 — Bay One, the vitals desk** | `2026-09-02-phase2-vd2-bay-one.md` | none (T0 is the review VD-1 owes) |
| 2 | **FD-1 — the front-desk dashboard** | `2026-09-02-phase1-fd1-front-desk-dashboard.md` | none |
| 3 | **RC-5 — benefits in the clerk's hands** | not authored | **rulings R1, R2, R3 below** |
| 4 | RC-6 — the agent surface v0 (`agent_ledger`) | not authored | after RC-5 |

Both authored phases: zero migrations, zero new permissions, every rail measured with its consumer
count before the task was written, one PR per task.

## RC-5 — what it is, and why it waits

Every benefit rail has been server-side since RC-2 with **no input that reaches it**:
`fetchFeeQuote` and both invoice bodies accept `couponCodes`/`attributionCode` (`billing-api.ts:126`),
the seat's `reprice` takes them, and its only two callers pass `[]`
(`grep -n "reprice(" apps/web/src/screens/registration-counter.tsx` → lines 797 and 1049, both
`reprice([])`; no coupon or referral input exists on any screen). RC-5 is the coupon and referral inputs on the seat,
benefit chips that reprice in place, and late attach at billing. It **closes the rest of demo 1 and
half of demo 4** of the registration series. It is not started because two of its inputs are money
questions, and a UI built on the wrong answer is a UI that mis-prices.

### Owner rulings needed (money), with the recommended default

- **R1 — Is a plan-bundled coupon a BEARER instrument?** (RC-3 §6.1.) A stranger presenting a
  member's single-use bundled coupon would spend it permanently.
  **Default: NO.** A bundled coupon is bound to the member's UHID: the seat accepts it only with
  that member in hand, and a mismatch says whose it is without applying it. Standalone campaign
  coupons stay bearer. This is what corporate-hospital membership desks do and it needs no new
  table — the binding is a check at `reprice`.
- **R2 — Does a full refund put the token back to UNPAID on the board?** (RC-3 §6.3.) Execution
  proved a credit note cannot un-settle: `settlementState` counts it toward coverage.
  **Default: NO.** The board keeps PAID; the refund is its own audited event and its own line on
  the day-book; a re-collection on the same visit is a new invoice. Reversing a settlement is a
  second truth function the board would have to reconcile.
- **R3 — F5 midnight** (RC-4 §7.1, billing). A deferred visit opened at 23:58 and paid at 00:03 has
  its money taken and no road to a token, because `joinQueue` refuses a visit whose `serviceDate` is
  not today.
  **Default:** the settle hook re-dates a never-joined deferred visit to the payment's IST day
  before joining it, and the invoice keeps its own `serviceDay`. One visit, one token, the day-book
  shows the money on the day it was taken. The alternative (open a fresh visit and carry the fee)
  moves an invoice between encounters, which billing has no rail for.

## Deletions the owner holds (hard to reverse)

- **`/counter`** — RC-4 T5, gated on RC-4 §6.1. **Default: delete now.** RC-4 finished a patient
  through the seat (open, bill-first, PAID stamp, flow pill); both consequences are staged
  (`/counter/seat` has no manifest row; the route pin's comment says 45 → 44). One edit.
- **`/opd/vitals`** — after VD-2 T5's seven stories run. **Default: delete then**, the same shape.

## Procurement the owner holds
The serial-device ledger for the vitals bays (₹70,960/bay serial vs ₹16,110 manual). VD-2 ships
with the lane OFF and the driver seam stubbed; nothing in either phase waits on the devices.
