---
type: decision
id: "0023"
title: "A pharmacy return may be kept as the patient's credit"
description: "A pharmacy return may be kept as patient credit without approval, spent first at the pharmacy desk; cash refunds stay approval-gated."
generated: { by: agent:claude, at: 2026-10-02 }
verified: []
status: stable
ruling: ruled
tags: [pharmacy, billing]
supersedes: []
superseded_by: []
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0023 — A pharmacy return may be kept as the patient's credit

- **Date:** 2026-10-02   **Status:** Ruled
- **Area:** pharmacy, billing

The owner asked whether a patient can use a credit note to buy other medicine and pay only the difference, then
ruled "use your recommendations".

## Decision

1. The pharmacy counter MAY hold patient credit — an exception to the 2026-09-28 "no ₹ balance at counter" ruling.
2. Keeping a return as credit needs NO approval (no money leaves). A cash refund stays approval-gated.
3. What a smaller purchase leaves over stays as credit; taking it out as money is the ordinary advance refund, with
   approval.
4. Credit is spent at the pharmacy desk only (Claude's narrow reading; the owner did not answer this one explicitly).
5. No expiry (same: not answered explicitly).
6. Credit is spent first on the next pharmacy bill.

Same day, also: the pharmacy bill prints on a 4×6 inch dot-matrix form (PR #441); a handed-over ticket no longer
blocks a new bill (PR #439); refunds are allowed without registration in quick desk mode (PR #440, see 0022).

## Why

A separate credit book is needed because a cash receipt stores the note handed over, so its change-due remainder
already reads as unallocated/advance in billing, and OT holds deposits on receipts. Spending "any advance" at the
pharmacy would spend money that is not credit.

## Consequences / how to apply

- GST is not netted: the credit note and the new invoice stay separate documents.
- Do not widen credit to other counters or add expiry without a new ruling.
- Built in PR #442 (migration 0167): billing `releaseInvoiceSurplusOnTx` frees a credit note's surplus onto the
  receipt (it becomes advance); `pharmacy_credit_moves` is the pharmacy's book of which unallocated money is credit;
  `billDispense` takes `useCreditPaise` and uses `settleFromReceipts`.
- Related: 0013 (credit — selling without payment — remains owner-only).
