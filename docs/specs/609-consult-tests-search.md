---
issue: 609
status: approved
approved: 2026-10-10
---
# SPEC — mobile consult: search the LIMS test list in the Tests tab

**Status:** APPROVED by the owner 2026-10-10 (free-text tests: NO). Not built. Module: apps/mobile consult (+ opd/lab
reads as needed; lab is a leaf module).

## Known now
- Tests tab only offers diagnosis-based suggestions (`/opd/cds/suggest/tests`); there is no search box.
- One master list exists: `GET /lab/catalogue/search?q=` (modules/lab/lab-catalogue.controller.ts ~165, permission
  `lab.catalogue.read`, active orderables, code or English name, ≤100 rows). Check the doctor role holds it
  (scripts/seed-roles.ts); if not, that is a shared-file change to coordinate (pinned permission counts).
- The lab desk already reads the visit's `advisedTests` (modules/lab/desk.ts advisedLinesFor). Confirm what an
  advised test must carry (serviceId / code) for the desk to show and bill it, and make the picked test carry it.
- Staging's lab catalogue is EMPTY (memory: uat-lab-catalogue-seed-missing-fixture) — fill it first or the walk shows nothing.

## Spec
1. Tests tab gets a search box; from 2 letters it searches the LIMS list by name or code: single parameters and panels.
2. A pick adds the test to the visit (advisedTests) with its catalogue identity; chips show picked tests as today.
3. No free text: a test not in the list cannot be added; the empty result says "Not in the lab's list — ask the lab to add it".
4. The lab desk shows the doctor's picked test under that patient's visit, unchanged path.
5. Diagnosis-based suggestions stay above the search.

## Done means
- Typing "hb" or "cbc" lists catalogue rows; picking one shows on the visit and on the lab desk for that patient.
- A name not in the catalogue offers nothing to add.
- Phone suite green under the lock; walked on staging with a filled catalogue; real phone check.
