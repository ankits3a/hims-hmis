---
issue: 607
status: approved
approved: 2026-10-10
---
# SPEC — mobile consult: "Complaint" button, "Notes" moves last, scrollable row

**Status:** APPROVED by the owner 2026-10-10 ("Rename Notes to Complaint. But also keep Notes in the last to let
doctor add his own general notes for reference. Keep the scrollable."). Not built. Mobile only, JS only (OTA-able).
**Why:** the owner could not find chief complaint; it lives inside the "Notes" drawer (src/consult/sheets.tsx
NotesDrawer, `mobile.consult.complaint`), and the label hides it.

## Spec
1. Bottom row on the consult screen (src/screens/consult.tsx `five`): **Complaint · Diagnosis · Medicines · Tests ·
   Advice · Notes** — six buttons in a horizontal ScrollView, so more can join later. Buttons keep a readable
   minimum width; the row shows that it scrolls (the last button is partly visible at 360 px).
2. **Complaint** drawer: what NotesDrawer has today minus the free-text box — the complaint chips, search
   (`/opd/cds/complete/complaint`), and the "Told the desk" words. Saves to `chiefComplaint` as today. Badge ✓ when
   any complaint is set.
3. **Notes** drawer: the free-text box only (`doctorNote`, 4000 chars) and the voice dictation (it already appends
   to notes). Badge ✓ when notes are non-empty. DECIDED: voice stays with Notes.
4. Visit card ("This visit"): two lines, "Complaint" and "Notes", instead of one joined line.
5. `doctor_note` stays the doctor's reference: as far as a grep shows it is not printed and not sent to ABDM
   (opd/abdm-release.ts says NOT doctor_note). Verify the printed prescription does not carry it; do not change that.
6. en + hi strings: five.complaint "Complaint" / "शिकायत"; keep five.notes "Notes". No server or migration change (web changes only for the Hold wording below).

## Done means
- Six buttons in the order above; at 360 px the row scrolls and every button is reachable.
- Choosing "Fever" in Complaint sets chiefComplaint "Fever" and shows ✓ on Complaint only.
- Typing in Notes sets doctorNote and shows ✓ on Notes only; the printed prescription does not show it.
- An old visit with both fields opens with each in its own drawer and its own card line.
- Phone suite green under the test lock; walked on a phone or a stub-API browser at 360 and 390 px.

## Added 2026-10-10 (owner): "Park patient" becomes "Hold patient"
- Wording only, mobile AND web, en + hi (hi: "होल्ड"): park → "Hold patient", parked → "Held", "Parked {{minutes}} min" →
  "On hold {{minutes}} min", "Parked just now" → "On hold just now", "Token {{token}} parked" → "Token {{token}} on hold",
  web parkedHint likewise. Keys, routes, statuses and code names stay `park` (no server or data change).
- Done means: no visible "Park"/"Parked" left in either locale of either app (grep the locale files); tests updated.
