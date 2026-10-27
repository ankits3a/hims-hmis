---
issue: 973
status: built
approved: 2026-10-26
built: 2026-10-26
---
# SPEC — Housekeeping HK-1: teams, rounds, checklists, confirmation, door-QR requests (#973)

Status: APPROVED 2026-10-26 by the owner. This builds on bed turnover (#721, decision 0072). The owner's rulings for
this spec are in decision 0086.

## What

The housekeeping department runs on the operating system. Floors are teams; inside a ward each attendant owns a bed
section. Public toilets, lifts and the OPD run as walking routes, and critical areas have a trained team. Work arrives
by five doors: a bed released, a scheduled round, a request, a spill and a failed check. Each task is proved at the
place with a QR scan, a checklist and a photo where needed. A nurse or the supervisor confirms it with Pass or Fail.

- **Areas.** Every floor, room, toilet and public space gets an area class (A critical, B clinical, C toilets, C public,
  D support) and a door QR.
- **Staff.** Each attendant is marked in-house or with a named contractor, and carries trained skills (critical, spill,
  terminal). There is no fixed headcount: the rota shows load per person.
- **Rota.** The supervisor places people per shift (floor-wise, area route or bed section) and publishes the rota. Each
  person then has their own list on the phone.
- **Rounds.** Rounds are raised automatically from the area's class. A round not scanned by its due time is missed.
- **Work.** The attendant scans the door QR, answers every checklist item and takes one photo for a bed or toilet.
- **Confirm.** A nurse or the supervisor chooses Pass or Fail, and a fail needs a reason. A fail reopens the task as
  rework, and a second fail goes to the supervisor. A bed is ready only after a pass.
- **Requests.** Any staff member can raise clean, toilet, spill or bin. A patient can raise the same four from the door
  QR without a login. No patient data is collected. The request goes to that floor's team.

## Decisions

- Contractors get reports only, with no bill deductions (owner, 0086). The contractor SLA report, consumables per floor
  and the department reports belong to HK-2 (#974).
- DECIDED by standard practice: the doer never confirms their own work, and escalation goes to the role on shift.
  Photos never show a patient. Wall boards show initials only.

## Done means

- **D1** An area can be given a class and a QR code. The area's round appears at shift start with its due time.
- **D2** A published rota puts each task on its owner's phone list. A discharge clean goes to the floor team, not to
  one person.
- **D3** A task cannot be marked done without a QR scan at the place and every checklist item answered. A bed or toilet
  also needs a photo.
- **D4** A fail needs a reason and reopens the task. After a second fail, the task appears in the supervisor's
  "Needs you" list.
- **D5** The person who cleaned never confirms their own clean. A terminal clean is confirmed only by the supervisor or
  infection control.
- **D6** A round not scanned by its due time shows as missed on the supervisor board.
- **D7** A request from a door QR, with no login, reaches the floor team and can be closed.
- **D8** Contractor staff do the same tasks with the same proof, and every task records the company the person works for.

## Build notes (2026-10-26)

Built on lane `hk-rounds-973`. Acceptance checks: `apps/core/src/modules/housekeeping/acceptance/rounds-973.acceptance.test.ts`
(D1–D8) and `apps/web/src/screens/acceptance/housekeeping-rounds-973.test.tsx` (D6, D7). Choices made by standard
practice or from the design board, none of them money or law:

- Shifts are 07–15, 15–23 and 23–07 IST, as on the design board. A class B round is raised at each shift start.
- Placement applies only while a rota is published for the shift. With no rota, tasks go out as before.
- A task needs the scan, checklist and photo only when its place is, or lies inside, a set-up area. A bed clean in a
  ward that is not set up yet keeps the old tap.
- The door page offers the four needs from the spec, with no free-text note: a note could carry patient details.
  "Linen change" and "Pests" from the board belong to other modules and come later.
- Infection control is a new role. It confirms terminal cleans beside the supervisor.
