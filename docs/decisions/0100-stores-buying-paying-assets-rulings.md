---
type: decision
id: "0100"
title: "Stores S4–S7: MSME clock per the Act, GST credit not available by default, full purchase committee, single-source and emergency rules, condemnation above ₹50,000, hold release, equipment-only advances, V/E/D safety stock"
description: "Eight owner rulings on money, procurement and law for the Stores asset passport, buying desk, paying desk and stock planner (#1114–#1117), plus the medical superintendent as HOD stand-in."
generated: { by: agent:claude, at: 2026-11-19 }
verified: []
status: stable
ruling: ruled
tags: [stores, procurement, money, law, pharmacy]
supersedes: []
superseded_by: []
sources:
  - { id: spec-1114, resource: "docs/specs/1114-stores-asset-passport.md", title: "Spec: S4 asset passport" }
  - { id: spec-1115, resource: "docs/specs/1115-stores-buying-desk.md", title: "Spec: S5 buying desk and buyer agent" }
  - { id: spec-1116, resource: "docs/specs/1116-stores-paying-desk.md", title: "Spec: S6 paying desk and auditor agent" }
  - { id: spec-1117, resource: "docs/specs/1117-stores-stock-planner.md", title: "Spec: S7 stock planner agent" }
---
# 0100 — Stores S4–S7 rulings: buying, paying, assets, planning

- **Date:** 2026-11-19   **Status:** Ruled
- **Area:** stores, procurement, money, law (milestone "Stores & procurement", #1114–#1117); builds on 0099

## Decision

The full specs for S4–S7 raised eight money, procurement and law questions, each with a recommended answer. The
owner answered, 2026-11-19: "go with your recommendations".

1. **MSME payment clock (law).** Follow the MSMED Act: 15 days from acceptance unless the supplier's signed
   payment-terms agreement is on file, then the agreed days, never more than 45. Micro and small suppliers only;
   a medium enterprise follows its ordinary terms. The clock starts at delivery (the GRN day) or the day the
   service was rendered, and waiting does not move it. It ships switched off; the owner sees the dry run (every
   bill whose due date would move), agreements are collected from current suppliers, then it is switched on. The
   CA confirms whether traders are covered.
2. **GST on Stores purchases (law).** Stores input GST is "credit not available" by default and shows as part of
   the department's cost. Accounts marks a line "eligible" where the CA allows it (for example canteen or taxable
   pharmacy sales). The CA signs the rule table before go-live. Pharmacy's bills are not touched.
3. **Purchase committee** (above ₹5 lakh, and all medical equipment). Materials head, accounts head, medical
   superintendent and the user HOD, plus biomedical for medical equipment. All of them sign, then the owner. Any
   member may delegate, with an end date.
4. **Single source and emergency.** A single-source purchase is allowed with a typed reason and an HOD
   certificate that only one maker supplies it; the materials head approves up to ₹5 lakh and the owner above.
   For an emergency breakdown the medical superintendent may approve one quote, and the owner confirms within
   72 hours.
5. **Condemnation.** The committee (user HOD, accounts, materials head, and biomedical for medical equipment)
   signs first and the medical superintendent approves every write-off, as today; the owner also approves when
   the unit's original cost is above ₹50,000 or unknown (the PO-tier line).
6. **Releasing a held payment.** Up to ₹50,000 the materials head, unless they booked that bill or approved its
   PO. Above ₹50,000, or when the materials head is barred, the owner. A bank-change hold ends only with time.
7. **Advances.** No advances, except for equipment, where the owner may approve up to 30 % against the supplier's
   bank guarantee. Every other PO is pay after GRN. A yearly contract billed at the start by its own terms (AMC,
   software licence, insurance) is paid when the department confirms the term has started and is not an advance.
8. **Safety stock and cover in the central store.** Safety days on top of lead time: Vital 15, Essential 7,
   Desirable 3. Order to cover 30 days for C-class items, 15 for B and 7 for A.

**Ratified with the same answer:** the medical superintendent holds the indent approve grant at hospital scope as
stand-in for an absent HOD or a sole-approver requester, and the timeline shows "for HOD" (#1112). This replaces
the "flagged to the owner for a nod" wording in 0099; that DECIDED item is now ruled.

## Why

Each answer is the standard Indian corporate-hospital practice and keeps one line for money across the programme:
the ₹25,000 / ₹5 lakh quote bands and the ₹50,000 PO tier from 0099 reappear as the scrap-sale, condemnation and
release lines, so no one learns a second set of numbers. The law answers (1, 2) take the cautious side and leave
the figures to the CA.

## Consequences / how to apply

- The four specs are approved (`docs/specs/1114` to `1117`, `status: approved`); each open question in them now
  reads "Ruled (decision 0100 Qk)".
- **Consequences, DECIDED in the specs and now carried by this ruling:** a scrap sale takes one buyer up to
  ₹25,000, three written bids above, and the owner's approval above ₹5 lakh, with tax on the sale the
  accountant's (S4); a planner or department draft over budget is never held for any category, carries the mark
  and goes on the owner's monthly list (S5, S7).
- **Three pharmacy numbers change in S6, each behind a switch that is off at merge, each with a dry run first:**
  holds on pharmacy bills (`holds_cover_pharmacy`), the MSME rule in `dueDateFor` (`msme_rule`), and TDS on the
  purchase-of-goods row. A due date already written on a bill never changes.
- **S6 tax go-live waits on the CA's TDS and GST-credit tables.** The build does not; its tests sign a test table.
