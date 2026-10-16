---
issue: 630
status: built
approved: 2026-10-12
---
# SPEC — Quick lab on the phone app (owner 2026-10-12: "go ahead")

Status: APPROVED 2026-10-12 (owner: "go with your recommendation and build" — no phone printing, no Lab counter on phone).

## What
Three new phone screens, the same three steps as the web quick chain, shown only while the lab mode is **Quick**.
Each screen is behind the same permission as its web menu.

1. **Quick Collect** (`lab.worklist.read`): the list of patients waiting for a blood sample, oldest first. Tap a
   patient, see their tests, press **Blood collected**. The sample number is stamped and the patient moves to the
   bench. A UHID card scan opens that patient.
2. **Quick Bench** (`lab.results.enter`): the list of collected samples. Tap one to open its results form, one
   field per parameter. Each field shows the normal range and flags high or low values. Calculated values (LDL,
   ACR, …) fill themselves and cannot be typed. Buttons: **Save draft**, **Save & Complete**.
3. **Quick Reports** (`lab.reports.print`): completed reports. Shows a read-only preview. Buttons: **Hand over**
   (marks it handed over) and **Send back to bench**. Printing stays on the desk PC (or the HMIS Print program).
   The phone does not print.

Not on the phone: the Lab counter (starting a lab visit and its bill stays at the desk PC), Full lab mode, and
pathologist signing.

## Done means
- A phlebotomist's phone shows Quick Collect. Collecting a sample there moves it to Quick Bench on web and phone.
- A technician enters CBC and lipid results on the phone. LDL and the out-of-range flags match the web. Save &
  Complete puts the report in Quick Reports on the web, and it prints the same.
- A user without the permission does not see the screen. When the lab mode is Full, all three screens disappear.
- Text fits one line at 390 px wide (owner rule). Hindi strings are present.
- Phone tests pass and typecheck is clean. A new APK version goes to staging first, then production after the
  owner's OK.
