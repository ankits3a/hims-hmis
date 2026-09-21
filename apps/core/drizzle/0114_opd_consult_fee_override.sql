ALTER TABLE "opd_encounters" ADD COLUMN "consult_fee_override_by" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "consult_fee_override_reason" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "consult_fee_override_at" timestamp with time zone;