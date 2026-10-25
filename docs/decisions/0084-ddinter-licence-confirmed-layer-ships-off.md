---
type: decision
id: "0084"
title: "DDInter licence confirmed for hospital use; the major-interaction reference layer may be built, and ships off"
description: "The owner confirms DDInter permission for hospital use is in hand or being obtained, so the Major-pairs reference layer of 0052 is built; it ships with its kill switch off until the owner has seen the 90-day replay."
generated: { by: agent:claude, at: 2026-10-23 }
verified: []
status: stable
ruling: ruled
tags: [formulary, opd, safety, licence]
supersedes: []
superseded_by: []
sources:
  - { id: spec-617, resource: "docs/specs/617-ddinter-reference.md", title: "Spec: DDInter major interactions as a reference layer" }
---
# 0084 — DDInter licence confirmed for hospital use; the major-interaction reference layer may be built, and ships off

- **Date:** 2026-10-23   **Status:** Ruled.
- **Area:** formulary, opd prescription checks (#617)

## Question put to the owner

DDInter's data is published under CC BY-NC-SA 4.0 (non-commercial). A hospital that charges patients may count as
commercial use. Decision 0005 kept DDInter as an internal benchmark only; 0052 ruled the Major pairs in as a labelled
second layer once its use was cleared. Is permission for hospital use in hand?

## The owner's words (2026-10-23)

- "Build, licence sorted" — the owner has, or will obtain, DDInter's permission for hospital use.

## Decision

1. The reference layer of 0052 is built: Major pairs only, in their own table, beside (never into) the curated rules.
2. Attribution "DDInter 2.0" and the licence travel on every row and in every alert note.
3. Any curated rule for the same pair, active or retired, wins.
4. `DDINTER_REFERENCE_ENABLED` ships off. It is switched on only after the owner has seen the 90-day replay
   (`replay-ddinter.ts`); if the in-prescription warning rate more than doubles, it goes back to the owner.
5. Keeping the licence position true (written permission on file) is the owner's; this record does not hold it.
