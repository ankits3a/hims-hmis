---
type: decision
id: "0080"
title: "A doctor may consult in one secondary OPD department until a specialist fills it; the visit's department decides the charge and any split"
description: "Owner 2026-10-17: a doctor gets a primary and at most one secondary OPD department, held with a first and last day. The consult fee stays the hospital-wide price per visit type; new/revisit is counted in the visit's department; any payout or revenue split goes by the visit's department. Built in #914."
generated: { by: agent:claude, at: 2026-10-17 }
verified: []
status: stable
ruling: ruled
tags: [opd, doctor, front-desk, appointments, billing]
supersedes: []
superseded_by: []
sources: []
---
# 0080 — A doctor's secondary OPD department

- **Date:** 2026-10-17   **Status:** Ruled
- **Area:** opd (doctor master, front desk, appointments), billing (consult fee)

## The owner's words (2026-10-17)

*"Allow a way to add a doctor to two department in OPD. One primary and one as a secondary. Since my hospital is
sort of doctors, I would like doctors to consult in two departments till I find specialist of the vacant
department."*

On money: *"charges would be department specific. yes, split by visits department"*. Asked what "department
specific" means for this build, the owner chose to **keep the fee as it is**.

## What is ruled

1. A doctor has one primary department (unchanged) and at most one secondary, with a first day and an optional last
   day. Ending it is the way back once the specialist joins.
2. **Money.** The consult price stays the hospital-wide price per visit type (new / renewal / revisit). The visit type
   is counted in the visit's department, so a patient's first visit in the secondary department is a NEW visit there
   even if the same doctor saw them in the primary one. Any payout or revenue split goes by the visit's department.
   A price per department is a separate change, not part of this ruling.

## DECIDED by the agent (standard practice, not owner rulings)

- A weekly schedule session may name the department it serves; a session naming none serves either.
- Ending a secondary keeps past visits where they were seen; booked appointments in that department after the last
  day go to `needs_rebooking`, as with leave.
- Lab, radiology, roster units, pace and bench stay on the primary department.
- The doctor keeps ONE queue per day; each row says which department the patient came to.
