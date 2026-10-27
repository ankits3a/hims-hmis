-- WM-1 (#982, decision 0089): the ward's nurses — shift maps, staff, bed-to-nurse assignments, acuity (append-only), ratio breaches. Additive.
CREATE TABLE "ipd_nurse_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"map_id" text NOT NULL,
	"bed_id" text NOT NULL,
	"admission_id" text,
	"nurse_id" text NOT NULL,
	"student_id" text,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"reason" text,
	"changed_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ipd_patient_acuity" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"shift_date" date NOT NULL,
	"shift" text NOT NULL,
	"level" text NOT NULL,
	"ventilated" boolean DEFAULT false NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_patient_acuity_level_ck" CHECK ("ipd_patient_acuity"."level" in ('self_care', 'partial_care', 'full_care')),
	CONSTRAINT "ipd_patient_acuity_shift_ck" CHECK ("ipd_patient_acuity"."shift" in ('morning', 'evening', 'night'))
);
--> statement-breakpoint
CREATE TABLE "ipd_ward_ratio_breaches" (
	"id" text PRIMARY KEY NOT NULL,
	"ward_id" text NOT NULL,
	"shift_date" date NOT NULL,
	"shift" text NOT NULL,
	"map_id" text,
	"unit" text NOT NULL,
	"patients" integer NOT NULL,
	"ventilated" integer NOT NULL,
	"rns_on_duty" integer NOT NULL,
	"rns_needed" integer NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ipd_ward_shift_maps" (
	"id" text PRIMARY KEY NOT NULL,
	"ward_id" text NOT NULL,
	"shift_date" date NOT NULL,
	"shift" text NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone,
	"late" boolean DEFAULT false NOT NULL,
	"carried_from_id" text,
	"supervisor_told_at" timestamp with time zone,
	CONSTRAINT "ipd_ward_shift_maps_shift_ck" CHECK ("ipd_ward_shift_maps"."shift" in ('morning', 'evening', 'night')),
	CONSTRAINT "ipd_ward_shift_maps_status_ck" CHECK ("ipd_ward_shift_maps"."status" in ('draft', 'published', 'carried_over')),
	CONSTRAINT "ipd_ward_shift_maps_published_ck" CHECK (("ipd_ward_shift_maps"."status" = 'draft') = ("ipd_ward_shift_maps"."published_at" is null))
);
--> statement-breakpoint
CREATE TABLE "ipd_ward_shift_staff" (
	"id" text PRIMARY KEY NOT NULL,
	"map_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"paired_with_id" text,
	"home_ward_id" text,
	"reason" text,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	CONSTRAINT "ipd_ward_shift_staff_kind_ck" CHECK ("ipd_ward_shift_staff"."kind" in ('rn', 'student', 'incharge', 'float')),
	CONSTRAINT "ipd_ward_shift_staff_float_ck" CHECK (("ipd_ward_shift_staff"."kind" = 'float') = ("ipd_ward_shift_staff"."home_ward_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "ipd_nurse_assignments" ADD CONSTRAINT "ipd_nurse_assignments_map_id_ipd_ward_shift_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."ipd_ward_shift_maps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_nurse_assignments" ADD CONSTRAINT "ipd_nurse_assignments_bed_id_resources_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_nurse_assignments" ADD CONSTRAINT "ipd_nurse_assignments_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_patient_acuity" ADD CONSTRAINT "ipd_patient_acuity_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_patient_acuity" ADD CONSTRAINT "ipd_patient_acuity_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_ward_ratio_breaches" ADD CONSTRAINT "ipd_ward_ratio_breaches_ward_id_resources_id_fk" FOREIGN KEY ("ward_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_ward_ratio_breaches" ADD CONSTRAINT "ipd_ward_ratio_breaches_map_id_ipd_ward_shift_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."ipd_ward_shift_maps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_ward_shift_maps" ADD CONSTRAINT "ipd_ward_shift_maps_ward_id_resources_id_fk" FOREIGN KEY ("ward_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_ward_shift_staff" ADD CONSTRAINT "ipd_ward_shift_staff_map_id_ipd_ward_shift_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."ipd_ward_shift_maps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_nurse_assignments_live_ux" ON "ipd_nurse_assignments" USING btree ("map_id","bed_id") WHERE "ipd_nurse_assignments"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "ipd_nurse_assignments_nurse_idx" ON "ipd_nurse_assignments" USING btree ("nurse_id");--> statement-breakpoint
CREATE INDEX "ipd_patient_acuity_admission_idx" ON "ipd_patient_acuity" USING btree ("admission_id","shift_date","shift");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_ward_ratio_breaches_ux" ON "ipd_ward_ratio_breaches" USING btree ("ward_id","shift_date","shift");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_ward_shift_maps_ux" ON "ipd_ward_shift_maps" USING btree ("ward_id","shift_date","shift");--> statement-breakpoint
CREATE INDEX "ipd_ward_shift_maps_date_idx" ON "ipd_ward_shift_maps" USING btree ("shift_date","shift");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_ward_shift_staff_ux" ON "ipd_ward_shift_staff" USING btree ("map_id","user_id");--> statement-breakpoint
CREATE INDEX "ipd_ward_shift_staff_user_idx" ON "ipd_ward_shift_staff" USING btree ("user_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION ipd_acuity_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ipd_acuity_append_only: % rows are append-only (% refused)', TG_TABLE_NAME, TG_OP; END $$;--> statement-breakpoint
CREATE TRIGGER ipd_patient_acuity_append_only BEFORE UPDATE OR DELETE ON ipd_patient_acuity FOR EACH ROW EXECUTE FUNCTION ipd_acuity_forbid_mutation();
