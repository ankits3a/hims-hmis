ALTER TABLE "opd_encounters" ADD COLUMN "desk_complaint" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "desk_complaint_by" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "desk_complaint_at" timestamp with time zone;