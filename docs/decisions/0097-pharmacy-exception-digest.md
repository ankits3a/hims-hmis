---
type: decision
id: "0097"
title: "Pharmacy exception digest: a phone-app alert to the owner only, every exception listed biggest first"
description: "Owner rulings of 2026-11-14 for #1065: the daily pharmacy exception digest reaches the owner as a phone-app notification (count and rupees, no patient text), lists every exception with no rupee threshold, and goes to the owner alone."
generated: { by: agent:claude, at: 2026-11-14 }
verified: []
status: stable
ruling: ruled
tags: [pharmacy, money, audit, notify]
supersedes: []
superseded_by: []
sources:
  - { id: spec-1065, resource: "docs/specs/1065-pharmacy-exception-digest.md", title: "Spec: pharmacy exception digest" }
---
# 0097 — Pharmacy exception digest: phone-app alert, every exception, owner only

- **Date:** 2026-11-14   **Status:** Ruled
- **Area:** pharmacy, money, audit, notify

## Decision

The owner answered the digest questions of #1065 with the recommended options:

- **Delivery.** A notification on the staff phone app at 08:00 IST for the previous day: the number of exceptions and
  their total in rupees, never a patient's name or medicine. It opens that day's Exceptions page. WhatsApp is not
  used until a message template is approved; adding it later is a new ruling.
- **Threshold.** Every exception is listed, sorted by rupees, biggest first. No rupee floor.
- **Recipients.** The owner only. Giving the page or the alert to anyone else (for example the pharmacy in-charge) is
  a new ruling.

## Why

The exceptions were already recorded (approvals, credit notes, adjustments, the leakage auditor, shift counts, the
price check of #1061) but nothing reached the owner without going to look. At today's volume a full list sorted by
rupees is short enough to read, and a phone notification works now, without waiting for Meta's template approval.

## Consequences / how to apply

- The right `pharmacy.exceptions.view` is given to the owner role only.
- A day with no exceptions sends no notification.
