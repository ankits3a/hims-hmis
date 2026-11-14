---
type: decision
id: "0094"
title: "Pharmacy: staff may add a medicine to a ticket by hand, any schedule except X and narcotics, with or without a prescription"
description: "The counter may add a medicine the doctor did not prescribe, or wrote on paper only, to a dispense ticket; every schedule except Schedule X and narcotics; the line is marked as added at the counter."
generated: { by: agent:claude, at: 2026-11-13 }
verified: []
status: stable
ruling: ruled
tags: [pharmacy, legal]
supersedes: []
superseded_by: []
sources:
  - { id: spec-1055, resource: "docs/specs/1055-pharmacy-desk-two-columns.md", title: "Spec: pharmacy desk in two columns" }
---
# 0094 — Pharmacy: staff may add a medicine to a ticket by hand, any schedule except X and narcotics

- **Date:** 2026-11-13   **Status:** Ruled
- **Area:** pharmacy, law

## Decision

- Owner: *"allow manual addition of drugs to the list even if the drug is not prescribed by the doctor or doctor has
  written on paper but is not fed in the system."*
- Asked which medicines may be added when the doctor did NOT prescribe them, with the recommended answer "only
  unscheduled (OTC)" and the alternative "any except X and narcotics" described as dispensing Schedule H/H1 with no
  prescription, the owner chose **any except X and narcotics**.
- So a medicine may be added by hand for one of two reasons, recorded on the line:
  - **not prescribed** — any schedule except Schedule X and narcotics;
  - **the doctor wrote it on paper** — any schedule except Schedule X and narcotics; a Schedule H line keeps the
    paper-prescription rules (slip photo unless quick desk mode is on, 0022; H1 needs the prescriber's name and
    registration number).
- Schedule X and every NDPS class are never added by hand.
- Allergy, interaction and duplicate checks run on an added line as on a prescribed one. The line is marked "added at the
  counter by <name>" with its reason, on the ticket, the bill and the audit trail. A Schedule H1 line added as not
  prescribed is still written to the H1 register, with "no prescription — added at the counter" in place of the
  prescriber.

## Why

The owner wants the counter to serve what the patient asks for without a second trip to the doctor. This is a law
ruling (Drugs and Cosmetics Rules: Schedule H/H1 are sold on a prescription) and the owner made it knowingly, as in 0022.

## Consequences / how to apply

- Spec #1055 D5 builds it. Do not "fix" the not-prescribed path as a defect, and do not widen it to Schedule X or
  narcotics without a new ruling.
