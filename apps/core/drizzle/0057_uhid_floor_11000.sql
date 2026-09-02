-- THE UHID FLOOR — owner ruling 2026-09-02.
--
--   > "The counter should start with U0011001 and Not CRK1234500."
--
-- The reserved band shrinks from 1..1,234,500 to 1..11,000, so the first issued serial is 11,001
-- and the first card reads U00110012 (`U` + `0011001` + the Verhoeff check digit `2`). The
-- reasoning lives in src/modules/patients/uhid.ts and is not repeated here; what this file owns is
-- the counter. `UHID_RESERVED_THROUGH` is the authority and refuses at the counter — this makes
-- the sequence agree with it, which 0024's own header explains is a SEPARATE statement.

-- Drizzle's generated ALTER — it records the sequence's declared START, which is what
-- `pgSequence(..., { startWith: 11001 })` in schema/patients.ts now says. On its own this changes
-- only what a future bare `RESTART` would rewind to; it does not move the live counter. That is
-- 0024's trap, restated because this migration walks into it from the other direction.
ALTER SEQUENCE "public"."uhid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 11001 CACHE 1;--> statement-breakpoint

-- ═══ THIS ONE DELIBERATELY MOVES THE COUNTER *DOWN*, WHICH 0024 REFUSED TO DO ═══
--
-- 0024's guard was `IF last_value <= 1234500 THEN setval(...)` — it would only ever push a counter
-- UP into the band, never rewind one that had issued real UHIDs. This migration must do the
-- opposite, and the difference is worth stating rather than silently inverting:
--
--   · Lowering a sequence is safe ONLY while no live UHID sits in the range it will re-traverse.
--     Production carries 24 rows at serials 1,234,501..1,234,524 — synthetic commissioning data,
--     owner-confirmed, and the owner has said they are to be deleted before go-live. Until they
--     are, the counter would not reach them for ~1.2 million registrations.
--   · `patients_uhid_ux` is the backstop either way: a collision cannot mint a duplicate UHID, it
--     halts that registration with a unique-violation. Loud, and at the counter.
--
-- GUARDED so a replay cannot rewind a counter that has already issued INSIDE the new range. Once
-- serials 11,001+ exist, `last_value` is above 11,000 and this becomes a no-op — which is exactly
-- what a re-run of a deploy must be.
DO $$
BEGIN
  IF (SELECT last_value FROM uhid_seq) > 1234500 THEN
    -- `false` means "the next nextval() returns exactly 11001", not 11002.
    PERFORM setval('uhid_seq', 11001, false);
  END IF;
END $$;
