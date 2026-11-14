-- Spec #1055 (owner 2026-11-13, ruling 0094) — a medicine added to a dispense ticket by hand at the counter. Additive:
-- six nullable columns on pharmacy_dispense_lines (why, who, when; for a paper slip its photo and the prescriber as
-- written) and one check that keeps them together. Every existing row has them all null, which the check allows.
ALTER TABLE "pharmacy_dispense_lines" ADD COLUMN "added_reason" text;--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD COLUMN "added_by" text;--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD COLUMN "added_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD COLUMN "added_document_id" text;--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD COLUMN "added_prescriber_name" text;--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD COLUMN "added_prescriber_reg_no" text;--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD CONSTRAINT "pharmacy_dispense_lines_added_ck" CHECK (("pharmacy_dispense_lines"."added_reason" is null and "pharmacy_dispense_lines"."added_by" is null and "pharmacy_dispense_lines"."added_at" is null and "pharmacy_dispense_lines"."added_document_id" is null and "pharmacy_dispense_lines"."added_prescriber_name" is null and "pharmacy_dispense_lines"."added_prescriber_reg_no" is null)
        or ("pharmacy_dispense_lines"."added_reason" in ('not_prescribed', 'paper') and "pharmacy_dispense_lines"."added_by" is not null and "pharmacy_dispense_lines"."added_at" is not null
          and ("pharmacy_dispense_lines"."added_reason" = 'paper' or ("pharmacy_dispense_lines"."added_document_id" is null and "pharmacy_dispense_lines"."added_prescriber_name" is null and "pharmacy_dispense_lines"."added_prescriber_reg_no" is null))));