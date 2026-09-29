CREATE TABLE "imaging_media_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"included" boolean DEFAULT false NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"printed_by" text,
	"printed_at" timestamp with time zone,
	"handover_id" text,
	CONSTRAINT "imaging_media_requests_kind_ck" CHECK ("imaging_media_requests"."kind" in ('film', 'cd')),
	CONSTRAINT "imaging_media_requests_qty_ck" CHECK ("imaging_media_requests"."quantity" between 1 and 20 and ("imaging_media_requests"."kind" = 'film' or "imaging_media_requests"."quantity" = 1)),
	CONSTRAINT "imaging_media_requests_printed_ck" CHECK (("imaging_media_requests"."printed_by" is null) = ("imaging_media_requests"."printed_at" is null)),
	CONSTRAINT "imaging_media_requests_handed_ck" CHECK ("imaging_media_requests"."handover_id" is null or "imaging_media_requests"."printed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "imaging_report_handovers" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"study_id" text NOT NULL,
	"collector_kind" text NOT NULL,
	"collector_name" text,
	"collector_relation" text,
	"collector_id_type" text,
	"collector_id_last4" text,
	"film_sheets" integer DEFAULT 0 NOT NULL,
	"cd" boolean DEFAULT false NOT NULL,
	"note" text,
	"handed_by" text NOT NULL,
	"handed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "imaging_report_handovers_kind_ck" CHECK ("imaging_report_handovers"."collector_kind" in ('patient', 'relative', 'ward_staff', 'courier')),
	CONSTRAINT "imaging_report_handovers_id_type_ck" CHECK ("imaging_report_handovers"."collector_id_type" is null or "imaging_report_handovers"."collector_id_type" in ('aadhaar', 'voter_id', 'driving_licence', 'pan', 'passport', 'other')),
	CONSTRAINT "imaging_report_handovers_named_ck" CHECK ("imaging_report_handovers"."collector_kind" = 'patient' or char_length(btrim(coalesce("imaging_report_handovers"."collector_name", ''))) >= 2),
	CONSTRAINT "imaging_report_handovers_relative_ck" CHECK ("imaging_report_handovers"."collector_kind" <> 'relative' or (char_length(btrim(coalesce("imaging_report_handovers"."collector_relation", ''))) >= 2 and "imaging_report_handovers"."collector_id_type" is not null and "imaging_report_handovers"."collector_id_last4" ~ '^[A-Za-z0-9]{4}$')),
	CONSTRAINT "imaging_report_handovers_film_ck" CHECK ("imaging_report_handovers"."film_sheets" >= 0 and "imaging_report_handovers"."film_sheets" <= 20)
);
--> statement-breakpoint
ALTER TABLE "imaging_report_delivery" ADD COLUMN "acted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imaging_report_delivery" ADD COLUMN "acted_by" text;--> statement-breakpoint
ALTER TABLE "imaging_report_delivery" ADD COLUMN "acted_outcome" text;--> statement-breakpoint
ALTER TABLE "imaging_report_delivery" ADD COLUMN "acted_note" text;--> statement-breakpoint
ALTER TABLE "imaging_media_requests" ADD CONSTRAINT "imaging_media_requests_study_id_imaging_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_media_requests" ADD CONSTRAINT "imaging_media_requests_handover_id_imaging_report_handovers_id_fk" FOREIGN KEY ("handover_id") REFERENCES "public"."imaging_report_handovers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_report_handovers" ADD CONSTRAINT "imaging_report_handovers_report_id_imaging_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."imaging_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_report_handovers" ADD CONSTRAINT "imaging_report_handovers_study_id_imaging_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imaging_media_requests_study_idx" ON "imaging_media_requests" USING btree ("study_id");--> statement-breakpoint
CREATE INDEX "imaging_report_handovers_study_idx" ON "imaging_report_handovers" USING btree ("study_id","handed_at");--> statement-breakpoint
CREATE INDEX "imaging_report_handovers_report_idx" ON "imaging_report_handovers" USING btree ("report_id");--> statement-breakpoint
ALTER TABLE "imaging_report_delivery" ADD CONSTRAINT "imaging_report_delivery_acted_ck" CHECK (("imaging_report_delivery"."acted_at" is null) = ("imaging_report_delivery"."acted_by" is null) and ("imaging_report_delivery"."acted_at" is null) = ("imaging_report_delivery"."acted_outcome" is null) and ("imaging_report_delivery"."acted_at" is null) = ("imaging_report_delivery"."acted_note" is null));--> statement-breakpoint
ALTER TABLE "imaging_report_delivery" ADD CONSTRAINT "imaging_report_delivery_acted_outcome_ck" CHECK ("imaging_report_delivery"."acted_outcome" is null or "imaging_report_delivery"."acted_outcome" in ('changed_treatment', 'referred', 'followup_booked', 'discussed_with_patient', 'no_change'));--> statement-breakpoint
ALTER TABLE "imaging_report_delivery" ADD CONSTRAINT "imaging_report_delivery_acted_note_ck" CHECK ("imaging_report_delivery"."acted_note" is null or char_length(btrim("imaging_report_delivery"."acted_note")) >= 4);