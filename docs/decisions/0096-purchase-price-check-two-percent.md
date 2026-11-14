---
type: decision
id: "0096"
title: "Purchase price check: more than 2% above the last purchase or the contract needs a reason, no second person, compared across all suppliers"
description: "Owner rulings of 2026-11-14 for #1061: a paid supplier GRN line more than 2% above the item's last paid receipt (any supplier) or the supplier's contract rate is amber and is captured only with a typed reason; no second approver."
generated: { by: agent:claude, at: 2026-11-14 }
verified: []
status: stable
ruling: ruled
tags: [pharmacy, materials, purchase, money]
supersedes: []
superseded_by: []
sources:
  - { id: spec-1061, resource: "docs/specs/1061-grn-price-check.md", title: "Spec: purchase price check" }
---
# 0096 — Purchase price check: 2%, a reason is enough, compared across all suppliers

- **Date:** 2026-11-14   **Status:** Ruled
- **Area:** pharmacy, materials, purchase, money

## Decision

The owner accepted the three proposals for the purchase price check (#1061) with "go ahead with your
recommendations":

- **Threshold 2%.** A paid supplier GRN line whose cost per base unit is MORE than 2% above the item's last paid
  receipt or this supplier's contract rate in force is amber. The 2% matches the PO receipt tolerance.
- **A typed reason is enough.** An amber line is captured with one of: MRP revised, scheme changed, urgent buy, or
  other (in words). No second person approves it. The reason is stored on the line, emitted as
  `grn.price_above_reference`, and listed in the office's Purchase analysis report.
- **Any supplier.** The "last receipt" is the item's last paid receipt from any supplier, so a dearer supplier shows
  even when its own last price was the same.

Decided by the agent (standard practice, not a money ruling): a difference of one paisa per base unit or less is
rounding of a per-unit cost and never amber; when a line exceeds both references the lower one is named; opening
stock, donations, free goods and zero-cost lines are never checked and never count as a past purchase.

## Why

Before #1061 nothing compared a delivery's rate with what the hospital paid before; only quantity (PO receipt) and
the bill against the GRN were checked. Real pharmacy stock entry began on 2026-11-14, so every overpaid line from
then on is money lost. The check is P0 item 2 of the pharmacy software study of 2026-11-14.

## Consequences / how to apply

- `PRICE_CHECK_THRESHOLD_BPS = 200` in `apps/core/src/modules/materials/config.ts`. Changing it is a new ruling.
- Adding a second approver above some amount is a new ruling, not an edit of this one.
- Tests that receive the same item at rising rates give a reason, as a person would.
