CREATE TABLE "imaging_followups" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"report_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"source" text NOT NULL,
	"recommendation" text NOT NULL,
	"interval_label" text NOT NULL,
	"due_on" date NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"overdue_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"notified_by" text,
	"notified_channel" text,
	"notified_note" text,
	"booked_order_id" text,
	"booked_order_no" text,
	"booked_at" timestamp with time zone,
	"booked_by" text,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"close_reason" text,
	"close_note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_followups_source_ck" CHECK ("imaging_followups"."source" in ('birads', 'tirads', 'lirads', 'lungrads', 'fleischner', 'other')),
	CONSTRAINT "imaging_followups_state_ck" CHECK ("imaging_followups"."state" in ('open', 'notified', 'booked', 'closed')),
	CONSTRAINT "imaging_followups_recommendation_ck" CHECK (char_length(btrim("imaging_followups"."recommendation")) >= 3),
	CONSTRAINT "imaging_followups_notified_ck" CHECK (("imaging_followups"."notified_at" is null) = ("imaging_followups"."notified_by" is null) and ("imaging_followups"."notified_at" is null) = ("imaging_followups"."notified_channel" is null)
          and ("imaging_followups"."notified_channel" is null or "imaging_followups"."notified_channel" in ('letter', 'phone', 'in_person'))),
	CONSTRAINT "imaging_followups_booked_ck" CHECK (("imaging_followups"."booked_order_id" is null) = ("imaging_followups"."booked_at" is null) and ("imaging_followups"."booked_order_id" is null) = ("imaging_followups"."booked_by" is null)
          and ("imaging_followups"."state" <> 'booked' or "imaging_followups"."booked_order_id" is not null)),
	CONSTRAINT "imaging_followups_closed_ck" CHECK (("imaging_followups"."state" = 'closed') = ("imaging_followups"."closed_at" is not null) and ("imaging_followups"."closed_at" is null) = ("imaging_followups"."closed_by" is null)
          and ("imaging_followups"."closed_at" is null) = ("imaging_followups"."close_reason" is null)
          and ("imaging_followups"."close_reason" is null or "imaging_followups"."close_reason" in ('done_here', 'done_elsewhere', 'clinician_declines', 'patient_declines', 'patient_died', 'withdrawn_by_amendment'))),
	CONSTRAINT "imaging_followups_notified_state_ck" CHECK ("imaging_followups"."state" <> 'notified' or "imaging_followups"."notified_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "imaging_peer_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"study_id" text NOT NULL,
	"reader_id" text NOT NULL,
	"trigger" text NOT NULL,
	"sample_month" text,
	"state" text DEFAULT 'open' NOT NULL,
	"reviewer_id" text,
	"score" text,
	"learning_case" boolean DEFAULT false NOT NULL,
	"note" text,
	"scored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_peer_reviews_trigger_ck" CHECK ("imaging_peer_reviews"."trigger" in ('random', 'amendment', 'overread_discrepancy')),
	CONSTRAINT "imaging_peer_reviews_state_ck" CHECK ("imaging_peer_reviews"."state" in ('open', 'scored')),
	CONSTRAINT "imaging_peer_reviews_score_ck" CHECK ("imaging_peer_reviews"."score" is null or "imaging_peer_reviews"."score" in ('1', '2a', '2b', '3a', '3b', '4a', '4b')),
	CONSTRAINT "imaging_peer_reviews_month_ck" CHECK (("imaging_peer_reviews"."trigger" = 'random') = ("imaging_peer_reviews"."sample_month" is not null) and ("imaging_peer_reviews"."sample_month" is null or "imaging_peer_reviews"."sample_month" ~ '^[0-9]{4}-[0-9]{2}$')),
	CONSTRAINT "imaging_peer_reviews_scored_ck" CHECK (("imaging_peer_reviews"."state" = 'scored') = ("imaging_peer_reviews"."reviewer_id" is not null) and ("imaging_peer_reviews"."state" = 'scored') = ("imaging_peer_reviews"."score" is not null)
          and ("imaging_peer_reviews"."state" = 'scored') = ("imaging_peer_reviews"."scored_at" is not null)),
	CONSTRAINT "imaging_peer_reviews_not_own_ck" CHECK ("imaging_peer_reviews"."reviewer_id" is null or "imaging_peer_reviews"."reviewer_id" <> "imaging_peer_reviews"."reader_id"),
	CONSTRAINT "imaging_peer_reviews_note_ck" CHECK ("imaging_peer_reviews"."score" is null or "imaging_peer_reviews"."score" = '1' or char_length(btrim(coalesce("imaging_peer_reviews"."note", ''))) >= 4)
);
--> statement-breakpoint
CREATE TABLE "imaging_tele_reads" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"prelim_report_id" text NOT NULL,
	"provider_key" text NOT NULL,
	"provider_name" text NOT NULL,
	"reader_id" text NOT NULL,
	"reader_name" text NOT NULL,
	"reader_nmc_no" text NOT NULL,
	"priority" text NOT NULL,
	"target_minutes" integer,
	"images_at" timestamp with time zone,
	"prelim_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'awaiting' NOT NULL,
	"overread_by" text,
	"overread_at" timestamp with time zone,
	"overread_note" text,
	"final_report_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_tele_reads_state_ck" CHECK ("imaging_tele_reads"."state" in ('awaiting', 'concur', 'minor', 'major')),
	CONSTRAINT "imaging_tele_reads_priority_ck" CHECK ("imaging_tele_reads"."priority" in ('routine', 'urgent', 'stat')),
	CONSTRAINT "imaging_tele_reads_nmc_ck" CHECK (char_length(btrim("imaging_tele_reads"."reader_nmc_no")) >= 3),
	CONSTRAINT "imaging_tele_reads_overread_ck" CHECK (("imaging_tele_reads"."state" = 'awaiting') = ("imaging_tele_reads"."overread_by" is null) and ("imaging_tele_reads"."state" = 'awaiting') = ("imaging_tele_reads"."overread_at" is null)
          and ("imaging_tele_reads"."state" = 'awaiting') = ("imaging_tele_reads"."final_report_id" is null)),
	CONSTRAINT "imaging_tele_reads_note_ck" CHECK ("imaging_tele_reads"."state" not in ('minor', 'major') or char_length(btrim(coalesce("imaging_tele_reads"."overread_note", ''))) >= 4),
	CONSTRAINT "imaging_tele_reads_not_own_ck" CHECK ("imaging_tele_reads"."overread_by" is null or "imaging_tele_reads"."overread_by" <> "imaging_tele_reads"."reader_id")
);
--> statement-breakpoint
ALTER TABLE "imaging_definitions" DROP CONSTRAINT "imaging_definitions_kind_ck";--> statement-breakpoint
ALTER TABLE "imaging_followups" ADD CONSTRAINT "imaging_followups_study_id_imaging_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_followups" ADD CONSTRAINT "imaging_followups_report_id_imaging_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."imaging_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_followups" ADD CONSTRAINT "imaging_followups_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_followups" ADD CONSTRAINT "imaging_followups_booked_order_id_orders_id_fk" FOREIGN KEY ("booked_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_peer_reviews" ADD CONSTRAINT "imaging_peer_reviews_report_id_imaging_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."imaging_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_peer_reviews" ADD CONSTRAINT "imaging_peer_reviews_study_id_imaging_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_tele_reads" ADD CONSTRAINT "imaging_tele_reads_study_id_imaging_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_tele_reads" ADD CONSTRAINT "imaging_tele_reads_prelim_report_id_imaging_reports_id_fk" FOREIGN KEY ("prelim_report_id") REFERENCES "public"."imaging_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_tele_reads" ADD CONSTRAINT "imaging_tele_reads_final_report_id_imaging_reports_id_fk" FOREIGN KEY ("final_report_id") REFERENCES "public"."imaging_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_followups_report_source_ux" ON "imaging_followups" USING btree ("report_id","source");--> statement-breakpoint
CREATE INDEX "imaging_followups_state_due_idx" ON "imaging_followups" USING btree ("state","due_on");--> statement-breakpoint
CREATE INDEX "imaging_followups_patient_idx" ON "imaging_followups" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "imaging_followups_booked_order_idx" ON "imaging_followups" USING btree ("booked_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_peer_reviews_report_trigger_ux" ON "imaging_peer_reviews" USING btree ("report_id","trigger");--> statement-breakpoint
CREATE INDEX "imaging_peer_reviews_state_idx" ON "imaging_peer_reviews" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "imaging_peer_reviews_reader_idx" ON "imaging_peer_reviews" USING btree ("reader_id","scored_at");--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_tele_reads_prelim_ux" ON "imaging_tele_reads" USING btree ("prelim_report_id");--> statement-breakpoint
CREATE INDEX "imaging_tele_reads_state_idx" ON "imaging_tele_reads" USING btree ("state","prelim_at");--> statement-breakpoint
CREATE INDEX "imaging_tele_reads_study_idx" ON "imaging_tele_reads" USING btree ("study_id");--> statement-breakpoint
ALTER TABLE "imaging_definitions" ADD CONSTRAINT "imaging_definitions_kind_ck" CHECK ("imaging_definitions"."kind" in ('study_types', 'pregnancy_policy', 'critical_categories', 'pacs_settings', 'dose_reference_levels', 'imaging_protocols', 'report_templates', 'report_signatories', 'teleradiology'));