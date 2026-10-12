---
type: decision
id: "0071"
title: "CBNAAT and AFB smear tests are free (₹0) under the national TB programme"
description: "Owner 2026-10-12: the TB programme's diagnostic tests — CBNAAT and AFB smears (sputum and other specimens) — are priced at ₹0; every other lab price of decision 0070 stands."
generated: { by: agent:claude, at: 2026-10-12 }
verified: []
status: stable
ruling: ruled
tags: [lab, tariff, billing]
supersedes: []
superseded_by: []
sources: []
---
# 0071 — TB programme tests are free

- **Date:** 2026-10-12   **Status:** Ruled
- **Area:** tariff (lab services)

## What is ruled (owner, 2026-10-12)

*"Make CBNAAT and AFB free under the TB programme."* The lab services CBNAAT, AFB_SPUT (sputum AFB smear) and
AFB_OTHER (AFB smear, other specimens) are priced at ₹0. This changes one line of decision 0070, which said they
were priced like any other test; the rest of 0070 stands.

## DECIDED (standard practice, open to the owner's objection)

- Only the tests the owner named are free. TB line-probe assay (TB_LPA) and liquid culture (TB_MGIT) keep their
  prices; under the programme they normally go to the state's reference lab, not this one.
- The ₹0 goes into force the same way as 0070: a new tariff version copied from the one in force, on the direct
  road, in the name of user `admin`.

## Consequences / how to apply

- Data: `apps/core/scripts/data/lab-prices-2026-10.ts`.
- Put into force: `node dist/scripts/set-lab-prices.js --by admin --apply` (it changes only these three prices).
