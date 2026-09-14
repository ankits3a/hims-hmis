ALTER TABLE "opd_queue_entries" ADD COLUMN "skip_reason" text;--> statement-breakpoint
ALTER TABLE "opd_queue_entries" ADD COLUMN "skip_note" text;--> statement-breakpoint
ALTER TABLE "opd_queue_entries" ADD COLUMN "skipped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_queue_entries" ADD COLUMN "skipped_by" text;--> statement-breakpoint
ALTER TABLE "opd_queue_entries" ADD COLUMN "pre_skip_eligible_at" timestamp with time zone;