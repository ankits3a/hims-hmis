ALTER TABLE "opd_config" ADD COLUMN "counter_sequence" text DEFAULT 'queue_first' NOT NULL;--> statement-breakpoint
ALTER TABLE "opd_config" ADD COLUMN "token_lane" text DEFAULT 'token_first' NOT NULL;--> statement-breakpoint
ALTER TABLE "opd_departments" ADD COLUMN "avg_consult_minutes" integer DEFAULT 6 NOT NULL;