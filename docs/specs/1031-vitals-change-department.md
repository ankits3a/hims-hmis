---
issue: 1031
status: built
approved: 2026-11-03
---
# SPEC — Change a patient's department (and doctor) from the vitals screen (#1031)

## What

Vitals staff can move one waiting patient to another department and pick a doctor there, without sending the patient
back to the front desk. Owner 2026-11-03: yes to all recommendations below.

## Decisions

1. **Who:** a new narrow permission, `opd.vitals.change_department`, held by `vitals_desk`. One patient at a time, with
   the patient's agreement ticked and a reason, as change doctor (#1025).
2. **Where:** the existing "Change doctor" sheet on the web vitals bay and the phone app gains a Department picker,
   set to the current department. Same department = change doctor as today. Another department = this move.
3. **Same server rules as the front desk move** (`moveVisitDepartment`): the old visit is closed and a new visit and
   token are opened in the new department; the OPD report corrects itself. Refused once the consultation has begun.
4. **Money:** the move goes ahead from the vitals screen only when the fee needs no collection (a ₹0 bill, or the same
   fee). A fee difference, or a bill with anything else on it, is refused with "send to billing counter". Vitals staff
   never take money.
5. **Queue place:** the patient joins the new department's line by original arrival time, not at the end.
6. **Vitals carry over** to the new visit, for this move AND for the front desk move.
7. **New token:** shown large on screen after the move, for staff to write on the old slip by hand. A "print new token
   slip" action is built for users holding the move permission, behind a hospital setting that is OFF.
8. **Doctor list:** active doctors of the new department who sit today and are not on leave (as #1025).

## Done means

- D1: A vitals-desk user moves a waiting patient to another department and doctor; the old visit is closed and a new
  visit with a token from the new department's series is opened.
- D2: The new department's line places the patient by original arrival time.
- D3: Vitals already saved on the old visit appear on the new visit, for the vitals-screen move and the front desk move.
- D4: The move is refused once the consultation has begun.
- D5: The move is refused from the vitals screen when the fee differs or the bill holds anything besides the consult
  fee; no money is taken or refunded.
- D6: `vitals_desk` holds `opd.vitals.change_department`, and not `opd.visits.open`.
- D7: Each move is audited with who, from department/doctor, to department/doctor and reason.
- D8: After the move, the screen shows the new token number.
- D9: With the print setting off, no print action is offered and no print job is queued; with it on, a user holding the
  permission can print the new token slip.

## Built (2026-11-03)

- Server: `apps/core/src/modules/opd/vitals-department-move.ts`, on top of the front desk's `moveVisitDepartment`.
  Routes `GET|POST /opd/visits/:id/change-department` and `POST /opd/visits/:id/print-moved-token`, all on
  `opd.vitals.change_department`.
- DECIDED: queue place by original arrival (D2) applies to the front desk move as well, through the one server path.
- DECIDED: the `opd_visit` workflow lets only the front office abandon a visit, so the vitals move's abandon step runs
  as a named system actor (as `patient-absent.ts` does); every event still names the person.
- DECIDED: no bill and a free consultation also counts as "no collection". No bill and a fee to pay is refused.
- DECIDED: with the print setting off, the vitals move queues neither the token slip nor the A4 sheet. The setting is
  `opd_config.vitals_move_print_slip` (migration, default off), changed through `PUT /opd/config`. No admin-screen
  toggle yet.
- Web and phone: the "Change doctor" sheet shows the Department picker to holders of the permission, only while vitals
  are not yet saved (as #1025). After a move the patient stays in hand on the new visit.

## Change 2026-11-10 (owner)

Staff could not change the doctor or department once vitals were saved: the web and phone screens offered "Change
doctor" only while vitals were not yet saved. The owner asked for it after vitals too. Both screens now offer it for a
patient whose vitals are done. The server rules are unchanged: the change is refused once the consultation has begun,
and a department move carries the saved vitals to the new visit (D3).

