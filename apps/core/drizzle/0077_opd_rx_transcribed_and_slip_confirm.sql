ALTER TABLE "opd_prescriptions" ADD COLUMN "transcribed_by" text;--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD COLUMN "slip_confirmed_by" text;--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD COLUMN "slip_confirmed_at" timestamp with time zone;