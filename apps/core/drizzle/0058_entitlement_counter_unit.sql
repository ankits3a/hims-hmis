-- FD-7 T6 / OWNER RULING R3 (2026-09-03): packages draw down BOTH by count AND by value,
-- chosen per package.
--
-- `entitlement_counters` has always been a COUNT of whole units — `granted_qty` is an integer and
-- `entitlements.ts` says in as many words that "a counter unit is not divisible". That serves a
-- membership granting eight consultations; it cannot express a ₹10,000 prepaid package, which is
-- the other half of what the owner ruled.
--
-- ADDITIVE AND DEFAULTED, so every existing counter keeps meaning exactly what it meant: 'count'.
-- The value lane is opt-in per counter, and `granted_qty` then holds PAISE — the same column, read
-- through the same signed movement log, which is why the restore path needed no change at all
-- (`restoreEntitlements` negates `-movement.delta`, whatever that delta was).
ALTER TABLE "entitlement_counters"
  ADD COLUMN IF NOT EXISTS "unit" text NOT NULL DEFAULT 'count';

-- The two lanes are the whole vocabulary; a third would be a new pricing question, not a new row.
ALTER TABLE "entitlement_counters"
  DROP CONSTRAINT IF EXISTS "entitlement_counters_unit_ck";
ALTER TABLE "entitlement_counters"
  ADD CONSTRAINT "entitlement_counters_unit_ck" CHECK ("unit" IN ('count', 'paise'));
