---
issue: 608
status: approved
approved: 2026-10-10
---
# SPEC — mobile consult: doctor adds an allergy, with suggestions as they type

**Status:** APPROVED by the owner 2026-10-10 (severity and reaction: yes). Not built. Module: apps/mobile consult
(+ whatever the server route needs; patients is shared by every module — no signature change).

## Known now
- Server: `POST /patients/:id/allergies` (apps/core/src/modules/patients/patients.controller.ts ~775) and
  entered-in-error exist. Substance search: `GET .../substances` (modules/formulary/formulary.controller.ts ~448);
  the prod formulary substances were adopted 2026-09-28.
- App shows active allergies only (src/screens/consult.tsx: doctorApi.allergies, red "Allergy · X" pills); no add.

## Spec
1. "+ Allergy" on the consult patient strip, beside the allergy pills.
2. A sheet (KeyboardModal): a search box; from 2 letters, matching substances from the formulary list appear.
3. Doctor picks one, then severity (Mild / Moderate / Severe, required) and reaction (free text, optional, e.g. "rash").
4. Save → the existing POST; the new red pill shows at once; the existing medicine-vs-allergy check sees it on the
   next medicine added and on already-added lines.
5. A substance not in the list: the doctor may type it (allergy is safety data; never block recording it) — DECIDED;
   it is saved as free text exactly as the server accepts. If the server refuses free text, say so in the handoff.
6. en + hi strings. Permission: whatever the POST route already requires; never widen it.

## Done means
- Typing "pen" shows Penicillin; picking it with Severe + "rash" saves; the pill appears without reopening.
- A medicine containing that substance now shows the allergy warning.
- No severity → Save disabled.
- Phone suite green under the lock; walked at 360 and 390 px; checked on a real phone.
