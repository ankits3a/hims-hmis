---
issue: 1025
status: built
approved: 2026-11-02
---
# SPEC — Change a patient's doctor from the vitals screen (#1025)

## What

Vitals staff can move one patient to another doctor without sending them back to the front desk. The owner approved
this on 2026-11-02.

## Decisions

1. **Which doctors:** the same department only. The fee and the token stay valid. "Move department" on the front desk
   stays the road to another department.
2. **Who:** a new narrow permission, `opd.vitals.change_doctor`, for `vitals_desk`. It moves one patient. It does not
   carry the bulk queue transfer or a paper consult reopen, which `opd.queue.transfer` does.
3. **Where:** the web vitals bay and the phone app.
4. **Consent:** the patient's agreement is ticked and a reason is given, as the queue transfer already requires.
5. **Doctor list:** active doctors of that department who sit today and are not on leave.

## Done means

- D1: A change moves one patient to the new doctor with the same token and queue place.
- D2: The old doctor's line no longer shows the patient, and the new doctor's line does.
- D3: Vitals already saved stay on the visit.
- D4: A change is refused once the consultation has begun.
- D5: `vitals_desk` holds the narrow permission and not `opd.queue.transfer`.
- D6: Each change is audited with who, from, to and reason.
- D7: The doctor list holds only active doctors of the department who sit today and are not on leave.
