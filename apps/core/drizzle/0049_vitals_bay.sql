ALTER TABLE "opd_queue_entries" ADD COLUMN "bench_state" text;--> statement-breakpoint
ALTER TABLE "opd_queue_entries" ADD COLUMN "recall_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_queue_entries" ADD COLUMN "escalation" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "opd_queue_entries" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_queue_entries" ADD COLUMN "escalated_from_class" integer;--> statement-breakpoint
ALTER TABLE "opd_queue_entries" ADD COLUMN "escalation_by" text;--> statement-breakpoint
ALTER TABLE "opd_vitals" ADD COLUMN "readings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "opd_vitals" ADD COLUMN "muac_cm" double precision;--> statement-breakpoint
ALTER TABLE "opd_vitals" ADD COLUMN "context_chips" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "opd_vitals" ADD COLUMN "carried_forward" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "opd_vitals" ADD COLUMN "supersedes_vitals_id" text;--> statement-breakpoint
ALTER TABLE "opd_vitals" ADD COLUMN "amendment_reason" text;--> statement-breakpoint
ALTER TABLE "opd_vitals" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "opd_vitals" ADD COLUMN "emergency" boolean DEFAULT false NOT NULL;