---
type: decision
id: "0006"
title: "The doctor's copilot: two per-doctor toggles, the doctor always submits"
description: "Proactive-vs-ask-only and drafting clinical prose are two per-doctor toggles, both off by default; the doctor always confirms and submits."
generated: { by: agent:claude, at: 2026-09-17 }
verified: []
status: draft
ruling: partly-open
tags: [opd, cds, copilot]
supersedes: []
superseded_by: []
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0006 — The doctor's copilot: two per-doctor toggles, the doctor always submits

- **Date:** 2026-09-17   **Status:** Partly open
- **Area:** opd (doctor's desk), cds, copilot

Brainstorm: `docs/superpowers/brainstorms/2026-09-17-doctor-copilot/00-BRAINSTORM.md`.

## Decision

Owner ruled two independent PER-DOCTOR toggles:
1. **Proactive vs ask-only is the doctor's choice**, not the hospital's.
2. **Drafting clinical prose is opt-in.** Off: the copilot may only retrieve, check and structure. On: it may draft,
   and *"confirmation/submission will always be from the doctor side"*. That part is absolute and is not a toggle.

Both default OFF (decided).

Delegated back by the owner ("follow what seems logical to you") and decided:
- **The toggles live server-side, per user, and flipping `draftProse` appends an event.** A governed setting, not a
  browser preference, because it must answer "was the copilot permitted to draft on the day this note was signed?".
- **The two drug-disease engines are merged; neither is authoritative, the UNION is.** `cds/guardrails.ts` keys off
  physiological state (pregnancy asserted at the chair, G6PD, age/weight band); P24 keys off coded ICD-10 diagnoses.
  Merge rules:
  - dedupe by (moiety, hazard class), never by rule id;
  - MAX severity on collision;
  - cite both provenances;
  - freshness modulates confidence, never severity (P24's D2 must not downgrade a card fired on a fact asserted today);
  - P24's D6 re-check applies to the MERGED output.

## Why

- Default off: a copilot that talks on day one is switched off on day two.
- The brief for this seat is "what makes this faster than paper at 60 patients before lunch", not "what can AI do".
- Union of engines: a pregnant patient with no `O`/`Z33` code is invisible to P24 and caught only by the guardrails.

## Open

Still the owner's (law): the DPIA revision for voice in the consulting room (Class 2 audio, patient present), and
whether a model-drafted note passes clinical governance. The voice scribe is built and switched off
(`voice-flag.ts`); its next version is blocked on law, not engineering.
