CREATE TABLE "imaging_ir_cases" (
	"study_id" text PRIMARY KEY NOT NULL,
	"coag_override_verdict" text,
	"coag_override_reason" text,
	"coag_override_by" text,
	"coag_override_at" timestamp with time zone,
	"skin_follow_up_on" date,
	"skin_follow_up_note" text,
	"skin_follow_up_by" text,
	"skin_follow_up_at" timestamp with time zone,
	"note_procedure" text,
	"note_approach" text,
	"note_devices" text,
	"note_specimens" text,
	"note_complications" text,
	"note_blood_loss_ml" integer,
	"note_by" text,
	"note_at" timestamp with time zone,
	"handoff" jsonb,
	"handoff_by" text,
	"handoff_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_ir_cases_coag_override_ck" CHECK (("imaging_ir_cases"."coag_override_verdict" is null and "imaging_ir_cases"."coag_override_reason" is null and "imaging_ir_cases"."coag_override_by" is null and "imaging_ir_cases"."coag_override_at" is null)
          or ("imaging_ir_cases"."coag_override_verdict" is not null and char_length(btrim("imaging_ir_cases"."coag_override_reason")) >= 5
              and "imaging_ir_cases"."coag_override_by" is not null and "imaging_ir_cases"."coag_override_at" is not null)),
	CONSTRAINT "imaging_ir_cases_skin_ck" CHECK (("imaging_ir_cases"."skin_follow_up_on" is null) = ("imaging_ir_cases"."skin_follow_up_by" is null) and ("imaging_ir_cases"."skin_follow_up_by" is null) = ("imaging_ir_cases"."skin_follow_up_at" is null)),
	CONSTRAINT "imaging_ir_cases_note_ck" CHECK (("imaging_ir_cases"."note_procedure" is null and "imaging_ir_cases"."note_by" is null and "imaging_ir_cases"."note_at" is null)
          or (char_length(btrim("imaging_ir_cases"."note_procedure")) >= 3 and "imaging_ir_cases"."note_by" is not null and "imaging_ir_cases"."note_at" is not null)),
	CONSTRAINT "imaging_ir_cases_blood_loss_ck" CHECK ("imaging_ir_cases"."note_blood_loss_ml" is null or "imaging_ir_cases"."note_blood_loss_ml" between 0 and 10000),
	CONSTRAINT "imaging_ir_cases_handoff_ck" CHECK (("imaging_ir_cases"."handoff" is null and "imaging_ir_cases"."handoff_by" is null and "imaging_ir_cases"."handoff_at" is null)
          or ("imaging_ir_cases"."handoff" is not null and "imaging_ir_cases"."handoff_by" is not null and "imaging_ir_cases"."handoff_at" is not null and "imaging_ir_cases"."note_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "imaging_ir_checklists" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"phase" text NOT NULL,
	"items" jsonb NOT NULL,
	"participants" jsonb NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "imaging_ir_checklists_phase_ck" CHECK ("imaging_ir_checklists"."phase" in ('sign_in', 'time_out', 'sign_out'))
);
--> statement-breakpoint
CREATE TABLE "imaging_ir_sedation_vitals" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"bp_systolic" integer NOT NULL,
	"bp_diastolic" integer NOT NULL,
	"heart_rate" integer NOT NULL,
	"spo2" integer NOT NULL,
	"rass" integer NOT NULL,
	"drug" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "imaging_ir_sedation_vitals_range_ck" CHECK ("imaging_ir_sedation_vitals"."bp_systolic" between 40 and 300 and "imaging_ir_sedation_vitals"."bp_diastolic" between 20 and 200
          and "imaging_ir_sedation_vitals"."bp_diastolic" < "imaging_ir_sedation_vitals"."bp_systolic" and "imaging_ir_sedation_vitals"."heart_rate" between 20 and 250
          and "imaging_ir_sedation_vitals"."spo2" between 50 and 100 and "imaging_ir_sedation_vitals"."rass" between -5 and 4)
);
--> statement-breakpoint
ALTER TABLE "imaging_dose_sr_receipts" ADD COLUMN "dose_ka_r" numeric(10, 3);--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD COLUMN "dose_ka_r" numeric(10, 3);--> statement-breakpoint
ALTER TABLE "radiation_dose_register" ADD COLUMN "dose_ka_r" numeric(10, 3);--> statement-breakpoint
ALTER TABLE "imaging_ir_cases" ADD CONSTRAINT "imaging_ir_cases_study_id_imaging_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_ir_checklists" ADD CONSTRAINT "imaging_ir_checklists_study_id_imaging_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_ir_sedation_vitals" ADD CONSTRAINT "imaging_ir_sedation_vitals_study_id_imaging_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_ir_checklists_phase_ux" ON "imaging_ir_checklists" USING btree ("study_id","phase");--> statement-breakpoint
CREATE INDEX "imaging_ir_sedation_vitals_study_idx" ON "imaging_ir_sedation_vitals" USING btree ("study_id","recorded_at");