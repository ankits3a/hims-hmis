CREATE TABLE "ipd_intake_output" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"recorded_by" text NOT NULL,
	"source" text NOT NULL,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"volume_ml" integer NOT NULL,
	"note" text,
	CONSTRAINT "ipd_intake_output_direction_ck" CHECK ("ipd_intake_output"."direction" in ('in', 'out')),
	CONSTRAINT "ipd_intake_output_volume_ck" CHECK ("ipd_intake_output"."volume_ml" > 0)
);
--> statement-breakpoint
CREATE TABLE "ipd_nursing_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"kind" text NOT NULL,
	"score_kind" text,
	"band" text,
	"score_value" integer,
	"vitals_id" text,
	"raised_at" timestamp with time zone NOT NULL,
	"escalated_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"supervisor_told_at" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	"cleared_by" text,
	CONSTRAINT "ipd_nursing_alerts_kind_ck" CHECK ("ipd_nursing_alerts"."kind" in ('ews', 'assessment_overdue')),
	CONSTRAINT "ipd_nursing_alerts_band_ck" CHECK ("ipd_nursing_alerts"."band" is null or "ipd_nursing_alerts"."band" in ('low', 'low_medium', 'medium', 'high')),
	CONSTRAINT "ipd_nursing_alerts_ews_ck" CHECK (("ipd_nursing_alerts"."kind" = 'ews') = ("ipd_nursing_alerts"."band" is not null))
);
--> statement-breakpoint
CREATE TABLE "ipd_nursing_assessments" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"happened_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"recorded_by" text NOT NULL,
	"source" text NOT NULL,
	"late_entry" boolean NOT NULL,
	"morse" integer NOT NULL,
	"braden" integer NOT NULL,
	"nutrition" text NOT NULL,
	"allergies" jsonb NOT NULL,
	"home_medicines" jsonb NOT NULL,
	"pain_score" integer NOT NULL,
	"pressure_injuries" jsonb NOT NULL,
	"lines_devices" jsonb NOT NULL,
	"obstetric" text,
	CONSTRAINT "ipd_nursing_assessments_obstetric_ck" CHECK ("ipd_nursing_assessments"."obstetric" is null or "ipd_nursing_assessments"."obstetric" in ('none', 'pregnant', 'postpartum'))
);
--> statement-breakpoint
CREATE TABLE "ipd_nursing_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"recorded_by" text NOT NULL,
	"source" text NOT NULL,
	"late_entry" boolean NOT NULL,
	"category" text NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ipd_shift_handovers" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"ward_id" text,
	"shift" text NOT NULL,
	"situation" text NOT NULL,
	"background" text NOT NULL,
	"assessment" text NOT NULL,
	"recommendation" text NOT NULL,
	"status" text NOT NULL,
	"given_by" text NOT NULL,
	"given_at" timestamp with time zone NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "ipd_shift_handovers_status_ck" CHECK ("ipd_shift_handovers"."status" in ('given', 'accepted', 'superseded')),
	CONSTRAINT "ipd_shift_handovers_shift_ck" CHECK ("ipd_shift_handovers"."shift" in ('morning', 'evening', 'night')),
	CONSTRAINT "ipd_shift_handovers_accepted_ck" CHECK (("ipd_shift_handovers"."status" = 'accepted') = ("ipd_shift_handovers"."accepted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "ipd_vitals" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"recorded_by" text NOT NULL,
	"source" text NOT NULL,
	"device_id" text,
	"client_key" text NOT NULL,
	"late_entry" boolean NOT NULL,
	"refused" boolean DEFAULT false NOT NULL,
	"confirmed_out_of_range" boolean DEFAULT false NOT NULL,
	"temperature_c" double precision,
	"pulse" integer,
	"resp_rate" integer,
	"systolic" integer,
	"diastolic" integer,
	"spo2" integer,
	"on_oxygen" boolean,
	"consciousness" text,
	"pain_score" integer,
	"cap_refill_sec" integer,
	"score_kind" text,
	"score_value" integer,
	"score_band" text,
	"score_complete" boolean,
	CONSTRAINT "ipd_vitals_kind_ck" CHECK ("ipd_vitals"."score_kind" is null or "ipd_vitals"."score_kind" in ('news2', 'meows', 'pews')),
	CONSTRAINT "ipd_vitals_band_ck" CHECK ("ipd_vitals"."score_band" is null or "ipd_vitals"."score_band" in ('low', 'low_medium', 'medium', 'high')),
	CONSTRAINT "ipd_vitals_consciousness_ck" CHECK ("ipd_vitals"."consciousness" is null or "ipd_vitals"."consciousness" in ('alert', 'confused', 'voice', 'pain', 'unresponsive')),
	CONSTRAINT "ipd_vitals_score_ck" CHECK (("ipd_vitals"."score_kind" is null) = ("ipd_vitals"."score_value" is null) and ("ipd_vitals"."score_kind" is null) = ("ipd_vitals"."score_band" is null))
);
--> statement-breakpoint
ALTER TABLE "ipd_intake_output" ADD CONSTRAINT "ipd_intake_output_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_intake_output" ADD CONSTRAINT "ipd_intake_output_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_nursing_alerts" ADD CONSTRAINT "ipd_nursing_alerts_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_nursing_alerts" ADD CONSTRAINT "ipd_nursing_alerts_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_nursing_assessments" ADD CONSTRAINT "ipd_nursing_assessments_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_nursing_assessments" ADD CONSTRAINT "ipd_nursing_assessments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_nursing_notes" ADD CONSTRAINT "ipd_nursing_notes_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_nursing_notes" ADD CONSTRAINT "ipd_nursing_notes_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_shift_handovers" ADD CONSTRAINT "ipd_shift_handovers_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_shift_handovers" ADD CONSTRAINT "ipd_shift_handovers_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_vitals" ADD CONSTRAINT "ipd_vitals_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_vitals" ADD CONSTRAINT "ipd_vitals_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ipd_intake_output_admission_observed_idx" ON "ipd_intake_output" USING btree ("admission_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_nursing_alerts_open_ews_ux" ON "ipd_nursing_alerts" USING btree ("admission_id") WHERE "ipd_nursing_alerts"."kind" = 'ews' and "ipd_nursing_alerts"."cleared_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_nursing_alerts_assessment_ux" ON "ipd_nursing_alerts" USING btree ("admission_id") WHERE "ipd_nursing_alerts"."kind" = 'assessment_overdue';--> statement-breakpoint
CREATE INDEX "ipd_nursing_alerts_open_idx" ON "ipd_nursing_alerts" USING btree ("cleared_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_nursing_assessments_admission_ux" ON "ipd_nursing_assessments" USING btree ("admission_id");--> statement-breakpoint
CREATE INDEX "ipd_nursing_notes_admission_observed_idx" ON "ipd_nursing_notes" USING btree ("admission_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_shift_handovers_open_ux" ON "ipd_shift_handovers" USING btree ("admission_id") WHERE "ipd_shift_handovers"."status" = 'given';--> statement-breakpoint
CREATE INDEX "ipd_shift_handovers_status_idx" ON "ipd_shift_handovers" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_vitals_client_key_ux" ON "ipd_vitals" USING btree ("client_key");--> statement-breakpoint
CREATE INDEX "ipd_vitals_admission_observed_idx" ON "ipd_vitals" USING btree ("admission_id","observed_at");