ALTER TABLE "opd_encounters" ADD COLUMN "fee_bypass_by" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "fee_bypass_reason" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "fee_bypass_at" timestamp with time zone;