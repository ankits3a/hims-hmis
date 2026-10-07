---
type: decision
id: "0027"
title: "Materials core: the three-slice cut and four procurement rules"
description: "Materials ships in three plans (14, 14b, 14c), and four procurement rules from the brainstorm are adopted."
generated: { by: agent:claude, at: 2026-08-27 }
verified: []
status: stable
ruling: ruled
tags: [materials, procurement, pharmacy, ot]
supersedes: []
superseded_by: []
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0027 — Materials core: the three-slice cut and four procurement rules

- **Date:** 2026-08-27   **Status:** Ruled
- **Area:** materials, procurement, pharmacy, ot

## Decision

**1. Slice.** The materials brainstorm (doc 09) is three phases, not one:
- **Plan 14** = item and vendor masters, stores, the stock ledger, challan GRN, two-sided issue, FEFO, recall,
  expiry, and the `consignment.deployed` consumer. Plan 15 (mini-OT) needs only this.
- **Plan 14b** = purchase-to-pay (indent, PO, approval bands, invoice match, Tally), gated on the CA session.
- **Plan 14c** = consignment reconciliation and auto-PO, stock counts, capex to `device`, payment runs, gated on O1.

**2. Screens in Plan 14:** items, vendors, and the GRN gate.

**3. Procurement rules (brainstorm recommendations adopted by the owner):**
- **O-2 near-expiry receipt:** refuse stock with less than 6 months or less than 75% of shelf life left, whichever
  is lower; an exception needs an approval.
- **O-6 vendor bank-account change:** a 7-day cooling-off period plus the owner's approval.
- **O-8 consignment:** no consignment GRN without a signed agreement document on file.
- **O-11 vendor blacklist:** 3 years, on one of four trigger codes.

## Why

Procurement is an owner subject; the slice keeps the mini-OT unblocked while purchase-to-pay waits for the CA.

## Consequences / how to apply

- One stock ledger lives in `materials`; pharmacy is a consumer of it (planner ruling recorded for the owner).
- The bank-change approval is the approval type `materials_vendor_bank_change` in
  `apps/core/src/modules/materials/approval-types.ts` (the precedent 0013 cites).
- Phase doc: `docs/superpowers/plans/2026-08-27-phase1-14-materials-core.md`.
