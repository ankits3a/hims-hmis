---
issue: 1127
status: built
approved: 2026-11-19
---
# SPEC — OPD Admin → Doctors works like the Users screen (owner 2026-11-19)

## What

The owner could not edit a doctor's display name, and adding a doctor meant copying a username from the Users screen
and pasting it here. The owner holds up the Users screen (`/admin/users`) as the control and experience wanted.

The Doctors tab is rebuilt on that pattern: a search box and filter tags over a short list, a side panel per doctor
where every edit lives, and a New doctor panel that suggests staff. One build. The Users screen is not touched.

## Decisions

- The Doctor ID (`DR-nnnn`) is fixed once minted (owner ruling 2026-11-19, decision 0100). The server refuses a change;
  the panel shows the id and has no box for it.
- Deactivating a doctor, or changing their department, never moves a patient to another doctor by itself. Their booked
  appointments become `needs_rebooking` and the front desk rebooks them, as a doctor's leave does (DECIDED: the patient
  chose that doctor, so the desk asks).
- A department change to the doctor's running second department is refused: end the second department first (DECIDED).
- Sessions in the weekly schedule that named the old primary department explicitly follow the doctor to the new one
  (DECIDED: a session cannot serve a department the doctor no longer belongs to).
- No tick-several-rows bulk action: about 40 doctors (DECIDED).
- Change history starts with this build and is read from the event log. Older changes show only "last changed by, on".
- The New doctor search shows an OPD admin each staff member's name, username, staff code and whether they hold the
  doctor role — nothing else from user administration.
- The booked-appointment check shows counts per day, not patient names (DECIDED: a masters screen carries no patient data).

## Done means

- D1: The search box finds a doctor by name, Doctor ID, username, registration number or department. The filter tags
  narrow the list: All · Active · Inactive · No registration number · No schedule this week · Second department.
- D2: Tapping a doctor opens a side panel. Display name, registration number, specialty, designation, department and
  second department can be edited and saved there, and the list then shows the new values.
- D3: The panel shows the Doctor ID but has no box to change it. The server rejects any change to a Doctor ID and keeps
  the old one.
- D4: In New doctor, typing two or more letters of a name, username or staff code lists active staff who are not
  doctors yet, with doctor-role staff first. Picking one fills in the username and "Dr. <full name>". Anyone who is
  already a doctor is never offered.
- D5: Before deactivating, the panel lists the doctor's future booked appointments and today's waiting patients.
  Confirming marks the booked appointments "needs rebooking", and the front desk sees them.
- D6: Before a department change, the panel shows the same check. Confirming marks the booked appointments in the old
  department "needs rebooking".
- D7: The panel lists every change made after this build: the field, old value → new value, who changed it and when.
- D8: The panel shows the weekly schedule and leaves (view only), with a button that opens Schedules & leaves for that
  doctor.
- D9: The yellow "no registration number" note names each doctor as a link that opens their panel at the registration
  number box.
- D10: At phone width (390 px) there is no sideways scrolling and every control can be reached.

## Built (2026-11-19)

- Server: `apps/core/src/modules/opd/doctor-admin.ts` (admin list, staff search, change check, history),
  `doctor-cascade.ts` (the rebooking predicate the check and the change share), `masters.ts` `updateDoctor`.
  Routes `GET /opd/doctors/admin`, `/candidates`, `/:id/impact`, `/:id/history`; `PATCH /opd/doctors/:id` now
  returns the bookings sent to rebooking and today's waiting count.
- Web: `apps/web/src/screens/opd-admin-doctors.tsx` on `admin-users.css`.
- Beyond the letter of D7: the history also shows the doctor's creation and the second department's start and end.
- Today's waiting patients are reported, not moved, on deactivation (the leave rule): they stay in the queue and the
  desk moves them with the patient's consent.
- D10 was checked in Chromium at 390 px and 1366 px: no sideways scroll on the list, the panel or New doctor. That walk
  found one defect, now fixed with a test: Escape on the deactivate check closed the panel behind it.
