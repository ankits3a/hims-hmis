---
type: decision
id: "0054"
title: "No dose is suggested for a child in the first version; the groundwork for learning (P0) is built"
description: "The owner said yes to 'no children's doses in the first version' and to starting phase P0: prescriptions become countable, every line and diagnosis says where it came from, every suggestion has a cross that is counted."
generated: { by: agent:claude, at: 2026-10-07 }
verified: []
status: stable
ruling: ruled
tags: [opd, doctor, copilot, learning, paediatrics]
supersedes: []
superseded_by: []
sources: []
---
# 0054 — No dose is suggested for a child in the first version; the groundwork for learning (P0) is built

- **Date:** 2026-10-07   **Status:** Ruled
- **Area:** opd, doctor, copilot

This record closes the one point decision [0050](0050-self-improving-suggestions.md) left open, and
records what was built for phase P0 of
[the plan](../superpowers/plans/2026-10-07-self-improving-suggestions.md) and what was decided while
building it.

## The owner's words (2026-10-07)

> "yes on 'no children's doses in the first version' … start the groundwork (P0) now. implement
> self-improving system plan."

## What is ruled

1. **No dose is suggested for a child in the first version.** A dose one doctor gave one child is not
   evidence for another child. Children's dosing stays where decision
   [0009](0009-doctor-consult-engine.md) put it: a licensed source, which is an owner ruling of its own.
2. **Phase P0 starts now.** P0 learns nothing and re-ranks nothing. It makes the record countable
   and starts counting.

## What P0 does

- **One closed frequency set** — OD, BD, TDS, QID, HS, SOS, STAT, or "other" with the doctor's own
  words — for every screen that writes a prescription line: the web consultation, the desk scribe,
  the phone, sets and "Repeat last". One definition, `packages/contracts/src/rx-line.ts`. The desk's
  "1-0-1" or "twice daily" is kept as BD; a sentence of the doctor's own is left exactly as typed.
- **The dose is read into an amount and a unit** ("1 tab", "1 Tab", "one tablet" are one thing),
  and the words as written are always kept. What cannot be read is counted as written, never guessed.
- **Every issued line and every committed diagnosis says where it came from**: typed, picked from
  search, suggested, from a voice note, from a set, repeated, or typed by the desk from paper.
- **Every suggestion has a ×.** The cross is counted; the chips that were on screen are counted with
  it; a chip the doctor did not tap is not a cross. Nothing re-ranks while the doctor is working.
- **A countable copy of each issued line** (`cds_rx_lines`) is written in the same transaction as
  the prescription. It names the visit, the doctor and the department. It never names the patient.

## Decided while building (DECIDED — the owner may change any of these)

- **Children, in practice.** When the patient is a child (under 40 kg by the charted weight, or under
  12 years when no weight is charted — the same line the server draws), a set or "Repeat last" on
  the phone brings the medicines **without** dose, frequency or days and says "Dose not suggested for
  a child — enter it." The line cannot be issued until the doctor enters them. The regimen book's
  weight-band doses (decision 0009) are not suggestions learned from use and are
  unchanged.
- **The readable numbers live beside the prescription, not inside it.** The plan said the parsed
  dose would be stored on the line. It is stored in `cds_rx_lines` instead: the issued prescription
  is a signed document and is not rewritten. The only addition to the line is its `source`.
- **One suggestion log, not two.** The plan's `cds_suggestion_events` is the phone consultation's
  `opd_suggestion_events`, widened in place. It may now name the visit and the suggestion; it still
  has no patient column and no free text.
- **Hidden after three crosses, now.** A suggestion the same doctor crossed three times within ninety
  days is not offered to that doctor again. Tapping it or typing it by hand brings it back at once;
  otherwise it returns by itself as the crosses age out. The graded form in the plan (a decaying
  score) is ranking and arrives with P1.
- **A re-issue replaces, a backfill repeats.** One prescription stands per visit, so a re-issue
  replaces that visit's countable rows. The backfill can be run any number of times and reports how
  many doses did not parse.
- **The first source of a diagnosis stands.** A later save of the same diagnosis cannot change where
  it is recorded as having come from.
- **Each doctor has their own switch for suggestion chips, default on.** Decision
  [0006](0006-doctor-copilot-toggles.md) ruled two per-doctor toggles for the copilot — proactive or
  ask-only, and whether it may draft prose — both default off and both kept on the server. The check
  found that neither is kept anywhere today: there is only a comment in the web consultation. The
  count-based chips here are not the proactive copilot: they add nothing unless tapped, and they
  were on the screen before this work. So they get their own switch
  (`cds_doctor_prefs.suggestions_on`, default on), which the doctor turns off on the consultation
  screen. Decision 0006's two toggles are still owed.

## Not in P0

No ranking from history, no dose suggestion for anyone, no alias, nothing sent to any outside
service. Learning (P1) waits for typed prescriptions to exist: production held none on 2026-10-07.
