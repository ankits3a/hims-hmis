-- Owner ruling 2026-10-06 — consulted on paper. Additive, and IDEMPOTENT on purpose: this migration
-- was first cut as 0179 and applied to STAGING before main took 0179 (auth_phone_push, #508). It was
-- renumbered to 0180 at merge time; `IF NOT EXISTS` lets it meet a database that already holds the
-- columns (staging, which is never reset) and is exactly `ADD COLUMN` on one that does not (production).
ALTER TABLE "opd_encounters" ADD COLUMN IF NOT EXISTS "completed_via" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN IF NOT EXISTS "paper_completed_by" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN IF NOT EXISTS "paper_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN IF NOT EXISTS "paper_evidence_kind" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN IF NOT EXISTS "paper_evidence_id" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN IF NOT EXISTS "paper_confirmed_by" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN IF NOT EXISTS "paper_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN IF NOT EXISTS "paper_reopened_by" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN IF NOT EXISTS "paper_reopened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN IF NOT EXISTS "paper_reopen_reason" text;--> statement-breakpoint
ALTER TABLE "opd_prescription_drafts" ADD COLUMN IF NOT EXISTS "held_alerts" jsonb;