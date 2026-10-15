-- Owner 2026-10-07 — a revisit where only the guardian came, with the reports: vitals are skipped
-- and the visit goes to the doctor's line (`modules/opd/patient-absent.ts`). Additive and
-- IDEMPOTENT, in the style of 0180: `IF NOT EXISTS` lets it meet a staging database that already
-- holds the columns from a lane build, and is exactly `ADD COLUMN` on one that does not.
ALTER TABLE "opd_encounters" ADD COLUMN IF NOT EXISTS "patient_absent_by" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN IF NOT EXISTS "patient_absent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN IF NOT EXISTS "patient_absent_relation" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN IF NOT EXISTS "patient_absent_name" text;
