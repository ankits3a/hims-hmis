---
type: decision
id: "0079"
title: "My pace: a doctor sees their own time per patient beside the department's and the hospital's anonymous average — never another person's figure, with minimum samples, shown neutral"
description: "Owner 2026-10-09: each doctor (and vitals staff) sees own average time per consultation against department and hospital averages. Extends decision 0042. Floors: own ≥ 10 consultations; a group average ≥ 3 people and ≥ 30 consultations. Doctor half shipped in #564 (#562); vitals half waits for a taken-in-hand time."
generated: { by: agent:claude, at: 2026-10-15 }
verified: []
status: stable
ruling: ruled
tags: [opd, doctor, vitals, staff, reports, privacy, mobile]
supersedes: []
superseded_by: []
sources: []
---
# 0079 — My pace: own time per patient beside anonymous averages

- **Date:** 2026-10-09 (recorded 2026-10-15, #648)   **Status:** Ruled
- **Area:** opd (consult timing), mobile staff app, staff reports

## The owner's words (2026-10-09)

*"I also want each doctor to see their performance compared to other doctor's average. LEt the doctor see average
time per consultation compared to average of the department and average to the hospital. Same goes to Vitals staff
as well."*

## What is ruled

1. Each doctor sees **their own average time per consultation** beside the **department's** and the **hospital's**
   average. The same applies to vitals staff.
2. This extends decision 0042 ("Comparisons between staff: start with their own numbers"): an **anonymous average**
   may now sit beside a person's own number. **Never** another person's name, rank or individual figure.

## DECIDED (standard practice, told to the owner)

- **Time is not quality**, so it is shown **neutral**: no red or green, no arrows, no ranking.
- **Minimum samples, enforced on the server:** a person's own number needs ≥ 10 consultations; a group average needs
  ≥ 3 people **and** ≥ 30 consultations, otherwise "—". The response carries no other person's id, name, figure or headcount.
- Time is `consult_started_at` → `consult_completed_at` for visits completed on screen; paper, abandoned and
  out-of-bounds visits (under 1 or over 90 minutes) are left out and counted.
- **Vitals staff:** no number is shown until the time a patient is taken in hand at the bay is stored (one nullable
  `opd_vitals.taken_in_hand_at` sent with the save); until then an honest blank, never an invented number.

## Consequences / how to apply

- `GET /me/performance?period=today|7d|30d` (caller only), `apps/core/src/modules/opd/pace.ts`,
  `packages/contracts/src/my-pace.ts`; phone card and page "My pace".
- Shipped in #564 (joined staging build 0.15.0), which carried #562 (doctor half). The vitals half is owed.
