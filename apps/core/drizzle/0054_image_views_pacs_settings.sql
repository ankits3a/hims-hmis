CREATE TABLE "imaging_image_views" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"viewer_id" text NOT NULL,
	"via" text NOT NULL,
	"url_host" text NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_image_views_via_ck" CHECK ("imaging_image_views"."via" in ('external_pacs'))
);
--> statement-breakpoint
ALTER TABLE "imaging_definitions" DROP CONSTRAINT "imaging_definitions_kind_ck";--> statement-breakpoint
ALTER TABLE "imaging_image_views" ADD CONSTRAINT "imaging_image_views_study_id_imaging_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imaging_image_views_study_idx" ON "imaging_image_views" USING btree ("study_id","viewed_at");--> statement-breakpoint
CREATE INDEX "imaging_image_views_viewer_idx" ON "imaging_image_views" USING btree ("viewer_id","viewed_at");--> statement-breakpoint
ALTER TABLE "imaging_definitions" ADD CONSTRAINT "imaging_definitions_kind_ck" CHECK ("imaging_definitions"."kind" in ('study_types', 'pregnancy_policy', 'critical_categories', 'pacs_settings'));