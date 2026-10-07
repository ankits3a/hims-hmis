---
type: decision
id: "0015"
title: "Radiology: every open decision defaults to what top Indian hospitals do"
description: "Every open radiology decision (films, CDs, outside reads, GST, prices, safety, PACS) defaults to what top Indian hospitals do."
generated: { by: agent:claude, at: 2026-09-28 }
verified: []
status: stable
ruling: ruled
tags: [radiology, billing, printing, radiation-safety, pacs, teleradiology]
supersedes: []
superseded_by: []
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0015 — Radiology: every open decision defaults to what top Indian hospitals do

- **Date:** 2026-09-28   **Status:** Ruled
- **Area:** radiology, billing (GST, prices), printing, radiation safety, PACS, teleradiology

Owner, about the radiology board (https://claude.ai/artifact/SF4wW61FajAk6hMfn2ShPw): *"Whatever requires my
decision, consider the industry practices and default to what top hospitals of India follows."* Each item below is
marked "DECIDED · 28 Sep" on the board.

## Decision

**Films, CDs and outside reads**
- The digital report and image link are always free.
- An X-ray includes one film.
- Film for CT, MRI or USG is ₹250 per sheet, on request.
- A CD is ₹300.
- An outside second-opinion read is ₹600 for X-ray or USG and ₹1,500 for CT or MRI.

**GST**
- Imaging is exempt healthcare, SAC 9993 (Notification 12/2017-CT(R), entry 74). Film and CD given with the study
  are part of that composite supply. The `investigation` category is 0%. A CA confirms the 6-digit SAC at the first
  filing.

**Contrast**
- Contrast and premedication are included in CECT and contrast-MRI prices. If contrast is not given, the contrast
  component is reversed through a bill decision.

**Printed report**
- Carries the signing radiologist's or sonologist's name, qualification, council registration number and digital
  signature. This extends the lab-pathologist exception (0010 ruling 11) to the 2026-09-06 Doctor-ID-only ruling.
  Referring doctors stay Doctor ID only.

**Radiation safety (18c R1–R4)**
- The RSO is an AERB-certified RSO (Bikash Mondal), with a certified radiologist as alternate.
- No medical physicist is needed for diagnostic X-ray or CT.
- QA by an AERB-recognised agency at acceptance, every 2 years, and after major repair.
- TLD badges from a BARC-accredited service, read quarterly.
- Investigation level: 1 mSv per month (3 mSv per quarter).

**PACS (18b R1–R3)**
- On-premise Orthanc with the OHIF viewer.
- Two 3 MP monitors per reading station; two 5 MP for mammography.
- MWL/MPPS licences are bought per modality.
- Images stay online for 5 years, then go to archive; MLC cases and minors are kept longer.

**Teleradiology (O-1)**
- A contracted Indian provider with NMC-registered radiologists; data stays in India.
- A DPA under the DPDP Act.
- Preliminary read within 30 min for STAT and 60 min for urgent; a consultant over-reads the next morning.

**Other**
- The pregnancy screen covers ages 10–55.
- TPA cashless needs pre-auth before an MRI or CT; otherwise the patient pays a deposit.
- No discount at the counter. The HOD can give up to 10%. Credit stays owner-only (0013).

**Extended the same night:** *"keep working … Whenever you need my decision then don't ask me … Simply default to
top hospital standards. IF anything which I don't like, I will ask to revert after the build."*
- Build RS4 through RS12 without stopping to ask.
- Every call is DECIDED at top-Indian-hospital standard and recorded in the plan's "as built" section; the owner
  reviews and reverts afterwards.
- Still never deploy to production without the owner's explicit word. A deploy is outward-facing and is not a build
  step.

## Why

The owner wants no open questions blocking the radiology build, and trusts the industry standard.

## Consequences / how to apply

Do not re-ask any of these. Future radiology gaps: pick the top-Indian-hospital answer, mark it DECIDED, keep going.
