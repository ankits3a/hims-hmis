---
issue: 962
status: built
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

## Build notes (2026-10-26, lane dd-ward-962)

- **Stamp:** `ipd_admissions.admitted_under_team_id` (migration 0262, renumbered at merge), written once in every admit
  path (`ipd/unit-stamp.ts stampUnitIn`). ER: `unitOnTake` of the admission's department (else the consultant's unit's)
  at the ER arrival — the emergency module hands `erArrivedAt` to `emergencyAdmit`; no take window → consultant's
  unit; neither → null (absent). Unit change: `ipd_unit_transfers` row + `ipd.admission.unit_transferred`
  (`transferUnit`, a consultant of the old or new unit; no screen).
- **Reads (`ipd/unit-reads.ts`):** `unitCensus`, `admissionsUnder`, `bedsOf`, `changesSince`, `lastSeenBy`, plus
  `latestVitalsOf`, `roundsBy`. Take day 08:00 → 08:00 IST. "In your ward" = a bed the roster allots the unit, else a
  ward of the unit's department; otherwise an outlier. Flags: open EWS breach → critical; assessment or vitals overdue
  → owed; active fit declaration → could go home. LAMA counts the `lama` end state.
- **Desk:** `doctor-desk/ward.ts` — Tower `ward` (null when IPD is off or no unit), `GET /doctor-desk/ward/beds`,
  `GET /doctor-desk/ward/round/:admissionId` (404 `ward_closed` while IPD is off). Web: Tower inpatient tiles + bed
  map, `/doctor-desk/beds`, `/doctor-desk/round/$admissionId`, Beds phone tab and menu entry only while IPD is on.
  Notes: `lib/round-queue.ts` (IndexedDB, client id = `signRound` idempotency key; signed-at = `seenAt`, synced-at =
  the row's `created_at`).
- **Absent in part 1:** owed-on-this-bed and tasks to a named resident, unaccepted inpatient referrals, "waiting in
  casualty", "Pull today's vitals + labs in" — part 2 or later modules.

