---
type: decision
id: "0098"
title: "Imaging programme: list reads logged once per 30 minutes, imaging messages submitted for approval, a paid no-show keeps its bill, scanners bought, drafts kept"
description: "Five owner rulings for the 2026-11-14 imaging programme (#1075): the access log of list screens, patient message templates, a paid no-show, wristband scanners and unsigned draft versions."
generated: { by: agent:claude, at: 2026-11-14 }
verified: []
status: stable
ruling: ruled
tags: [radiology, audit, legal, money, procurement, notify]
supersedes: []
superseded_by: []
sources:
  - { id: spec-1076, resource: "docs/specs/1076-imaging-quick-wins.md", title: "Spec: imaging quick wins" }
---
# 0098 — Imaging programme rulings

- **Date:** 2026-11-14   **Status:** Ruled
- **Area:** radiology; audit, law, money, procurement (#1075 and its slices #1076–#1087)

## Decision

After the 2026-11-14 imaging module review, the owner was asked five questions with a proposed default for each, and
answered "go ahead", accepting every default:

1. **Access log of list screens (law).** A list screen (worklist, reading list, prep list, release register and the
   other imaging lists) writes one access row per reader, patient and surface per 30-minute window, in one statement.
   A patient new to that reader's list is logged at once. Opening one study, report, print or image set still logs
   every time. The 18a rule stands: one row per patient disclosed, never one row per read. Built in #1076.
2. **Patient message templates (law, procurement).** The imaging WhatsApp templates are submitted to Meta and the SMS
   templates registered on DLT (#1088, owner action). The new automated reminders (#1085) stay switched off until
   the templates are approved. The two existing imaging messages keep going by whatever channel has keys.
3. **A paid no-show (money).** No automatic refund. The invoice stays good for a rebooking of the same study within
   30 days. A refund goes through billing's existing refund path. Built in #1085.
4. **Wristband scanners (procurement).** The hospital buys one barcode scanner per modality room and one for the
   portable trolley. Typing the band value keeps working. Built in #1080.
5. **Unsigned draft versions (law).** Every draft version that autosave creates is kept for the record's retention
   period; nothing is purged at signature. Built in #1081.

## Why

- (1) The access log must answer "who saw this patient". One row per 30 s poll buries that answer; one row per window
  keeps every reader and every patient covered.
- (2) Meta and DLT approval are preconditions for sending; an unapproved automated message would be refused.
- (3) Standard Indian corporate hospital practice: a paid, unperformed study is rebooked, and refunds are a
  deliberate act with its own audit.
- (5) Draft versions show who wrote what and when, which a medico-legal review needs.
