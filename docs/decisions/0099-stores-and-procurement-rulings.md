---
type: decision
id: "0099"
title: "Stores & Procurement: a non-drug master register on the one ledger, patient-billable items stay with pharmacy, HOD approves, quotation bands, QR tags, one finance book"
description: "Five owner rulings for the non-drug Stores & Procurement programme (#1111–#1117): the pharmacy boundary, approvals and quotations, asset tags, one set of books with pharmacy, and the scope of the master register."
generated: { by: agent:claude, at: 2026-11-18 }
verified: []
status: stable
ruling: ruled
tags: [stores, materials, procurement, money, pharmacy]
supersedes: []
superseded_by: []
sources:
  - { id: programme, resource: "docs/specs/stores-programme.md", title: "Stores & Procurement programme" }
  - { id: spec-1111, resource: "docs/specs/1111-stores-masters-shelves.md", title: "Spec: S1 masters, stores, department shelves" }
---
# 0099 — Stores & Procurement rulings

- **Date:** 2026-11-18   **Status:** Ruled
- **Area:** stores, materials, procurement, money (milestone "Stores & procurement", #1111–#1117)

## Decision

The owner asked for a hospital-wide master stock and inventory register for every non-drug item ("even a dustbin"),
from which every department, housekeeping included, receives its material through a request ticket; every movement
tracked like logistics (from where to where, from which staff to which staff); a control tower under the procurement
department; and agentic copilots. Pharmacy is separate and out of scope. Asked five questions with a recommended
option each, the owner answered "Go with your recommendation":

1. **Pharmacy boundary.** Anything that can appear on a patient's bill (implants, surgical items billed per piece)
   stays with pharmacy. Items never billed per piece (lab reagents, X-ray film, gas cylinders, housekeeping,
   stationery, electrical, IT, furniture) come to Stores.
2. **Approvals and quotations.** The HOD alone approves a department's request. Each department gets a monthly
   budget from finance that warns at 80% and 100% and never blocks a patient-care item. Purchase orders keep the
   existing tiers (materials head up to ₹50,000, owner above). One quote up to ₹25,000, checked against the last
   price; three quotes and a comparative statement from ₹25,000 to ₹5 lakh; above ₹5 lakh, and for any equipment,
   three quotes, the purchase committee and the owner.
3. **Asset tags.** A QR tag on all medical equipment at any value, and on IT and furniture worth ₹5,000 or more.
   Cheaper durables (dustbins, buckets, chairs) are counted per department. AMC, warranty and calibration dates live
   in HMIS with reminders. Depreciation stays with the accountant in Tally; HMIS sends cost and put-to-use date.
4. **One set of books.** One supplier list, one payables list, one payment run and one Tally export for pharmacy and
   Stores together, with reports split by department and item group.
5. **Master scope.** Linen and uniforms and canteen dry provisions are bought and stocked through Stores; daily
   fresh kitchen items are received and used the same day. Laundry and canteen modules keep no separate stock book.
   The control tower shows non-drug items only.

## Why

One register only works if nothing keeps a side book; one ledger already exists in `materials` (0027) and pharmacy is
live on it, so Stores is a front end on that ledger, not a second one.

## Consequences / how to apply

- New leaf module `stores` over `materials`; materials changes are additive only. Stores refuses class `drug`,
  class `implant` and patient-billable items, and never reads pharmacy stores.
- Linen, housekeeping, canteen, ward and maintenance work (#974, #981, #983, #1012, the IPD train) take stock from
  Stores stores instead of their own item or movement tables.
- Slices: S1 #1111, S2 #1112, S3 #1113 (approved specs); S4 #1114, S5 #1115, S6 #1116, S7 #1117 need full specs
  before build, written to these rulings.
