CREATE TABLE "opd_consult_layouts" (
	"id" text PRIMARY KEY NOT NULL,
	"department_id" text NOT NULL,
	"doctor_id" text,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "opd_consult_layouts_version_ck" CHECK ("opd_consult_layouts"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "layout_default_id" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "layout_overlay_id" text;--> statement-breakpoint
ALTER TABLE "opd_consult_layouts" ADD CONSTRAINT "opd_consult_layouts_department_id_opd_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."opd_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_consult_layouts" ADD CONSTRAINT "opd_consult_layouts_doctor_id_opd_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."opd_doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opd_consult_layouts_default_ux" ON "opd_consult_layouts" USING btree ("department_id","version") WHERE doctor_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "opd_consult_layouts_overlay_ux" ON "opd_consult_layouts" USING btree ("department_id","doctor_id","version") WHERE doctor_id is not null;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD CONSTRAINT "opd_encounters_layout_default_id_opd_consult_layouts_id_fk" FOREIGN KEY ("layout_default_id") REFERENCES "public"."opd_consult_layouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD CONSTRAINT "opd_encounters_layout_overlay_id_opd_consult_layouts_id_fk" FOREIGN KEY ("layout_overlay_id") REFERENCES "public"."opd_consult_layouts"("id") ON DELETE no action ON UPDATE no action;