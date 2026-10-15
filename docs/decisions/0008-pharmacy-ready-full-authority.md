---
type: decision
id: "0008"
title: "Make the pharmacy ready: full authority over production pharmacy data, minimal screens, loose-tablet pricing"
description: "The pharmacy is made ready under full authority: minimal in-flow screens, FEFO batch and shelf per line, and loose-tablet pricing."
generated: { by: agent:claude, at: 2026-09-22 }
verified: []
status: stable
ruling: ruled
tags: [pharmacy, materials, billing]
supersedes: []
superseded_by: []
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0008 — Make the pharmacy ready: full authority over production pharmacy data, minimal screens, loose-tablet pricing

- **Date:** 2026-09-22   **Status:** Ruled
- **Area:** pharmacy, materials, billing (GST)

## Decision

- *"I want the pharmacy module to be ready anyhow … I give you full authority to make it happen. Production doesn't
  have any live data … you can delete/add/edit."* Production PHARMACY data changes are authorised by this ruling.
  Non-pharmacy production data still needs asking, and a backup is taken first.
- **Screens minimal and in flow:** *"Don't complicate the pharmacy module screen. Keep it minimal and in flow … I
  cannot compromise with user experience."* The `/counter` artifact is the example. Exceptions live behind ⋯ and
  sheets, never stacked in the line row.
- Each medicine line gets a **FEFO Batch & Shelf** option: the nearest-expiry batch and its rack, tap to choose
  another (drawn on the Desk board v2, https://claude.ai/artifact/97qdjsu2qrJeHHcSodrTUc).
- **Stock: BOTH.** Realistic TRIAL stock is loaded into production now so the counter can be walked end to end, AND
  an "Opening stock" sheet import lets the pharmacist fill from the real shelf. Trial stock is wiped when the real
  sheet goes in.
- **Medicines: a starter list Claude picks** (~300): everything already prescribed in production OPD plus NLEM, each
  matched to a common brand in the CDS catalogue.
- **Pharmacist registration: TRIAL for now.** A clearly marked TRIAL council registration is filed so the counter
  works; the bill and the H1 register say TRIAL until the owner gives the real registration, then it is replaced.
- **Loose-MRP ruling (money).** When a strip MRP does not divide into whole paise per tablet (₹35.50 / 15):
  - a FULL strip bills at exactly the printed MRP;
  - a LOOSE tablet bills at the per-tablet share ROUNDED DOWN to the paisa (₹2.36), never above MRP.
  This replaces `mrpPerBaseUnit`'s refuse-don't-round (`materials/uom.ts`) for SALE pricing. Comparisons (QC rule 6,
  MRP ≥ cost) compare exactly (cross-multiply), not rounded.
- **GST on medicines** (owner-supplied sources; reuse them, do not ask again): effective 22 Sep 2025, medicines HSN
  3004 (and 3003 AYUSH) are **5%**; the **36 specified life-saving drugs are Nil**; contraceptives Nil; there is no
  12% slab for medicines. The 36 names are in the CBIC notification. Sources: gimbooks.com/blog/medicine-hsn-code-3004-gst-rate,
  credlix.com/hsn-code/98041000, busy.in/gst-rates/medicines (razorpay.com/learn/gst-on-medicines is stale, pre-2025 12%).

## Why

The owner wants a working pharmacy, not more design; "full authority" is the owner's explicit grant.

## Open

- Owed by the owner: the real pharmacist's name, council, registration number and valid-until date, to replace the
  TRIAL registration.
