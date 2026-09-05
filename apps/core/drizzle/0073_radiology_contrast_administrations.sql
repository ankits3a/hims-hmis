CREATE TABLE "imaging_contrast_administrations" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"agent" text NOT NULL,
	"volume_ml" numeric(8, 2) NOT NULL,
	"route" text NOT NULL,
	"site" text,
	"vial_batch_no" text,
	"vial_expiry" date,
	"given_by" text NOT NULL,
	"given_at" timestamp with time zone NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_contrast_administrations_route_ck" CHECK ("imaging_contrast_administrations"."route" in ('intravenous', 'intraarterial', 'oral', 'rectal', 'intraarticular', 'intrathecal', 'intravesical', 'intracavitary')),
	CONSTRAINT "imaging_contrast_administrations_volume_ck" CHECK ("imaging_contrast_administrations"."volume_ml" > 0),
	CONSTRAINT "imaging_contrast_administrations_vial_expiry_ck" CHECK ("imaging_contrast_administrations"."vial_expiry" is null or "imaging_contrast_administrations"."vial_expiry" >= ("imaging_contrast_administrations"."given_at" at time zone 'Asia/Kolkata')::date)
);
--> statement-breakpoint
ALTER TABLE "imaging_contrast_administrations" ADD CONSTRAINT "imaging_contrast_administrations_study_id_imaging_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imaging_contrast_administrations_study_idx" ON "imaging_contrast_administrations" USING btree ("study_id","given_at");--> statement-breakpoint
CREATE INDEX "imaging_contrast_administrations_batch_idx" ON "imaging_contrast_administrations" USING btree ("vial_batch_no") WHERE "imaging_contrast_administrations"."vial_batch_no" is not null;