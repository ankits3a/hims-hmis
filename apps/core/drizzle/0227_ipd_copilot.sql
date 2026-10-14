CREATE TABLE "ipd_copilot_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"kind" text NOT NULL,
	"scope_key" text NOT NULL,
	"source" text NOT NULL,
	"model_id" text,
	"prompt_version" text NOT NULL,
	"facts_hash" text NOT NULL,
	"content" jsonb NOT NULL,
	"fallback_reason" text,
	"built_by" text NOT NULL,
	"built_at" timestamp with time zone NOT NULL,
	"model_ms" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ipd_copilot_drafts_kind_ck" CHECK ("ipd_copilot_drafts"."kind" in ('since_yesterday', 'sbar', 'discharge')),
	CONSTRAINT "ipd_copilot_drafts_source_ck" CHECK ("ipd_copilot_drafts"."source" in ('template', 'model')),
	CONSTRAINT "ipd_copilot_drafts_model_ck" CHECK (("ipd_copilot_drafts"."source" = 'model') = ("ipd_copilot_drafts"."model_id" is not null)),
	CONSTRAINT "ipd_copilot_drafts_ms_ck" CHECK ("ipd_copilot_drafts"."model_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ipd_discharge_summaries" ADD COLUMN "draft_id" text;--> statement-breakpoint
ALTER TABLE "ipd_shift_handovers" ADD COLUMN "draft_id" text;--> statement-breakpoint
ALTER TABLE "ipd_copilot_drafts" ADD CONSTRAINT "ipd_copilot_drafts_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_copilot_drafts" ADD CONSTRAINT "ipd_copilot_drafts_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ipd_copilot_drafts_current_idx" ON "ipd_copilot_drafts" USING btree ("admission_id","kind","scope_key","built_at");