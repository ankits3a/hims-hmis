# Slip desk (/opd/slips) — board notes, 28-Sep-2026

Board: `slip-desk.html` (desktop 1440 working state; states A empty, B refusal, C camera, D filed; phone 390).
Grounded in `apps/web/src/screens/slip-capture.tsx`, `GET /opd/visits/by-number/:visitNo`
(returns encounterId, patientId, visitNo, serviceDate, patient summary incl. uhid, name, administrativeGender, dob),
`POST /patients/:id/documents` (imageBase64, mimeType, kind, encounterId, note) and `GET /patients/:id/documents`.

## What changes and why
- No page padding (flush at x=0) → house three-column station: 296 px lane, padded centre, 352 px list.
- Scan box focus ring overlaps the intro line → 48 px scan box with its own label and gaps; ring is a 3 px outer glow.
- Single column, ~80% of 1440 empty → matched patient in the left lane (read-back never scrolls away), photo + choices in the centre, today's slips on the right.
- Unstyled "Choose File / No file chosen" → house secondary button "Choose a photo" beside Capture; native input hidden behind it (phone still opens the rear camera).
- Steps appear/disappear → one numbered flow (Scan · Check · Photograph · File) with a pinned dock; Enter does the next act, R retakes, Esc clears a wrong match.
- No sense of the day → one unfiltered list (waiting by age, then retakes, then filed), "Clocks running" collapsed; no filter tabs.
- Kind hidden in a dropdown → three radio cards with a one-line meaning; default "Prescription from this visit".
- Silent second filing → lane shows what is already on file for the visit and says "this adds page 2" (client can derive from GET /patients/:id/documents filtered by encounterId).

Age/sex in the lane come from the summary's administrativeGender + dob, which the server already returns (the client type just doesn't declare them).

## Needs server
1. Doctor ID, department (and room) on the by-number read-back — not returned today.
2. Today's slips list: finished consultations without a filed slip (waiting, by age since consult closed), retake requests, and filed slips — no endpoint lists these.
3. "Retake requested by the doctor" — no such flag/act exists.
4. QR/visit-number read of the photo itself, checked against the scanned visit (the OCR/image half the owner ruled is still owed; suggest-only, confirmed by the operator).
5. Find today's visit by name / UHID / mobile when the QR is unreadable (`GET /opd/visits` has no patient filter).
6. "Your day" counts (filed, waiting, median scan → file) and the Clocks running items.

## Questions for the owner
- Is a missing slip a clock? Should a finished consultation with no photographed slip escalate (OPD supervisor after 30 min, or MRD at day end), or only show?
- Lost or torn slip: may the desk file against a visit found by name/UHID when the QR cannot be read, or must the doctor's room reprint the slip first?
