# Pharmacy P6 — a sealed pack comes back (2026-09-16)

**Lane** `formulary` worktree, branch `lane/pharmacy-returns`, stacked on P4.

## 1. WHY

Every Indian pharmacy counter takes back a sealed strip the patient no longer needs. Doc 16 wrote
the policy as O-7: 7 days, sealed, against the receipt, never cold-chain, narcotic, Schedule X or
cut strips, and refund by the original tender. 16c shipped none of it; the runbook's §8 said
"returns, refunds and credit notes: not in 16c". P5 closed the billed-and-never-collected half;
this closes the handed-over half.

## 2. DECISIONS (owner instruction 2026-09-16: follow the Indian hospital standard)

- **P6-1. The policy is O-7's, and each clause is a refusal.**
  - More than 7 days after the hand-over (IST dates): `return_window_closed`.
  - Not attested sealed and intact by the inspecting pharmacist: `return_not_sealed`. The route
    also requires the literal `true`.
  - Not whole issue packs: `return_cut_strip`.
  - A `cold_2_8`, `frozen` or `narcotic` storage class: `return_not_accepted`.
  - A batch recalled or under 30 days to expiry: `return_short_expiry`. It cannot go back on the
    shelf; quarantine it instead.
  - More than the line dispensed, net of earlier returns: `return_exceeds_dispensed`.
  - Schedule X never reaches a hand-over at this counter (R-3), so it never reaches a return.
- **P6-2. The pack goes back where it came from.** A `return` ledger row on the same batch, into
  the counter's store, with `ref_type = pharmacy_return` and `ref_id` = the dispense line. Those
  same rows are how "already returned" is counted (`returnedQtyByRef`). **No new table and no
  migration**: the ledger, the credit note and the event already hold every fact.
- **P6-3. The money.**
  - A `refund` credit note for exactly the returned quantity of each invoice line. Billing
    pro-rates tax and discount (`creditShare`).
  - The refund is **requested**, and billing's approval and the cashier's voucher pay it, as in P5.
    Refund "by the original tender" is the cashier's choice at the voucher.
- **P6-4. Who.** A registered pharmacist (P2), with the two billing strings asserted inside the act
  (P5).
- **P6-5. The record.** `dispense.line_returned` carries:
  - the lines, with their batch and ledger entry;
  - the literal `sealedIntact: true`;
  - the reason and its class;
  - the credit note and the refund approval.
  The dispense itself stays `handed_over`, because returns are partial by nature.
- **P6-6. Idempotent.** `POST /pharmacy/dispenses/:id/returns` is in `PHARMACY_IDEMPOTENT_ROUTES`.

## 3. AS BUILT

- **materials:** `returnedQtyByRef`.
- **pharmacy:** `acceptReturn`, the route, and the counter's "Return a sealed pack" form: quantity
  per line, the attestation checkbox, the reason. The runbook gains §3.11, a new row in the §4
  refusal table, and an updated §8.
- **Tests.**
  - `returns.test.ts` (3):
    - restock, credit and refund of half a line, then the other half, then a third return refused
      as more than was dispensed;
    - each O-7 refusal, with nothing written;
    - a short-expiry batch, and a dispense not yet handed over.
  - The HTTP gates: the aide gets 403, an unattested return 400.
  - A web test (the button waits for the attestation; the body carries only the lines with a
    quantity).

**Mutants (8, predicted, all killed):**
- T1: the window is unchecked.
- T2: earlier returns are ignored.
- T3: a cut strip is accepted.
- T4: a cold-chain item is accepted.
- T5: a short-dated batch is restocked.
- T6: the pack is restocked as a `grn` row, so "already returned" never counts.
- T7: the credit covers the whole line.
- T8: an unsealed pack is accepted.

## 4. NOT BUILT

- **Refund by the original tender, automatically.** The cashier chooses it at the voucher.
- **A returns register report.** The events and the credit notes are the data; the report is 16f's.
- **Returns of drugs the counter did not dispense**, and returns to the supplier. The first is not
  the counter's to accept; the second is procurement's (Plan 14).
