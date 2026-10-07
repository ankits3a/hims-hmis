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
superseded_by: ["0049"]
sources: []
---
# 0048 — The doctor consults on the phone — one screen, five drawers; voice notes through OpenAI, never Sarvam, no patient name sent

- **Date:** 2026-10-07   **Status:** Built (see "Built" below); rulings recorded; the spoken-name wording is superseded by 0049
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
4. **No trial.** The owner first asked for a small comparison trial, then withdrew it the same day (see below): voice
   starts in use and is measured there.
5. **Sets.** Each doctor saves their own sets; the hospital adds a small starter list.
6. **Printing** happens only when the doctor asks.
7. **Diagnosis** is optional.

## The trial is skipped (owner, later on 2026-10-07)

> "I don't have sample voice notes so let's skip the trial. let's go ahead without it"

How voice starts instead — **DECIDED by delegation**, the owner may overturn any line:

- OpenAI only. The most accurate speech model first (`gpt-4o-transcribe`); the model name is a server setting, so
  it can be switched to `gpt-4o-mini-transcribe` (cheaper, faster) or `whisper-1` without an app update.
- Hints sent with the audio: the formulary's brands and generics, test names, common Hinglish medical words.
- Context sent: age, gender, vitals, department. Never the name, UHID, phone or address.
- The audio is streamed to the hospital's server, forwarded, and stored nowhere.
- The transcript is shown to the doctor for review before it is saved.
- Medicine and test words are matched back to the catalogue ("pan forty" → Pantoprazole 40 mg) and **offered as a
  chip, never added as a medicine line by themselves** — the doctor taps it.
- Measured in use, in place of a trial: per transcript, how many characters the doctor changed before saving (no
  audio kept), per doctor per week, shown to the owner so the model can be switched on evidence.
- A cost meter (minutes per day) with a daily cap setting.
- From the owner: only the OpenAI API key, in `/root/.config/hmis/openai/key.txt` on the server.

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
- Who signs the hospital starter list; whether a set may hold antibiotics or controlled drugs.
- The longest voice clip.
- Whether a spoken note may be sorted into complaint / history / examination by a text model (no names).

## Built, and what was settled while building (2026-10-07)

The owner approved the board and, on the last frame:

> "I think I don't need to give any printing option After issuing. I think we should skip 'After issuing' screen."

So "Issue and complete" returns straight to My OPD queue with one fading line; there is no print on the phone.

**DECIDED by delegation** (the owner may overturn any line):

- A hospital starter set is signed once by the department's **unit head** (the roster's head of the unit). Until
  signed, only its author and the unit head see it; any edit removes the signature.
- A set may hold antibiotics. It can **never** hold a controlled medicine (Schedule H1, X, narcotic or psychotropic) —
  refused when saved, by catalogue id and by name.
- A voice clip is at most **60 seconds**. Sorting a spoken note into complaint / history / examination is **later**.
- "Review after N days" is printed advice. The free follow-up window stays the hospital's own setting.
- **No new permission.** The phone uses `opd.consult` and the treating-doctor check; the owner's panel uses
  `opd.masters.read` / `opd.masters.manage`.
- "I wrote on paper" asks for a second tap when medicines typed on the phone would be withdrawn.
- A defect found on the way: the issue route dropped the doctor's answers to a drug–disease warning (the body
  schema did not name them), so a severe one could not be overridden from any screen. Fixed and tested.

**Guards added from the independent review the owner commissioned** (with 0049):

- Nothing is pre-selected; a suggestion row shows strength, form and class.
- Each prescription line stores where it came from (typed / search / voice / set / repeat) — audit only.
- Checks run on the draft as lines are added, and again at issue.
- Look-alike / sound-alike names take a second tap. The shipped list (24 standard pairs) is **not yet reviewed by
  the hospital's pharmacist** — OPD masters → Phone consult lists them for confirmation.
- Two server switches, no deploy: voice, and suggestions.
- Heard text is shown in Roman script.
- A term that matched nothing is logged (the term, its kind, where tried, doctor, time — no patient) for a later
  alias tool. No alias table, no embeddings here.
- Counted: suggestions taken / left / typed by hand; per spoken note, the share the doctor changed.

**Where:** phone `apps/mobile/src/screens/consult.tsx`, `apps/mobile/src/consult/*`; shared rules
`packages/contracts/src/phone-consult.ts`; server `apps/core/src/modules/opd/{rx-sets,consult-voice,consult-guards}.ts`
and `opd-phone-consult.controller.ts`; web `apps/web/src/screens/opd-phone-consult.tsx` (`/opd/sets`, and the
"Phone consult" tab of OPD masters); privacy assessment `docs/compliance/2026-08-23-dpia-agentic-runtime-v0.1.md` §3-B.

**Still open:** the OpenAI key file on the production server (voice says "not set up" until it is there); a
data-processing addendum with OpenAI; the patient privacy notice line; the pharmacist's review of the look-alike
list; a real-phone test of the microphone.
