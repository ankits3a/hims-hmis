-- STAGE-ONLY (lane/ipd-stage, never main). UAT applied an earlier er_arrival (0232) that added
-- patients.identity_status without its CHECK; lane/er-arrival's er_arrival carries the CHECK. Idempotent:
-- adds patients_identity_status_ck only when pg_constraint does not already have it, so a fresh database
-- and UAT end in the same shape.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'patients_identity_status_ck' AND conrelid = 'public.patients'::regclass
  ) THEN
    ALTER TABLE "patients" ADD CONSTRAINT "patients_identity_status_ck" CHECK ("patients"."identity_status" in ('identified', 'unidentified'));
  END IF;
END $$;
