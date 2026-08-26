-- THE UHID FORMAT CHANGE — owner ruling 2026-08-25.
--
-- `<PREFIX>-<8 digits>-<check>` (CRK-00000001-7) becomes `<PREFIX><7-digit serial><check digit>`
-- (U12345013): nine characters, no separators, Verhoeff retained. The reasoning lives in
-- src/modules/patients/uhid.ts and is not repeated here; what this file owns is the counter and
-- the index that the new search lane needs.
--
-- NO DATA IS REWRITTEN HERE. The 21 rows production is carrying are synthetic (owner-confirmed)
-- and are renumbered by `pnpm --filter @hmis/core remint:uhids`, deliberately a SCRIPT and not a
-- statement in this file: re-minting needs the Verhoeff check digit, and computing that in SQL
-- would put a hand-written function into the migration history for an algorithm the application
-- already owns and property-tests. The same reasoning kept `unaccent` out of 0021's index.

-- Drizzle's generated ALTER — it records the sequence's declared START, which is what
-- `pgSequence(..., { startWith: 1234501 })` in schema/patients.ts now says.
ALTER SEQUENCE "public"."uhid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1234501 CACHE 1;--> statement-breakpoint

-- AND THE ALTER ABOVE IS NOT ENOUGH, WHICH IS THE WHOLE TRAP. `ALTER SEQUENCE ... START WITH`
-- changes only what a FUTURE `RESTART` (with no argument) would rewind to; it leaves the live
-- counter exactly where it stands. Without the setval below, dev (at 1) and production (at 21)
-- would keep issuing serials inside the reserved band, `allocateUhid` would refuse every one of
-- them, and registration would be dead on arrival with a message about a floor nothing had moved.
--
-- Guarded rather than unconditional so that a hand-replay can never REWIND a counter that has
-- already issued real UHIDs — the one way this statement could do irreversible damage. `false`
-- as the third argument means "the next nextval() returns exactly 1234501", not 1234502.
DO $$
BEGIN
  IF (SELECT last_value FROM uhid_seq) <= 1234500 THEN
    PERFORM setval('uhid_seq', 1234501, false);
  END IF;
END $$;--> statement-breakpoint

-- The partial-UHID search lane (patientMatchCondition) matches a SUBSTRING of the id, and a
-- leading wildcard cannot use the `patients_uhid_ux` btree. pg_trgm arrived in 0021 and is
-- already installed; this is the same gin_trgm_ops pattern as `patients_name_trgm_idx`, and like
-- that one it lives in raw SQL rather than in the drizzle schema, so no later `generate` drops it.
-- `patients_uhid_ux` stays — it is the uniqueness constraint AND serves the exact-match lane.
CREATE INDEX IF NOT EXISTS patients_uhid_trgm_idx ON patients USING gin (uhid gin_trgm_ops);
