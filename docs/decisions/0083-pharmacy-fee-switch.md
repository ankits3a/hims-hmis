---
type: decision
id: "0083"
title: "Pharmacy fee switch: medicines free from the Fees page, with MRP kept on the bill"
description: "A fourth fee switch makes OPD and walk-in medicines ₹0 through a 100% discount, decided when the dispense is created; GST treatment waits for the CA."
generated: { by: agent:claude, at: 2026-11-02 }
verified: []
status: stable
ruling: ruled
tags: [billing, pharmacy, printing]
supersedes: []
superseded_by: []
sources:
  - { id: spec-pharmacy-fee-switch, resource: "docs/specs/1023-pharmacy-fee-switch.md", title: "Spec: pharmacy fee switch" }
---
# 0083 — Pharmacy fee switch: medicines free from the Fees page, with MRP kept on the bill

- **Date:** 2026-11-02   **Status:** Ruled
- **Area:** billing, pharmacy, printing

## Decision

- The owner asked for a pharmacy switch beside OPD, laboratory and imaging on Billing → Back office → Fees. Off = free.
- It covers OPD dispenses and walk-in sales, every item, including Schedule H and controlled drugs. IPD is not affected.
- A dispense reads the switch when it is created, as imaging does at its order. A walk-in sale reads it at the sale.
- Each line keeps its MRP and carries a 100% discount, "समाज सेवा छूट". The bill prints "₹0 (समाज सेवा छूट)".
- Stock and registers move as on a paid sale. A free return raises no refund and no pharmacy credit.
- The owner's CA rules on GST for free medicines before the switch is used in production.
