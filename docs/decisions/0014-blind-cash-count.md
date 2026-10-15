---
type: decision
id: "0014"
title: "Blind cash count: the cashier never sees their expected cash before they count"
description: "The cashier never sees their drawer's expected cash before submitting the count; supervisors and the billing manager still may."
generated: { by: agent:claude, at: 2026-09-28 }
verified: []
status: stable
ruling: ruled
tags: [billing, front-desk, pharmacy, copilot]
supersedes: []
superseded_by: []
sources:
  - { id: pr-515, resource: "https://github.com/ankits3a/hims-hmis/pull/515", title: "docs(decisions): the owner's rulings move from private memory into 41 numbered decision records" }
---
# 0014 — Blind cash count: the cashier never sees their expected cash before they count

- **Date:** 2026-09-28   **Status:** Ruled
- **Area:** billing (cash sessions), front desk, pharmacy, copilot

## Decision

- The owner answered "Yes" to hiding the expected cash from the cashier until their count is submitted.
- No screen, card, API response or copilot answer may give the cashier their own drawer's expected cash before the
  count is submitted — the home desk card included.
- A supervisor or billing manager may still see it.
- Extended the same day by 0017: "collected today" is hidden too.

## Why

Standard Indian corporate hospital cash control. A count taken after seeing the answer finds nothing: with the
figure on screen, a short drawer can be quietly topped up to match.

## Consequences / how to apply

- The `/billing/session` rebuild (PR #361) keeps the blind count. The home desk card leaked it
  (`desk-provider.ts` set `desk.billing.expectedCash`); that is the defect this ruling closes.
- When adding any drawer figure anywhere, check it against this rule.
