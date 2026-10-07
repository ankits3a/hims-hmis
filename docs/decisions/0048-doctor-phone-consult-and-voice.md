---
type: decision
id: "0048"
title: "The doctor consults on the phone — one screen, five drawers; voice notes through OpenAI, never Sarvam, no patient name sent"
description: "The phone consult gets notes, diagnosis, medicines, tests and advice in five drawers; voice notes may go to OpenAI (never Sarvam) with no patient name; doctors save their own sets plus a hospital starter list; print only when asked; diagnosis optional."
generated: { by: agent:claude, at: 2026-10-07 }
verified: []
status: draft
ruling: partly-open
tags: [mobile, opd, doctor, voice, privacy]
supersedes: []
superseded_by: []
sources: []
---
# 0048 — The doctor consults on the phone — one screen, five drawers; voice notes through OpenAI, never Sarvam, no patient name sent

- **Date:** 2026-10-07   **Status:** Partly open — rulings recorded; the design board awaits the owner's approval; the voice comparison trial has not run; nothing is built
- **Area:** mobile staff app, OPD consultation, voice, privacy

## What the owner saw

The owner tested the doctor's phone screen after "Start Consultation" and found no way to enter notes,
a diagnosis, medicines or tests:

> "I can sense that you tried to keep the screen clean and minimal which I liked but we missed to enable
> important fields. let us brainstorm on how can we keep the screen clean and minimal and yet give full
> control to the doctor."

## Decision (the owner's words, 2026-10-07)

> "I am open to go with OpenAI but never with Sarvam. Yes, I am comfortable with consultation audio being
> sent to an outside speech service, with the audio not stored but patient name must not be sent to openAI.
> Age, gender, vitals could be sent. run the small comparison trial first. Let doctors save their own sets,
> and add a small hospital starter list."

> "Printing: Only when the doctor asks. Diagnosis: keep it optional."

On what voice must understand: "Any audio model that understands north indian languages and slangs in hinglish."

So:

1. **Shape.** One calm consult screen (patient, allergies, today's vitals, the patient's own words) with a
   "This visit" card that fills up, and five drawers: Notes, Diagnosis, Medicines, Tests, Advice and
   follow-up. "Repeat last prescription", "My sets", "Issue and complete" and "I wrote on paper" sit beside them.
2. **Voice.** Notes may be spoken. The speech service is OpenAI. **Sarvam is never used.**
3. **What may leave the hospital for voice.** The audio, and age, gender and vitals. **Never the patient's
   name.** The audio is not stored.
4. **Trial first.** A small comparison trial runs before voice is built into the screen.
5. **Sets.** Each doctor saves their own sets; the hospital adds a small starter list.
6. **Printing** happens only when the doctor asks.
7. **Diagnosis** is optional.

## What this touches that was ruled before

- `POST /api/speech/transcribe` exists and is **shipped inert** (`kernel/inference/speech.controller.ts`): on
  2026-08-25 the owner's deferred note 5 held voice audio as Class 2 "until the DPIA rules otherwise". This
  record is the owner's consent to consultation audio going to an outside speech service; the DPIA revision
  that route's comment asks for is still owed before the switch is turned on.
- A doctor may speak a patient's name aloud. The request the hospital builds carries no name, but the audio is
  what was said. The screen tells the doctor not to say the name; that is a rule for people, not a filter.
- 0025 (paper consultation) stands: "I wrote on paper" stays on the consult screen.
- 0045 (browser printing) stands: a prescription issued from the phone prints only when the doctor asks.

## Open

- The design board's approval.
- The voice trial: which OpenAI model, with or without the hospital's drug and test names as hints.
- Who signs the hospital starter list; whether a set may hold antibiotics or controlled drugs.
- The longest voice clip.
- Whether a spoken note may be sorted into complaint / history / examination by a text model (no names).
