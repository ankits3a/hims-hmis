CREATE TABLE "opd_appointments" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"doctor_id" text NOT NULL,
	"department_id" text NOT NULL,
	"service_date" date NOT NULL,
	"slot_start" timestamp with time zone NOT NULL,
	"slot_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"source" text DEFAULT 'desk' NOT NULL,
	"note" text,
	"encounter_id" text,
	"rescheduled_to_id" text,
	"rescheduled_from_id" text,
	"cancel_reason" text,
	"leave_id" text,
	"booked_by" text NOT NULL,
	"booked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opd_config" (
	"id" text PRIMARY KEY NOT NULL,
	"slot_minutes" integer DEFAULT 10 NOT NULL,
	"follow_up_default_days" integer DEFAULT 7 NOT NULL,
	"follow_up_extension_days" jsonb NOT NULL,
	"extension_cap_per_doctor_per_month" integer DEFAULT 30 NOT NULL,
	"max_skips_before_left" integer DEFAULT 3 NOT NULL,
	"perk_every_nth" integer,
	"danger_ranges" jsonb NOT NULL,
	"letterhead" jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opd_departments" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opd_doctor_leaves" (
	"id" text PRIMARY KEY NOT NULL,
	"doctor_id" text NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "opd_doctor_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"doctor_id" text NOT NULL,
	"weekday" integer NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"room_id" text NOT NULL,
	"slot_minutes" integer,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opd_doctors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"registration_no" text,
	"department_id" text NOT NULL,
	"specialty" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opd_encounters" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"type" text DEFAULT 'opd' NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"workflow_instance_id" text NOT NULL,
	"department_id" text,
	"doctor_id" text,
	"appointment_id" text,
	"service_date" date NOT NULL,
	"visit_type" text NOT NULL,
	"intended_payer" text DEFAULT 'self' NOT NULL,
	"referral_source" text,
	"referrer_name" text,
	"chief_complaint" text,
	"diagnosis" text,
	"icd10_code" text,
	"advice" text,
	"admission_advised" boolean DEFAULT false NOT NULL,
	"referral_to" text,
	"referral_note" text,
	"follow_up_days" integer,
	"follow_up_extended" boolean DEFAULT false NOT NULL,
	"danger_flagged" boolean DEFAULT false NOT NULL,
	"consult_started_at" timestamp with time zone,
	"consult_completed_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	"abandon_reason" text,
	"opened_by" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opd_prescriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"encounter_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"doctor_id" text NOT NULL,
	"version" integer NOT NULL,
	"lines" jsonb NOT NULL,
	"document" jsonb NOT NULL,
	"allergy_overrides" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opd_queue_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"session_id" text NOT NULL,
	"encounter_id" text NOT NULL,
	"token_no" integer NOT NULL,
	"kind" text NOT NULL,
	"appointment_at" timestamp with time zone,
	"status" text NOT NULL,
	"danger" boolean DEFAULT false NOT NULL,
	"re_entry" boolean DEFAULT false NOT NULL,
	"perk" boolean DEFAULT false NOT NULL,
	"eligible_at" timestamp with time zone,
	"called_at" timestamp with time zone,
	"call_count" integer DEFAULT 0 NOT NULL,
	"skips" integer DEFAULT 0 NOT NULL,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opd_queue_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"doctor_id" text NOT NULL,
	"service_date" date NOT NULL,
	"room_id" text,
	"status" text DEFAULT 'not_started' NOT NULL,
	"next_token" integer DEFAULT 1 NOT NULL,
	"calls_made" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opd_rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"floor" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opd_vitals" (
	"id" text PRIMARY KEY NOT NULL,
	"encounter_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"height_cm" double precision,
	"weight_kg" double precision,
	"sbp" integer,
	"dbp" integer,
	"pulse" integer,
	"rr" integer,
	"spo2" integer,
	"temp_c" double precision,
	"notes" text,
	"age_years_at_record" integer,
	"band" text NOT NULL,
	"danger_flags" jsonb NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opd_appointments" ADD CONSTRAINT "opd_appointments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_appointments" ADD CONSTRAINT "opd_appointments_doctor_id_opd_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."opd_doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_appointments" ADD CONSTRAINT "opd_appointments_department_id_opd_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."opd_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_doctor_leaves" ADD CONSTRAINT "opd_doctor_leaves_doctor_id_opd_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."opd_doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_doctor_schedules" ADD CONSTRAINT "opd_doctor_schedules_doctor_id_opd_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."opd_doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_doctor_schedules" ADD CONSTRAINT "opd_doctor_schedules_room_id_opd_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."opd_rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_doctors" ADD CONSTRAINT "opd_doctors_department_id_opd_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."opd_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD CONSTRAINT "opd_encounters_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD CONSTRAINT "opd_encounters_department_id_opd_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."opd_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD CONSTRAINT "opd_encounters_doctor_id_opd_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."opd_doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD CONSTRAINT "opd_encounters_appointment_id_opd_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."opd_appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_prescriptions" ADD CONSTRAINT "opd_prescriptions_encounter_id_opd_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."opd_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_prescriptions" ADD CONSTRAINT "opd_prescriptions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_prescriptions" ADD CONSTRAINT "opd_prescriptions_doctor_id_opd_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."opd_doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_queue_entries" ADD CONSTRAINT "opd_queue_entries_session_id_opd_queue_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."opd_queue_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_queue_entries" ADD CONSTRAINT "opd_queue_entries_encounter_id_opd_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."opd_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_queue_sessions" ADD CONSTRAINT "opd_queue_sessions_doctor_id_opd_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."opd_doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_queue_sessions" ADD CONSTRAINT "opd_queue_sessions_room_id_opd_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."opd_rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_vitals" ADD CONSTRAINT "opd_vitals_encounter_id_opd_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."opd_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_vitals" ADD CONSTRAINT "opd_vitals_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opd_appointments_slot_ux" ON "opd_appointments" USING btree ("doctor_id","slot_start") WHERE "opd_appointments"."status" in ('booked', 'checked_in', 'needs_rebooking');--> statement-breakpoint
CREATE INDEX "opd_appointments_doctor_date_idx" ON "opd_appointments" USING btree ("doctor_id","service_date");--> statement-breakpoint
CREATE INDEX "opd_appointments_patient_idx" ON "opd_appointments" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "opd_appointments_status_idx" ON "opd_appointments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "opd_departments_code_ux" ON "opd_departments" USING btree ("code");--> statement-breakpoint
CREATE INDEX "opd_doctor_leaves_doctor_idx" ON "opd_doctor_leaves" USING btree ("doctor_id");--> statement-breakpoint
CREATE INDEX "opd_doctor_schedules_doctor_idx" ON "opd_doctor_schedules" USING btree ("doctor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opd_doctors_user_ux" ON "opd_doctors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "opd_doctors_department_idx" ON "opd_doctors" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "opd_encounters_patient_dept_completed_idx" ON "opd_encounters" USING btree ("patient_id","department_id","consult_completed_at");--> statement-breakpoint
CREATE INDEX "opd_encounters_doctor_completed_idx" ON "opd_encounters" USING btree ("doctor_id","consult_completed_at");--> statement-breakpoint
CREATE INDEX "opd_encounters_doctor_date_idx" ON "opd_encounters" USING btree ("doctor_id","service_date");--> statement-breakpoint
CREATE INDEX "opd_encounters_patient_opened_idx" ON "opd_encounters" USING btree ("patient_id","opened_at");--> statement-breakpoint
CREATE INDEX "opd_encounters_status_idx" ON "opd_encounters" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "opd_prescriptions_encounter_version_ux" ON "opd_prescriptions" USING btree ("encounter_id","version");--> statement-breakpoint
CREATE INDEX "opd_prescriptions_patient_idx" ON "opd_prescriptions" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "opd_queue_entries_session_status_idx" ON "opd_queue_entries" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "opd_queue_entries_encounter_idx" ON "opd_queue_entries" USING btree ("encounter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opd_queue_sessions_doctor_date_ux" ON "opd_queue_sessions" USING btree ("doctor_id","service_date");--> statement-breakpoint
CREATE UNIQUE INDEX "opd_rooms_code_ux" ON "opd_rooms" USING btree ("code");--> statement-breakpoint
CREATE INDEX "opd_vitals_encounter_idx" ON "opd_vitals" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "opd_vitals_patient_idx" ON "opd_vitals" USING btree ("patient_id");