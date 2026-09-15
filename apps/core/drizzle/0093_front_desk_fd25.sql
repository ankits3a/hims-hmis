-- FD-25/26/27/28/29/30/31/33/36 — the front-desk lane, merged onto main 2026-09-15.
--
-- ONE migration for one PR (CLAUDE.md), carrying what the lane's 0074-0078 carried. The two NOT
-- NULL columns are NOT the bare adds `drizzle-kit generate` emits. It re-emitted them here, and the
-- lane's own authors had already found why that is wrong and written the survivable form:
--
--   "correct for an empty table and FAILS on every database that already has a doctor in it —
--    production has sixteen. Add it nullable, give every existing row a number, and only then make
--    it required."
--
-- A generator reproduces a SCHEMA DIFF and cannot reproduce a DATA migration, so the three-step
-- bodies below are carried across from 0074_opd_doctor_code.sql and 0075_users_staff_code.sql
-- verbatim in intent. Both backfills ORDER BY `created_at` with `id` breaking the tie, so the
-- numbers follow the order the hospital actually onboarded people and a re-run cannot renumber
-- them — a backfill that numbers differently on a re-run is one nobody can reconcile against paper.
-- The unique indexes are created LAST, after every row has a value.

CREATE TABLE "opd_prescription_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"encounter_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"lines" jsonb NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"drafted_by" text NOT NULL,
	"drafted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"issued_prescription_id" text
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "staff_code" text;--> statement-breakpoint
ALTER TABLE "opd_doctors" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "fee_bypass_by" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "fee_bypass_reason" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "fee_bypass_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_prescriptions" ADD COLUMN "transcribed_by" text;--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD COLUMN "slip_confirmed_by" text;--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD COLUMN "slip_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_prescription_drafts" ADD CONSTRAINT "opd_prescription_drafts_encounter_id_opd_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."opd_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_prescription_drafts" ADD CONSTRAINT "opd_prescription_drafts_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opd_rx_drafts_pending_ux" ON "opd_prescription_drafts" USING btree ("encounter_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "opd_rx_drafts_patient_idx" ON "opd_prescription_drafts" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "opd_rx_drafts_drafted_by_at_idx" ON "opd_prescription_drafts" USING btree ("drafted_by","drafted_at");--> statement-breakpoint
UPDATE "users" AS u
SET "staff_code" = n.assigned
FROM (
  SELECT "id", 'EMP-' || lpad(row_number() OVER (ORDER BY "created_at", "id")::text, 4, '0') AS assigned
  FROM "users"
) AS n
WHERE u."id" = n."id" AND u."staff_code" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "staff_code" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_staff_code_ux" ON "users" USING btree ("staff_code");--> statement-breakpoint
UPDATE "opd_doctors" AS d
SET "code" = n.assigned
FROM (
  SELECT "id", 'DR-' || lpad(row_number() OVER (ORDER BY "created_at", "id")::text, 4, '0') AS assigned
  FROM "opd_doctors"
) AS n
WHERE d."id" = n."id" AND d."code" IS NULL;--> statement-breakpoint
ALTER TABLE "opd_doctors" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "opd_doctors_code_ux" ON "opd_doctors" USING btree ("code");