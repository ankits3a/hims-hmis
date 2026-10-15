CREATE TABLE "cds_doctor_prefs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"suggestions_on" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cds_rx_lines" (
	"prescription_id" text NOT NULL,
	"line_index" integer NOT NULL,
	"encounter_id" text NOT NULL,
	"doctor_id" text NOT NULL,
	"department_id" text,
	"service_date" date NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"dx_key" text,
	"complaint_concepts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"band" text NOT NULL,
	"medicine_id" text,
	"drug_key" text NOT NULL,
	"moiety_set" text,
	"dose_raw" text NOT NULL,
	"dose_amount" double precision,
	"dose_unit" text,
	"frequency_raw" text NOT NULL,
	"frequency" text NOT NULL,
	"duration_days" integer,
	"route" text NOT NULL,
	"source" text,
	"from_suggestion" boolean DEFAULT false NOT NULL,
	"had_override" boolean DEFAULT false NOT NULL,
	"transcribed" boolean DEFAULT false NOT NULL,
	"aware_category" text,
	"schedule_flag" text,
	"antimicrobial_restricted" boolean DEFAULT false NOT NULL,
	"ndps" boolean DEFAULT false NOT NULL,
	CONSTRAINT "cds_rx_lines_prescription_id_line_index_pk" PRIMARY KEY("prescription_id","line_index"),
	CONSTRAINT "cds_rx_lines_band_ck" CHECK ("cds_rx_lines"."band" in ('adult', 'pediatric')),
	CONSTRAINT "cds_rx_lines_frequency_ck" CHECK ("cds_rx_lines"."frequency" in ('OD', 'BD', 'TDS', 'QID', 'HS', 'SOS', 'STAT', 'other'))
);
--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" DROP CONSTRAINT "opd_suggestion_events_kind_ck";--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" DROP CONSTRAINT "opd_suggestion_events_source_ck";--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" DROP CONSTRAINT "opd_suggestion_events_outcome_ck";--> statement-breakpoint
ALTER TABLE "opd_encounter_diagnoses" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" ADD COLUMN "surface" text;--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" ADD COLUMN "doctor_id" text;--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" ADD COLUMN "department_id" text;--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" ADD COLUMN "encounter_id" text;--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" ADD COLUMN "context_key" text;--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" ADD COLUMN "item_key" text;--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" ADD COLUMN "rank_shown" integer;--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" ADD COLUMN "items" jsonb;--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" ADD COLUMN "source_level" text;--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" ADD COLUMN "batch_id" text;--> statement-breakpoint
ALTER TABLE "cds_rx_lines" ADD CONSTRAINT "cds_rx_lines_prescription_id_opd_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."opd_prescriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cds_rx_lines_doctor_dx_idx" ON "cds_rx_lines" USING btree ("doctor_id","dx_key","service_date");--> statement-breakpoint
CREATE INDEX "cds_rx_lines_dept_dx_idx" ON "cds_rx_lines" USING btree ("department_id","dx_key","service_date");--> statement-breakpoint
CREATE INDEX "opd_suggestion_events_doctor_item_idx" ON "opd_suggestion_events" USING btree ("user_id","surface","context_key","item_key","created_at");--> statement-breakpoint
ALTER TABLE "opd_encounter_diagnoses" ADD CONSTRAINT "opd_encounter_diagnoses_source_ck" CHECK ("opd_encounter_diagnoses"."source" is null or "opd_encounter_diagnoses"."source" in ('typed', 'search', 'suggested', 'voice', 'paper'));--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" ADD CONSTRAINT "opd_suggestion_events_level_ck" CHECK ("opd_suggestion_events"."source_level" is null or "opd_suggestion_events"."source_level" in ('personal', 'dept', 'hospital', 'starter', 'alias'));--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" ADD CONSTRAINT "opd_suggestion_events_kind_ck" CHECK ("opd_suggestion_events"."kind" in ('medicine', 'test', 'diagnosis', 'complaint', 'advice', 'dose', 'department', 'alias'));--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" ADD CONSTRAINT "opd_suggestion_events_source_ck" CHECK ("opd_suggestion_events"."source" in ('typed', 'voice', 'search', 'set', 'repeat', 'suggested', 'paper'));--> statement-breakpoint
ALTER TABLE "opd_suggestion_events" ADD CONSTRAINT "opd_suggestion_events_outcome_ck" CHECK ("opd_suggestion_events"."outcome" in ('accepted', 'dismissed', 'manual', 'shown', 'edited'));