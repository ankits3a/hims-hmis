-- FD-7 T9 / OWNER RULING R4 (2026-09-03): the channel-partner slip is captured at the desk when the
-- patient hands it over, and stays editable at billing.
--
-- THE GAP THIS CLOSES. `attributionCode` was a PER-REQUEST PARAMETER and nothing else: it is passed
-- to `feeQuote` and to `issueInvoice` on every call and stored nowhere in between. `charge-rules.ts`
-- says in its own comment that "the clerk attaches the slip during registration, long before billing
-- is opened" — and there was no column anywhere for it to be attached TO. A slip captured at the
-- desk therefore had to be re-typed by the cashier, or lost.
--
-- ON THE ENCOUNTER, not on the patient, because a slip is one per VISIT (V6). Nullable and additive:
-- every existing encounter keeps meaning what it meant, and a bill may still be priced with a code
-- passed inline, which is what every current caller does.
ALTER TABLE "opd_encounters"
  ADD COLUMN IF NOT EXISTS "attribution_code" text;
