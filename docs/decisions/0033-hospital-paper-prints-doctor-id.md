---
type: decision
id: "0033"
title: "Hospital paper prints the Doctor ID, never the doctor's name or registration number"
description: "Printed hospital documents carry the Doctor ID, never the doctor's name or council registration number."
generated: { by: agent:claude, at: 2026-09-06 }
verified: []
status: stable
ruling: ruled
tags: [printing, opd, legal]
supersedes: []
superseded_by: ["0024"]
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0033 — Hospital paper prints the Doctor ID, never the doctor's name or registration number

- **Date:** 2026-09-06   **Status:** Partly superseded — by 0024 for the OPD e-prescription
- **Area:** printing, opd, legal

## Decision

- Owner: *"As a medical Institution with college, there's no need of mentioning Dr. Name and their registration
  number. Only Dr. ID is required."*
- Every printed hospital document carries the Doctor ID (`opd_doctors.code`, `DR-nnnn`), never the doctor's name or
  council registration number.
- **Re-confirmed 2026-09-28** for the e-prescription: "Prescription print: Doctor ID only." The owner was told that
  NMC professional-conduct rules expect a prescription to carry the prescriber's name and registration number, and
  ruled Doctor ID only anyway.
- Same conversation, 2026-09-28: the ICD-11 shown for an ICD-10-CM subcode stays as it is, with **no fallback to the
  parent code**.

## Why

The owner's reading of a teaching hospital's paper: the institution, not the individual doctor, issues it.

## Consequences / how to apply

- Before specifying any new printed document, read the departure block above `renderPrescriptionSheet` in
  `apps/core/src/kernel/printing/render.ts`; ruling recorded there as departure 3.
- Exceptions recorded elsewhere: the signing pathologist on a lab report prints in full (0010 ruling 11, plus the
  council number); the signing radiologist likewise (0015). Referring doctors stay Doctor ID only.
- **Superseded for the OPD e-prescription by 0024 (2026-10-04):** a unit doctor's prescription prints the unit
  ("Unit Number") and that day's unit head's registration ("Dept. Regn"); only a doctor in no unit gets the Doctor ID
  in the Unit Number field. Still no doctor name.
