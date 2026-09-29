CREATE TABLE "imaging_dose_sr_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"sop_instance_uid" text NOT NULL,
	"study_instance_uid" text NOT NULL,
	"accession_number" text,
	"study_id" text,
	"template" text NOT NULL,
	"dose_ctdivol" numeric(10, 3),
	"dose_dlp" numeric(10, 3),
	"dose_dap" numeric(10, 3),
	"fluoro_seconds" integer,
	"dose_agd" numeric(10, 3),
	"outcome" text NOT NULL,
	"conflict" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "imaging_dose_sr_receipts_sop_instance_uid_unique" UNIQUE("sop_instance_uid"),
	CONSTRAINT "imaging_dose_sr_receipts_outcome_ck" CHECK ("imaging_dose_sr_receipts"."outcome" in ('pending', 'recorded', 'confirmed', 'conflict', 'unmatched', 'not_applicable')),
	CONSTRAINT "imaging_dose_sr_receipts_template_ck" CHECK ("imaging_dose_sr_receipts"."template" in ('ct_10011', 'projection_10001', 'unknown')),
	CONSTRAINT "imaging_dose_sr_receipts_dose_ck" CHECK ("imaging_dose_sr_receipts"."dose_ctdivol" is not null or "imaging_dose_sr_receipts"."dose_dlp" is not null or "imaging_dose_sr_receipts"."dose_dap" is not null
          or "imaging_dose_sr_receipts"."fluoro_seconds" is not null or "imaging_dose_sr_receipts"."dose_agd" is not null),
	CONSTRAINT "imaging_dose_sr_receipts_conflict_ck" CHECK (("imaging_dose_sr_receipts"."outcome" = 'conflict') = ("imaging_dose_sr_receipts"."conflict" is not null))
);
--> statement-breakpoint
CREATE TABLE "imaging_unmatched_studies" (
	"id" text PRIMARY KEY NOT NULL,
	"study_instance_uid" text NOT NULL,
	"accession_number" text,
	"dicom_patient_id" text,
	"dicom_patient_name" text,
	"modality" text,
	"study_date" date,
	"series_count" integer DEFAULT 0 NOT NULL,
	"instance_count" integer DEFAULT 0 NOT NULL,
	"archive_ref" text,
	"reason" text NOT NULL,
	"candidate_study_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_study_id" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"resolution_reason" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_unmatched_studies_study_instance_uid_unique" UNIQUE("study_instance_uid"),
	CONSTRAINT "imaging_unmatched_studies_reason_ck" CHECK ("imaging_unmatched_studies"."reason" in ('no_match', 'patient_mismatch', 'uid_mismatch', 'awaiting_acquisition', 'study_closed', 'outside_study', 'no_identifiers')),
	CONSTRAINT "imaging_unmatched_studies_status_ck" CHECK ("imaging_unmatched_studies"."status" in ('open', 'attached', 'rejected')),
	CONSTRAINT "imaging_unmatched_studies_resolved_ck" CHECK (("imaging_unmatched_studies"."status" = 'open') = ("imaging_unmatched_studies"."resolved_at" is null)),
	CONSTRAINT "imaging_unmatched_studies_attached_ck" CHECK ("imaging_unmatched_studies"."status" <> 'attached' or "imaging_unmatched_studies"."resolved_study_id" is not null),
	CONSTRAINT "imaging_unmatched_studies_human_ck" CHECK ("imaging_unmatched_studies"."status" = 'open' or ("imaging_unmatched_studies"."resolved_by" is not null and "imaging_unmatched_studies"."resolution_reason" is not null)
          or ("imaging_unmatched_studies"."status" = 'attached' and "imaging_unmatched_studies"."resolved_by" is null))
);
--> statement-breakpoint
ALTER TABLE "imaging_studies" DROP CONSTRAINT "imaging_studies_dose_ck";--> statement-breakpoint
ALTER TABLE "radiation_dose_register" DROP CONSTRAINT "radiation_dose_register_dose_ck";--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD COLUMN "dose_agd" numeric(10, 3);--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD COLUMN "images_arrived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD COLUMN "image_series_count" integer;--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD COLUMN "image_instance_count" integer;--> statement-breakpoint
ALTER TABLE "radiation_dose_register" ADD COLUMN "dose_agd" numeric(10, 3);--> statement-breakpoint
ALTER TABLE "radiation_dose_register" ADD COLUMN "dose_origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "imaging_dose_sr_receipts" ADD CONSTRAINT "imaging_dose_sr_receipts_study_id_imaging_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_unmatched_studies" ADD CONSTRAINT "imaging_unmatched_studies_candidate_study_id_imaging_studies_id_fk" FOREIGN KEY ("candidate_study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_unmatched_studies" ADD CONSTRAINT "imaging_unmatched_studies_resolved_study_id_imaging_studies_id_fk" FOREIGN KEY ("resolved_study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imaging_dose_sr_receipts_uid_idx" ON "imaging_dose_sr_receipts" USING btree ("study_instance_uid");--> statement-breakpoint
CREATE INDEX "imaging_dose_sr_receipts_study_idx" ON "imaging_dose_sr_receipts" USING btree ("study_id");--> statement-breakpoint
CREATE INDEX "imaging_dose_sr_receipts_outcome_idx" ON "imaging_dose_sr_receipts" USING btree ("outcome","received_at");--> statement-breakpoint
CREATE INDEX "imaging_unmatched_studies_status_idx" ON "imaging_unmatched_studies" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "imaging_unmatched_studies_accession_idx" ON "imaging_unmatched_studies" USING btree ("accession_number");--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD CONSTRAINT "imaging_studies_dose_ck" CHECK ("imaging_studies"."acquired_at" is null or "imaging_studies"."ionising" = false
          or "imaging_studies"."dose_ctdivol" is not null or "imaging_studies"."dose_dlp" is not null
          or "imaging_studies"."dose_dap" is not null or "imaging_studies"."fluoro_seconds" is not null
          or "imaging_studies"."dose_agd" is not null);--> statement-breakpoint
ALTER TABLE "radiation_dose_register" ADD CONSTRAINT "radiation_dose_register_origin_ck" CHECK ("radiation_dose_register"."dose_origin" in ('manual', 'dose_sr'));--> statement-breakpoint
ALTER TABLE "radiation_dose_register" ADD CONSTRAINT "radiation_dose_register_dose_ck" CHECK ("radiation_dose_register"."dose_ctdivol" is not null or "radiation_dose_register"."dose_dlp" is not null
          or "radiation_dose_register"."dose_dap" is not null or "radiation_dose_register"."fluoro_seconds" is not null
          or "radiation_dose_register"."dose_agd" is not null);