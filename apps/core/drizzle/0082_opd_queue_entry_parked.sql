ALTER TABLE "opd_queue_entries" ADD COLUMN "parked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_queue_entries" ADD COLUMN "parked_by" text;