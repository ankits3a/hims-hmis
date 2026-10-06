ALTER TABLE "opd_encounters" ADD COLUMN "completed_via" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "paper_completed_by" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "paper_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "paper_evidence_kind" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "paper_evidence_id" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "paper_confirmed_by" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "paper_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "paper_reopened_by" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "paper_reopened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "paper_reopen_reason" text;--> statement-breakpoint
ALTER TABLE "opd_prescription_drafts" ADD COLUMN "held_alerts" jsonb;