# 0024 — The 22-unit establishment; OPD screens show the unit; the e-prescription prints the unit, not the doctor; one room per doctor

- **Date:** 2026-10-04   **Status:** Partly open
- **Area:** roster, opd, printing, legal

## Decision

**1. Unit establishment.** Source table: `/opt/hmis-context/roster-ux-tools/crkmch-min-units-per-dept.png`. This
supersedes the 2026-09-20 split (5/5/3/3/4/2/2/1/1 + RESP).

| Department | Units | Beds |
|---|---|---|
| General Medicine | 5 | 150 |
| General Surgery | 5 | 150 |
| Obs & Gynae | 3 | 75 |
| Paediatrics | 3 | 75 |
| Orthopaedics | 2 | 60 |
| Ophthalmology | 1 | 20 |
| ENT | 1 | 20 |
| Psychiatry | 1 | 15 |
| Dermatology | 1 | 10 |
| Combined ICUs | — | 30 |
| **Total** | **22** | **605** |

Respiratory Medicine has no unit. Only Unit I is active today, in MED, SUR, ENT, OBG and ORT.

**2. OPD screens** show the unit beside the doctor's name, e.g. "Dr. Chandan · Unit I". Guest faculty show as
"Dr. S.I Raza · Guest Faculty".

**3. OPD e-prescription header** (final, after the owner's same-day refinement, which replaced the first version of
this item):
- Fields in this order: Name · UHID · Gender · Age · Address · Unit Number · Encounter ID · Encounter Type · Visit
  Date/Admn Date · Dept. Regn.
- No separate "Dept" field: the department NAME prints just below the logo.
- The doctor's name is never printed anywhere. The words "Guest Faculty" are never printed.
- **Unit Number:** a unit doctor gets the unit ("Unit I"). Guest faculty, and (DECIDED) anyone in no unit, e.g.
  Community Medicine, get their Doctor ID in this field.
- **Dept. Regn** (one field) = the council registration number of THAT DAY's head of the unit concerned (Professor,
  Associate or Assistant Professor heading it; an officiating head counts), NOT the prescribing doctor's own:
  - unit doctor → their unit's head;
  - doctor in no unit (guest faculty) → head of the unit holding the visit department's OPD that day (e.g. Raza on
    Monday in MED → MED Unit I's head);
  - department with no unit (Paediatrics, Community Medicine) → blank;
  - head's number not entered → blank (no placeholder).
- **Encounter ID:** `visit_no`. **Encounter Type:** OPD. **Visit Date:** the OPD visit day.
- **Address:** as registered; the row is omitted when empty, and for a sealed (§14) patient.
- For unit doctors this supersedes the 2026-09-06 "print the Doctor ID only" ruling (now recorded as 0033).

**4. Rooms.** One room per doctor, at most 4 rooms per department:

| Room | Doctor |
|---|---|
| R1 | Raza |
| R2 | Chandan |
| R3 | Yash Vardhan |
| R4 | Saurabh Ranjan |
| R5 | Shishir Jha |
| R6 | Sonam Kumari |
| R7 | Ritu Kumari |
| R8 | Kishore Kunal |
| R9 | Suryendru Kumar |
| R10 | Nitish Kumar Jha |

## Consequences / how to apply

- Code: `roster/doctor-units.ts` (`prescriberPrint`), `kernel/printing/render.ts` (A4 sheet),
  `opd/prescriptions.ts` (e-Rx payload), `components/rx-print.tsx`.
- The OPD admin doctors tab names every unit head with no registration number
  (`GET /roster/unit-heads-without-regn`).

## Open

- **Flagged to the owner (law):** the Indian Medical Council Regulations 2002 (1.4.2) and the telemedicine guidelines
  expect a prescription to identify the RMP by name, qualification and registration number. Hiding the name is the
  owner's legal call; it was implemented as the owner ruled.
- The owner must enter the unit heads' council registration numbers (all were empty on staging on 2026-10-04).
