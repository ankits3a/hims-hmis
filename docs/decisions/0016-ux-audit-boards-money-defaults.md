---
type: decision
id: "0016"
title: "UX-audit boards approved, with their money and law defaults"
description: "The UX-audit boards are approved with their defaults: write-off and refund limits, no card balance at the counter, Aadhaar never stored."
generated: { by: agent:claude, at: 2026-09-28 }
verified: []
status: stable
ruling: ruled
tags: [billing, membership, partners, patients, front-desk]
supersedes: []
superseded_by: []
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0016 — UX-audit boards approved, with their money and law defaults

- **Date:** 2026-09-28   **Status:** Ruled
- **Area:** billing, membership (cards), partners, patients (merge, MRD), front desk

The owner approved all five draft boards (slip desk, merge, card recognition, card reconcile, billing back office)
at https://claude.ai/artifact/FrjmoLDKrGetNx7V7De6QD, and said "I like it" to the eight decisions printed on them.

## Decision

Accepted board defaults:
1. The billing manager may write off a bank short-settlement as a charge up to ₹50.00 per receipt. Anything above
   goes to the owner.
2. Refunds above ₹25,000.00 go to the owner.
3. A card's rupee balance is never shown at the counter; it appears on the bill only.
4. An expired card is never honoured; bill at full rate.
7. Aadhaar is never stored, not even the last four digits.

Three questions had no printed default; Claude picked these, told the owner, and they stand unless the owner objects:
5. A benefit returned to an ended card is usable only once the card is renewed.
6. Ask partners to send date of birth and sex in holder files. A request, not a condition of the contract.
8. Merging a sealed record needs the Medical Superintendent to record a break-glass first (made possible by 0017).

The boards' standard answers also stand:
- A missing slip goes to MRD at day end.
- A torn QR can be filed by searching name or UHID.
- Match strength is shown as words, not a score.

## Consequences / how to apply

Build the five screens from the boards; the board files belong in `docs/design/2026-09-28-ux-audit/`.
Ruling 2 is confirmed and enforced for refunds by 0019.
