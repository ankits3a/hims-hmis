---
type: decision
id: "0057"
title: "A guardian may stand in on any visit, new patients included; the doctor sees 'Guardian only' in a box and a 'Last visit' card"
description: "The owner extended the guardian-with-reports skip from returning patients to every visit, moved its button off the main vitals screen, and asked for a short, boxed highlight on the doctor's screens."
generated: { by: agent:claude, at: 2026-10-09 }
verified: []
status: stable
ruling: ruled
tags: [opd, vitals, doctor, mobile, front-desk]
supersedes: []
superseded_by: []
sources: []
---
# 0057 — Guardian visit: any patient, a quieter button, a louder notice for the doctor

- **Date:** 2026-10-09   **Status:** Ruled
- **Area:** opd, vitals, doctor

This record changes one point of decision
[0046](0046-opd-rr-hidden-and-guardian-visit.md) ("returning patients only") and adds how the visit
is shown. The rest of 0046 stands.

## The owner's words (2026-10-09)

> "does the doctor's screen highlights that the patient's guardian is here to only show report? so
> that doctor is pre-prepared."

> "avoid too much text … Since we have limited screen size, we need to mindful of text length."

> "How about hiding the button from main screen and keeping it inside a long press or swipe left or
> some other way?"

> "I think we should give this feature to not just revisit or renewal but new patient as well. This
> will meet the objective. Let's not complicate much."

## What is ruled

1. **Any visit.** "Guardian with reports" may be used on a new visit as well as a revisit or a
   renewal, while the visit is still waiting for vitals. The refusal `patient_absent_returning_only`
   is no longer raised. The fee rule is unchanged: an unpaid visit is sent to billing first.
2. **The button leaves the main vitals screen.** It is reached by holding a bench row or scanning a
   slip (the action card), under "Details" inside the vitals form, and by a left swipe on a bench
   row. A gesture never skips by itself: staff still picks who came and taps "Send to doctor".
   Desk One's visit card keeps its button.
3. **The doctor is told plainly, in few words.** A boxed card "Guardian only" with one line
   ("Son: Rakesh · reports · no vitals"; for a new patient "· new · no vitals"), a filled chip on the
   line ("Guardian · Son"), and the same line on the screen where the doctor writes. No vitals block
   is drawn for such a visit unless a chart exists.
4. **Short text on a phone.** A new label fits one line at 360 px; a test holds new strings to a
   character budget.

## Decided while building (DECIDED — the owner may change any of these)

- **A "Last visit" card on every revisit and renewal**, guardian or not: the doctor's own complaint
  (else that visit's desk words), diagnosis, tests, medicines.
- **A "Reports" card on the consult screen of a guardian visit:** up to three recent in-house results.
- **No tele-call machinery.** The owner was shown a drawing with "Call with patient", "Spoke to
  patient" and a prescription line, and chose the simple rule. Nothing asks the doctor to call, and
  the prescription carries no "patient not examined" line.
- "Other relative" reads "Relative" on the doctor's side.

## Advice given and not taken

The assistant pointed out that a doctor may now prescribe for a new patient who was never seen and
has no vitals, on a relative's word, and that the national telemedicine guidelines set limits on a
first consultation without the patient. The owner ruled for the simple version. The card says "new"
so the doctor decides knowingly; a printed line can be added later as a small change.

## Still open

- Photographing an outside report from the doctor's phone.
- Tele-call appointments (a separate feature the owner described the same day; spec not yet agreed).
