CREATE TABLE "imaging_outside_studies" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"centre_name" text NOT NULL,
	"study_date" date NOT NULL,
	"modality" text NOT NULL,
	"external_accession_no" text,
	"arrival" text NOT NULL,
	"notes" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_outside_studies_arrival_ck" CHECK ("imaging_outside_studies"."arrival" in ('film', 'cd', 'link', 'none'))
);
--> statement-breakpoint
ALTER TABLE "imaging_outside_studies" ADD CONSTRAINT "imaging_outside_studies_study_id_imaging_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_outside_studies_study_ux" ON "imaging_outside_studies" USING btree ("study_id");--> statement-breakpoint
CREATE INDEX "imaging_outside_studies_centre_idx" ON "imaging_outside_studies" USING btree ("centre_name","study_date");