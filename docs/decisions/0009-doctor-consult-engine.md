---
type: decision
id: "0009"
title: "The doctor's consult engine: layouts, specialties, coding, stock on the prescription, referral fee"
description: "Consult layouts are admin defaults with doctor overlays, curated entries, and specialty profiles starting with ophthalmology."
generated: { by: agent:claude, at: 2026-09-23 }
verified: []
status: draft
ruling: partly-open
tags: [opd, cds, pharmacy, billing, printing]
supersedes: []
superseded_by: []
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0009 — The doctor's consult engine: layouts, specialties, coding, stock on the prescription, referral fee

- **Date:** 2026-09-23   **Status:** Partly open
- **Area:** opd (doctor's desk), cds, pharmacy, billing, printing

The owner unparked the Doctor Desk brainstorm after comparing our consult screen with Healthray, judging ours
"not good enough". Design doc: `docs/superpowers/brainstorms/2026-09-18-doctor-desk/01-CONSULT-ENGINE.md`
(lane `doctor-consult`, PR #307).

## Decision

**Layouts and profiles**
- Layouts are configured by the admin (a default per department) and by the doctor (an overlay on that default).
- A doctor cannot hide a mandatory section; the doctor may only reorder or collapse it.
- Curators are the department head, a medical-records officer and the admin. A doctor's own entries stay private to
  their screen until a curator promotes them. (The owner wrote "will reflect", read as "will NOT reflect"; confirm.)
- Specialty order: ophthalmology first, then paediatrics, then gynaecology. General medicine is the base profile.
- D19 DECIDED: the engine starts with ophthalmology as new sections only; general medicine moves onto the engine
  later. The owner was told and may reverse this.

**Work-up**
- First round: work-up is vitals only, with a toggle for full work-up mode. **Third round: the work-up toggle is
  WITHDRAWN.** The screen is chosen automatically by the doctor's registered department (general medicine, ortho,
  gynae, paeds, ophthal, dental). A doctor in two departments: the visit's department decides (D11).
- Eventually the optometrist, antenatal nurse or paediatric nurse fill whole sections.

**Coding**
- ICD-10 is primary and is the code stored. Show ICD-10 AND ICD-11; ICD-11 comes through the WHO map. A map to
  SNOMED comes later, for ABDM.

**Paediatric dosing and teleconsult (DECIDED to "top hospital standards")**
- Dosing sources: the IAP Drug Formulary, then BNFc, then Harriet Lane or Lexicomp.
- Every dosing rule is signed off by the Pharmacy & Therapeutics committee.
- Teleconsult is in scope and follows the Telemedicine Practice Guidelines 2020, with Lists O, A and B; Schedule X /
  NDPS drugs prohibited.
- Print languages: English and Hindi only.

**Keep from today's consult screen**
- The session drop-down (In / Out / Closed / Not started).
- Call next / Skip / Start / Park, which drive the display board.
- Allergies with "+ Add" and type-ahead.
- Complaint chips with × removal, which suggest diagnoses and drugs.

**Stock on the prescription**
- Every suggested drug and every Rx line shows the sellable stock count (FEFO available quantity).
- At 0, a small icon marks the line and the right pane suggests an alternative.
- The doctor may ignore it; the visit records "offered X, kept Y" as an audit row.

**The patient brief**
- Call next shows a brief in the middle column: the desk complaint verbatim, vitals, allergies, the last
  consultation note, labs and radiology since, and current medicines.
- Start consultation sits under the brief and opens the consult with the desk complaint already as chips.
- Reference: our own `OpdDesk.dc.html` board of 2026-09-18.

**Referral fee (money, ruled 2026-09-24)**
- A referred patient who consults the referred doctor or department within 7 days pays no fee. After 7 days the
  normal fee applies. Use the follow-up-days method (the `visit-type.ts` revisit window).

**Glasses prescription print**
- Prints the Doctor ID only (per the 2026-09-06 Doctor-ID-only ruling), and queues even when the print relay is
  down: owner ruled "keep queuing".

## Why

The owner judged the doctor's desk behind Healthray.

## Consequences / how to apply

- Build sections and profiles as data (the consult engine) before any specialty screen.
- Agents pick indexes from our catalogs with the ladder: usage → IDF / keyword matching → clinical-master rules →
  Jev → LLM last. There is no vector embedding in the consult path (the complaint ranker is IDF token scoring,
  `complaint-ranker.ts`).
- The referral fee is keyed on `opd_encounters.referred_from_encounter_id` (PR #308, migration 0122), never on the
  desk's `referral_source` drop-down. Consult shows a REFERRAL badge.
- Brief readers: PR #309. Ophthalmology sections #312, eye-drop line #313, "which eye" #315, glasses print #317,
  layout builder #318.

## Open

- The licence for a paediatric dosing source costs money and needs an owner ruling.
- Whether a doctor's own entries reflect to others before promotion ("will reflect" wording) is to be confirmed.
- Gap at the time: Desk One's complaint was used for triage only and not saved on the visit; carrying it through
  needs a migration.
