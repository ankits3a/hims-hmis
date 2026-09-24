CREATE TABLE "opd_section_records" (
	"id" text PRIMARY KEY NOT NULL,
	"encounter_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"section_key" text NOT NULL,
	"section_version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"source" text DEFAULT 'typed' NOT NULL,
	"author_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"supersedes_id" text,
	CONSTRAINT "opd_section_records_version_ck" CHECK ("opd_section_records"."section_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "opd_section_records" ADD CONSTRAINT "opd_section_records_encounter_id_opd_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."opd_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_section_records" ADD CONSTRAINT "opd_section_records_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opd_section_records_encounter_idx" ON "opd_section_records" USING btree ("encounter_id","section_key");--> statement-breakpoint
CREATE INDEX "opd_section_records_patient_idx" ON "opd_section_records" USING btree ("patient_id","section_key");--> statement-breakpoint
CREATE UNIQUE INDEX "opd_section_records_supersedes_ux" ON "opd_section_records" USING btree ("supersedes_id") WHERE supersedes_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "opd_section_records_root_ux" ON "opd_section_records" USING btree ("encounter_id","section_key") WHERE supersedes_id is null;