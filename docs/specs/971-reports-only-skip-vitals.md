---
issue: 971
status: built
approved: 2026-10-26
---
# SPEC — "Reports only — Skip vitals", with Self in "Who came?" (#971)

Status: APPROVED 2026-10-26 by the owner, with the defaults below. BUILT 2026-10-26 as specified. D4 pins behaviour that already held, so it passed before the build; D1–D3 and D5 were red.

## What

The vitals bay's "Patient not present — guardian with reports" button becomes **"Reports only — Skip vitals"**.
That covers the phone app, the web vitals bay and Desk One's visit card, in English and Hindi. Tapping the button
opens the same "Who came?" sheet. **Self** is now the first choice, and the nine relations stay after it. Self
means the patient came only to show reports. The visit skips vitals but is not marked "patient absent".

## Decisions

- Self is stored as `relation = "self"` in the existing text column, so there is no migration. The server stores no
  name for Self, because the patient's own name is already on the visit.
- The doctor's words for a Self visit are "Reports only · vitals skipped". No screen says "patient absent" or
  "guardian" for it. The doctor's screen shows no "take vitals in the room" prompt (owner default).
- Any other relation keeps today's doctor-side words: "Guardian only", "Guardian · Son" and the absent sentence.
- The desk's confirmation becomes neutral for every relation: "Sent to the doctor — vitals skipped."
- Fee rule, permission check, audit event (`visit.patient_absent`) and Undo are unchanged. The flow metrics keep
  counting a Self visit with the skipped-vitals visits.

## Done means

- **D1** The button reads "Reports only — Skip vitals" on the phone, the web vitals bay and Desk One.
- **D2** "Self" is the first choice in "Who came?". The server accepts it and stores no name. The name box is hidden
  for Self.
- **D3** A Self visit reaches the doctor's line with no vitals, and no screen says "patient absent" for it.
- **D4** A visit sent with any other relation shows the doctor the same words as before.
- **D5** For a Self visit, Undo, the fee rule and the audit record behave as they do for a guardian visit.
