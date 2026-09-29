ALTER TABLE "imaging_definitions" DROP CONSTRAINT "imaging_definitions_kind_ck";--> statement-breakpoint
ALTER TABLE "imaging_reports" ADD COLUMN "signer" jsonb;--> statement-breakpoint
ALTER TABLE "imaging_reports" ADD COLUMN "sign_checks" jsonb;--> statement-breakpoint
ALTER TABLE "imaging_definitions" ADD CONSTRAINT "imaging_definitions_kind_ck" CHECK ("imaging_definitions"."kind" in ('study_types', 'pregnancy_policy', 'critical_categories', 'pacs_settings', 'dose_reference_levels', 'imaging_protocols', 'report_templates', 'report_signatories'));