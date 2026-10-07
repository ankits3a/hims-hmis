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
