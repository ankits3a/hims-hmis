---
issue: 610
status: approved
approved: 2026-10-10
---
# SPEC — mobile consult: edit a saved set ("My sets")

**Status:** APPROVED by the owner 2026-10-10 (standard behaviour, no open question). Not built. Module: opd (server)
+ apps/mobile consult.

## Known now
- Routes: GET/POST `/opd/rx-sets`, POST `/opd/rx-sets/:id/sign`, DELETE `/opd/rx-sets/:id`
  (modules/opd/opd-phone-consult.controller.ts; logic modules/opd/rx-sets.ts). No update.
- App: SetsDrawer in src/consult/sheets.tsx (~629) can use, save new, retire.

## Spec
1. Server: an update route for a set — name and body (lines, tests, advice). Same guards as save: a doctor edits only
   own sets; a department head may edit the department's shared sets (headOf). Audited like save/retire. If sets are
   signed (`/sign`), an edit of a signed set needs re-signing — follow what `signRxSet` implies, note it in the handoff.
2. App: tap a set → "Edit" opens it into the consult editor (medicines, tests, advice) with the name editable;
   "Save set" writes over it; "Cancel" leaves it unchanged. Sets the doctor cannot edit show no Edit.
3. Patients already prescribed from the old version are unchanged.

## Done means
- Edit own set: change one medicine and the name, save, reopen: the change is there.
- Another doctor's set: no Edit; the route refuses with 403.
- A head edits a department set; a non-head cannot.
- core tests for the route (fail first), phone suite green, real phone check.
