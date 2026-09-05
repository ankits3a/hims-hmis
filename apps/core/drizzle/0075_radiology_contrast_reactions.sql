CREATE TABLE "imaging_contrast_reactions" (
	"id" text PRIMARY KEY NOT NULL,
	"administration_id" text NOT NULL,
	"study_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"allergy_id" text NOT NULL,
	"severity" text NOT NULL,
	"onset" text NOT NULL,
	"manifestation" text NOT NULL,
	"treatment_given" text,
	"managing_clinician_id" text,
	"outcome" text,
	"observed_by" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_contrast_reactions_severity_ck" CHECK ("imaging_contrast_reactions"."severity" in ('mild', 'moderate', 'severe')),
	CONSTRAINT "imaging_contrast_reactions_onset_ck" CHECK ("imaging_contrast_reactions"."onset" in ('immediate', 'delayed')),
	CONSTRAINT "imaging_contrast_reactions_outcome_ck" CHECK ("imaging_contrast_reactions"."outcome" is null or "imaging_contrast_reactions"."outcome" in ('recovered', 'recovering', 'admitted', 'referred', 'died')),
	CONSTRAINT "imaging_contrast_reactions_severe_ck" CHECK ("imaging_contrast_reactions"."severity" <> 'severe' or ("imaging_contrast_reactions"."treatment_given" is not null and "imaging_contrast_reactions"."managing_clinician_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "imaging_contrast_reactions" ADD CONSTRAINT "imaging_contrast_reactions_administration_id_imaging_contrast_administrations_id_fk" FOREIGN KEY ("administration_id") REFERENCES "public"."imaging_contrast_administrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_contrast_reactions" ADD CONSTRAINT "imaging_contrast_reactions_study_id_imaging_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_contrast_reactions" ADD CONSTRAINT "imaging_contrast_reactions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_contrast_reactions" ADD CONSTRAINT "imaging_contrast_reactions_allergy_id_patient_allergies_id_fk" FOREIGN KEY ("allergy_id") REFERENCES "public"."patient_allergies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imaging_contrast_reactions_patient_idx" ON "imaging_contrast_reactions" USING btree ("patient_id","observed_at");--> statement-breakpoint
CREATE INDEX "imaging_contrast_reactions_study_idx" ON "imaging_contrast_reactions" USING btree ("study_id");--> statement-breakpoint
CREATE INDEX "imaging_contrast_reactions_administration_idx" ON "imaging_contrast_reactions" USING btree ("administration_id");