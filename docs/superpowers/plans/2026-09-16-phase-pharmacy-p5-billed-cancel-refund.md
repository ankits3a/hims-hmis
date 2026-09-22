# Pharmacy P5 — a paid dispense that cannot be collected has a way out (2026-09-16)

**Lane** `formulary` worktree, branch `lane/pharmacy-refund`, stacked on P2.

## 1. THE DEFECT, MEASURED

The 16c launch notes and `handover.ts` both describe the same dead end:
- a billed dispense whose batch expired before collection is refused at hand-over
  (`batch_expired_before_collection`);
- `cancelDispense` refused `billed`;
- the pick-expiry sweep skips billed dispenses.

So the patient had paid and could not collect, the counter had no exit, and **the picked stock
stayed reserved for ever**. The workflow definition already allowed `billed → cancelled` to a
pharmacist; only the code refused it.

## 2. DECISIONS (owner instruction 2026-09-16: follow the Indian hospital standard)

- **P5-1. The counter that issued the bill undoes it.** Indian hospital pharmacies handle a return
  or cancellation of their own bill at the pharmacy counter. One act, `cancelBilledDispense`, runs in
  one transaction:
  - it cancels the dispense (row lock and conditional update);
  - it cancels the order items and releases the reservations;
  - it credits the invoice **in full** (`refund` credit note), because nothing was supplied;
  - it **requests** the refund.
- **P5-2. The money still leaves only by approval.** Spec §7 says a refund is always approved.
  - The counter files the `billing_refund` request, with the credit note as the paper it draws on.
  - Billing's approver approves it, and the cashier issues and pays the voucher (`billing.refund.pay`
    stays the cashier's).
  - The refund voucher's guard 1 (cap at money received) applies unchanged.
- **P5-3. Who.** The workflow names the pharmacist, so this is the Act's pharmacist:
  `requireRegisteredPharmacist` (P2).
  - `pharmacy` gains `billing.credit_note.issue` and `billing.refund.request`: the cashier's two
    strings for this, but not the payout.
  - Both are asserted **inside** the act, the FD-31 rule, and the route is gated on
    `billing.refund.request`.
- **P5-4. A reason and a class** (`genuine` | `mistake`) ride the credit note, the refund request and
  the dispense (`reason_required` under 3 characters). The approver reads them.
- **P5-5. The record.** `dispense.cancelled` carries `creditNoteId` and `refundApprovalId`. Both
  default to null, which is what a dispense cancelled before billing, or any earlier payload, has.
- **P5-6. The route is idempotent** (`POST /pharmacy/dispenses/:id/refund`, in
  `PHARMACY_IDEMPOTENT_ROUTES`): a retried click must not raise two credit notes.

## 3. AS BUILT, AND WHAT PROVES IT

- `refund.ts`, the route, and the counter's red "Paid, not collected" panel with its reason and
  class.
- The hand-over refusal text now names the exit (both locales). Runbook §3.10, §4 and §8 are
  updated.
- **Tests.**
  - `refund.test.ts` (3):
    - the full act: stock freed (27 → 30), order item cancelled, one refund credit note for exactly
      what was paid, outstanding 0, the approval filed for that amount, the event ids, and a
      hand-over afterwards refused;
    - refused for an unregistered pharmacy login, the aide, a blank reason and missing billing
      grants, with **nothing written** on any of those refusals;
    - refused on a dispense that is not billed.
  - An HTTP gate (the aide gets 403).
  - A web test (disabled until there is a reason; body, class and idempotency key; the note names
    the credit note).
- **Role model.** `PHARMACY_REFUND_PAIRS` (+2 non-table pairs), quoted README prose, pharmacy grants
  20 → 22, model pairs 332 → 334.

**Mutants (7, predicted, all killed):**
- F1: the reservations are not released.
- F2: a short credit note.
- F3: no registration is required.
- F4: the billing strings are not asserted.
- F5: any status can be cancelled this way.
- F6: the event drops the credit note.
- F7: the form ignores the class.

## 4. NOT BUILT

- **The return of a drug already handed over** (doc 16 O-7: sealed, receipt, 7 days, not
  cold-chain, narcotic, Schedule X or cut strips). That needs a stock movement back to the shelf
  with an inspection, which is a separate act.
- **Partial cancellation** of one line of a billed dispense. The act credits the whole bill. A line
  still wanted is dispensed again: scanning the prescription after the cancel starts a fresh dispense.
