ALTER TABLE "opd_encounters" ADD COLUMN "paper_recheck_asked_by" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "paper_recheck_asked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "paper_recheck_reason" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "paper_recheck_done_by" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "paper_recheck_done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "paper_recheck_done_note" text;--> statement-breakpoint
ALTER TABLE "roster_cover_requests" ADD COLUMN "answer_note" text;