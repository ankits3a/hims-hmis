---
type: decision
id: "0070"
title: "Lab test prices: 331 tests priced at about 70–90% of Lal PathLabs / Apollo walk-in prices, put into force by the owner's authorisation"
description: "Owner 2026-10-12 authorised prices for every lab test, inspired by Lal PathLabs and Apollo, added in the name of user admin. They go into force as a new tariff version on the direct road; the lab fee switch still decides whether a lab bill is raised at all."
generated: { by: agent:claude, at: 2026-10-12 }
verified: []
status: stable
ruling: ruled
tags: [lab, tariff, billing]
supersedes: []
superseded_by: []
sources: []
---
# 0070 — Lab test prices (October 2026)

- **Date:** 2026-10-12   **Status:** Ruled
- **Area:** tariff (lab services), billing

## What is ruled (owner, 2026-10-12)

1. *"Add lab test prices inspired from Lal PathLabs and Apollo lab. I authorize you to add prices on my behalf
   (user admin)."* Every one of the 331 lab tests of the standard catalogue gets a price.
2. The prices are put into force in the name of user `admin`.

## DECIDED (standard practice, open to the owner's objection)

- Prices sit at roughly 70–90% of the chains' walk-in prices for the same test, rounded to tens; packages cost
  less than their parts; COVID tests stay under the state caps (antigen ₹150, RT-PCR ₹400).
- They go into force as a NEW tariff version copied from the one in force (every other price carried over),
  activated on the direct road with this authorisation as its reason — the road the owner's consult price change
  takes. Bills already issued keep their prices.
- The lab fee switch (Billing office → Fees) still decides whether a lab test is billed at all; while it is Free
  no lab bill is raised.
- Tests the national TB programme provides free (CBNAAT, sputum AFB) are priced like any other; the owner may
  set them to ₹0 or use the Free switch for a programme patient.

## Consequences / how to apply

- Data: `apps/core/scripts/data/lab-prices-2026-10.ts` (rupees per test code).
- Put into force: `node dist/scripts/set-lab-prices.js --by admin --apply` (dry run without `--apply`).
