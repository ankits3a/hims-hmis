-- UX-AUDIT 2026-09-28 · BOARD — the slip desk's "retake" row: the doctor asks for a clearer photograph
-- of one filed page. Three nullable columns, additive; the page stays `active`.
ALTER TABLE "patient_documents" ADD COLUMN "retake_requested_by" text;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD COLUMN "retake_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD COLUMN "retake_reason" text;