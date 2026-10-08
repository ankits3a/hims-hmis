---
type: decision
id: "0056"
title: "The vitals screen opens with four boxes; SpO2, temperature, glucose and breathing rate sit behind '+'; every app screen has a scan button and no left drawer"
description: "The owner moved SpO2 out of the routine must-fill readings, added finger-prick glucose, and approved the board for quick scan, hold and swipe; he rejected a left drawer."
generated: { by: agent:claude, at: 2026-10-08 }
verified: []
status: stable
ruling: ruled
tags: [opd, vitals, mobile, nursing, front-desk]
supersedes: []
superseded_by: []
sources: []
---
# 0056 — Vitals: four boxes and a "+"; quick scan in every header; no drawer

- **Date:** 2026-10-08   **Status:** Ruled
- **Area:** opd, vitals, mobile

Board the owner approved: https://claude.ai/artifact/RUJqsX5Yv4fJVyWwnwjVzd

## The owner's words (2026-10-08)

> "in the Vitals screen, we should keep BP, Weight, height & Pulse as the primary and add a '+' icon to
> add more vitals like RR, Temperature, Glucose"

> "Move SpO2 behind '+'. Add Glucose behind '+'. After a scan with several allowed actions: go ahead with
> most logical option considering speed and productivity as primary driver."

> "No drawer in the app screen. Confirmed. Rest you start building"

## What is ruled

1. **Vitals opens with four boxes** — Blood pressure, Pulse, Weight, Height — on the phone and on the
   web bay. SpO2, Temperature, Glucose and Breathing rate are added with "+ Add a reading".
2. **SpO2 is no longer a must-fill reading for a routine visit**, in any age band. The chart saves
   without it. This is the owner's clinical choice; the assistant advised keeping SpO2 in the first set.
3. **Glucose is a new reading**: finger-prick, mg/dL, 20–600, always with when it was taken — fasting,
   random or after food. A value without that tag is not saved.
4. **Every app screen has a scan button in its header.** No left drawer.

## Decided while building (DECIDED — the owner may change any of these)

- **An emergency save still needs SpO2** (`EMERGENCY_REQUIRED` is unchanged). The app does not know a
  patient is an emergency before the nurse presses the emergency save, so the SpO2 box comes up, marked,
  at that press.
- **A child under six:** the arm band (MUAC) stays must-fill; temperature is shown without "+" but is
  not must-fill — the owner's ruling of 2026-10-05 (temperature is never mandatory) stands.
- **A reading that was out of range on the last chart** is shown without "+", not must-fill.
- **A held SpO2 that looks like a probe error still blocks the save** until the nurse re-clips, confirms
  or clears it. Without this, dropping the requirement would have let a held 45% vanish unseen.
- **Glucose has no danger limit, colour or advice text.** A threshold is a clinical ruling the owner has
  not made.
- **After a scan:** when the patient is waiting for exactly this person's job, that job opens; otherwise
  one card whose large button is the patient's next step for this person. A scan never writes anything
  by itself: the doctor lands on the patient's brief, with Start one tap away.
- **Gestures are shortcuts, never the only way.** Hold a row = the same card. Swipe = one common action
  per screen; never delete, cancel, pay or complete.

## Where it lives

`packages/contracts/src/vitals-entry.ts` (`vitalsLayout`, `GLUCOSE_TIMINGS`), `opd/vitals-rules.ts`
(`requiredFor`, `checkGlucose`), columns `opd_vitals.glucose_mg_dl` and `glucose_timing`;
`opd/scan.ts` (`GET /opd/scan`), `apps/mobile/src/scan/`.

## Still open

- The stored protocol row (`opd_config.danger_ranges`) still lists SpO2; the code layer strips it.
- Glucose is not on the doctor's web Vitals tab and has no dictation token.
- A cashier without `opd.visits.open` is offered nothing after a scan.
- App-icon shortcuts are not built. Nothing here has been tried on a real phone.
