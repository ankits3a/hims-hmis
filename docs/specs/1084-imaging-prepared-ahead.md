---
issue: 1084
status: approved
approved: 2026-11-14
---
# SPEC — Imaging: readiness forecast at booking, protocol suggestion, follow-ups before they fall due (#1084)

Status: APPROVED 2026-11-14 by the owner ("go ahead"), from the imaging module review. Slice IM6b of the imaging programme #1075. Rulings: 0098.

## What

- Kidney function, a past contrast reaction and a contrast allergy are discovered at the prep bay on the day, when the facts are already on file at booking. The protocol book is matched on study type only. A follow-up reaches the doctor only when it is already overdue.

## Decisions

- `readinessForecast(study, slot)` answers from facts on file: `ready`; `creatinine_missing` or `creatinine_stale` (using the gate's own validity days for the slot date); `radiologist_review` (eGFR below the hold level, a past contrast reaction, or a contrast allergy); `pregnancy_screen_due`. It writes to no gate and decides nothing.
- The desk's lane and the doctor's order card show the forecast (L1). A blocker at booking appends `imaging.readiness_forecast` so the desk and the ordering doctor see it the same day (L3).
- The appointment message asks for a creatinine report only when none valid is on file.
- DECIDED: the system never orders the creatinine; the order card shows "no creatinine in the valid window" and the doctor orders it.
- Protocol entries gain optional `indication_cues`. `suggestProtocol` returns the protocol whose cue matches the indication and names the cue; otherwise the study type's default. The radiographer keeps or changes it; the choice rides the acquisition event.
- A follow-up due within 14 days appears in the treating doctor's waiting items, with the existing book-follow-up act one tap away.

## Done means

- **D1** A contrast CT booked three days ahead with a creatinine older than the valid window forecasts `creatinine_stale`.
- **D2** With a creatinine from yesterday it forecasts `ready`, and the appointment message carries no creatinine prep line.
- **D3** With a past contrast reaction on file it forecasts `radiologist_review`, and no gate row is created or changed.
- **D4** `suggestProtocol` returns the protocol whose cue matches the indication and names the cue; with no match it returns the study type's default.
- **D5** A follow-up due in 10 days appears in the treating doctor's waiting items; one due in 20 days does not.
- **D6** (web) The desk lane shows the forecast line for the patient in hand.

## Out of scope

- any message to the patient (IM6c); any model.

## Build notes

- **Files.** radiology new `readiness-forecast.ts`, `schedule.ts`, `prep.ts`, `definitions.ts`, `room.ts`, `acquisition.ts`, `waiting.ts`, `advised.ts`, `events.ts` · web reception, `imaging-order-kit.tsx`, `room-console.tsx` · locales (SHARED).
- **Migration** no. **Permissions** none. **Size** M. **Depends on** IM2, IM3.
