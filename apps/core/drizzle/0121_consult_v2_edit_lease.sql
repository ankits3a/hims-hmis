ALTER TABLE "opd_encounters" ADD COLUMN "edit_lease_token" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "edit_lease_by" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "edit_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "edit_takeovers" jsonb;