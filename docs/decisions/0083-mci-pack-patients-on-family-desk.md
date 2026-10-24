---
type: decision
id: "0083"
title: "Code Yellow pack arrivals are listed on the family information desk although their MLC was opened by rule"
description: "During a mass-casualty event the family desk lists every patient who arrived on a pre-printed Code Yellow pack (name or pack alias, a stage word, a place, nothing clinical) even though the pack rule opened an MLC for each; sealed and confidential patients and every other MLC patient stay hidden and only counted."
generated: { by: agent:claude, at: 2026-10-23 }
verified: []
status: stable
ruling: ruled
tags: [emergency, mlc, privacy]
supersedes: []
superseded_by: []
sources: []
---
# 0083 — Code Yellow pack arrivals are listed on the family information desk although their MLC was opened by rule

- **Date:** 2026-10-23   **Status:** Ruled.
- **Area:** emergency (Code Yellow family information desk, #877), MLC, privacy
- **Number:** taken on the ER lane stack; if `main` already holds a 0083 when this merges, it is renumbered to the next
  free number at merge time.

## Question put to the owner

Every Code Yellow pack arrival (`register_mci_arrival`, one `er_mci_packs` row per person) is an unknown arrival, and
every unknown arrival opens an MLC by rule. The ER's family-surface rule (lane 9) hides MLC patients from any family
surface and only counts them. Together, during a Code Yellow the family information desk would list nobody who came
in on a pack — which is nearly everyone from the incident — and send every family to the ER desk.

## What is ruled (owner, 2026-10-23: "yes show pack patients on family desk")

1. **The family desk lists Code Yellow pack arrivals**, although the pack rule opened their MLC: the name on the record
   (or the pack alias while unidentified), the pack number, a stage word and where. Nothing clinical: no tag, no ESI,
   no complaint, no MLC word.
2. **Sealed and confidential patients stay hidden and counted**, pack arrival or not.
3. **Every other MLC patient** (one who did not arrive on a pack) stays hidden and counted, as before.

## What this does not change

- Only the family information desk (`readMciFamilyDesk`, GET /er/mci/family). No other family surface changes.
- The press / VIP script still names nobody.
- The sealed and confidential rules are unchanged.
- MLC patients who are not pack arrivals are unchanged.
