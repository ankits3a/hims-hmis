---
type: decision
id: "0049"
title: "A name the doctor speaks in a voice note may reach the speech service — accepted and stated plainly"
description: "The system never sends a patient's name as data, but a name the doctor says aloud travels inside the audio to OpenAI's speech service; the owner accepts this and it is documented, not hidden."
generated: { by: agent:claude, at: 2026-10-07 }
verified: []
status: stable
ruling: ruled
tags: [opd, doctor, voice, privacy]
supersedes: ["0048"]
superseded_by: []
sources: []
---
# 0049 — A name the doctor speaks in a voice note may reach the speech service — accepted and stated plainly

- **Date:** 2026-10-07   **Status:** Ruled (partly supersedes 0048's "never the patient's name" for spoken audio)
- **Area:** opd, doctor, voice, privacy

## Decision

- The owner chose option (a) of three: "accept it and document it honestly". The other options were
  training doctors to dictate without names and measuring the rest, or moving speech-to-text onto our
  own server.
- **What the system sends as data stays as 0048 ruled:** the audio, plus age, gender and vitals.
  Never the patient's name, UHID, phone or address as a field. The audio is not stored.
- **What a doctor says aloud is inside the audio.** If a doctor speaks a name ("Ramesh ko metformin
  do"), that name reaches OpenAI's speech service with the recording. The owner accepts this. It is
  written down here so nobody believes the system prevents it.

## Why

A rule nobody can enforce must not be presented as enforced. Stopping a spoken name would need
on-server speech-to-text, which is unproven on Bhojpuri- and Maithili-accented Hinglish, or a
dictation discipline that fails silently. Independent review (2026-10-07) flagged the gap; the
owner chose honesty over a false guarantee.

## Consequences / how to apply

- Never describe voice notes as "no patient name ever leaves". Say "no name is sent as data; a
  spoken name travels in the audio".
- Doctors should still prefer not to say names while dictating. This is good practice, not a
  safeguard.
- The rule in 0048 for **data fields** is unchanged and still binds every outgoing request.
