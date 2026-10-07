# 0037 — An emergency is charted before billing; an unpaid token waits for the money or the doctor

- **Date:** 2026-09-20   **Status:** Ruled
- **Area:** opd, vitals, billing, queue display

## Decision

1. **Emergency at the vitals bay.** The owner hit `fee_unsettled` on the bay's "Save & send NOW (emergency)" for an
   unbilled patient and ruled that an emergency must be chartable before billing. The emergency save opens the fee
   gate itself.
2. **The unpaid token waits.** Owner: *"the emergency at the bay doesn't open the doctor's door. It waits for bill to
   be paid until doctor opens the token from his dashboard manually … once the bill is paid then the token
   automatically moves to the display board."*

This answers the open question in 0004 (does the bypass also open the doctor's door?): **no** — only payment, or the
treating doctor opening the token, releases it.

## Why

A patient in danger is charted first; the fee is still owed, and the doctor decides whether to see an unpaid
emergency.

## Consequences / how to apply

- The emergency declaration is both clinical (trims the required set to BP + pulse + SpO₂, see 0030) and financial.
  The waiver is a WRITE in the saver's name (`grantFeeBypass`, the `fee_bypass_*` columns), so the warning mark
  travels to every desk. The fee stays owed.
- The hold is DERIVED, never stored; paying releases the token to the board with nothing to clear.
- Two doors, two column sets: `fee_bypass_*` (bay / front desk) and `consult_fee_override_*` (treating doctor). Never
  merge them.
- The consult-door exemption keys on the verdict code `fee_unsettled`, so a clinical refusal still refuses a doctor
  who waived the bill.
- Built in PRs #268 and #269 (migration 0114).
