---
issue: 962
status: approved
approved: 2026-10-26
---
# SPEC — Doctor Desk: the ward, part 1 (unit stamp, tower inpatient mode, Beds, Round) (#962)

Status: APPROVED 2026-10-26 by the owner ("go with your logical recommendation"). Source: plan `docs/superpowers/plans/2026-10-04-doctor-desk-PLAN.md`
§3.4 (DD-IPD.1, .3, .4) and §4.1. A seam audit of the IPD train (#967) on 2026-10-26 found that no IPD read is keyed by
unit. Part 1 therefore adds the unit seams first. Part 2 is a separate spec: countersign chain JR → SR → Professor,
6-hour senior review clock, briefs, and the unit report.

## What

- **Unit stamp (IPD).** Each admission records its unit once, at admission: the consultant's unit, or for an ER
  admission the unit on take at ER arrival. A change of unit is a transfer row and an event, never an edit.
- **Unit reads (IPD).** IPD exports three reads: patients admitted under a unit, the take-day census for a unit, and
  the unit's beds. A bed's flag is critical (EWS breach open), owed (an overdue task) or fit for discharge. A unit
  patient in another unit's ward is shown as an outlier.
- **Tower, inpatient mode.** Tiles and a bed-dot map from these reads. A figure the reads cannot give stays absent;
  it never shows as zero.
- **Beds (phone).** Beds in walk order, with a sickest-first sort by EWS score. A mark shows a change since *my* last
  signed round.
- **Round (phone).** One bed: "since you last saw" lines, each with its source; the vitals strip with the EWS score;
  the round note and Sign, through IPD's existing `signRound`. Notes save on the phone first and replay once.

## Decisions (DECIDED by standard practice)

- The unit is the consultant's unit at admission. The Desk reads IPD only through `ipd/index.ts` and never writes a
  bed or a clinical row (plan D-A).
- Offline notes: a client id makes a replay a no-op. A note signed offline keeps its signing time and its sync time.

## Done means

- **D1** Every new admission has a unit, and an ER admission at 07:55 entered at 08:10 belongs to the night's unit on
  take.
- **D2** The unit census for a take day equals a hand-counted fixture (admitted, discharged, LAMA, deaths, transfers
  in and out, occupied).
- **D3** The tower's inpatient tiles equal the census, and each bed dot's colour equals the bed's flag from IPD.
- **D4** Beds lists a unit patient lodged in another ward under "Not in your ward".
- **D5** The change mark on Beds is per doctor: a round signed by one doctor clears the mark for that doctor only.
- **D6** Five round notes signed with the phone offline land exactly once after reconnecting, each with its signing
  time and sync time.
