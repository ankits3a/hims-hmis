CREATE TABLE "ipd_class_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"stay_id" text NOT NULL,
	"from_class" text NOT NULL,
	"to_class" text NOT NULL,
	"direction" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"consent" jsonb NOT NULL,
	"room_rent_cap_acknowledged" boolean NOT NULL,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "ipd_class_changes_from_ck" CHECK ("ipd_class_changes"."from_class" in ('general', 'semi_private', 'private', 'deluxe', 'suite', 'hdu', 'icu', 'nicu', 'picu', 'ldr', 'daycare', 'emergency', 'overflow')),
	CONSTRAINT "ipd_class_changes_to_ck" CHECK ("ipd_class_changes"."to_class" in ('general', 'semi_private', 'private', 'deluxe', 'suite', 'hdu', 'icu', 'nicu', 'picu', 'ldr', 'daycare', 'emergency', 'overflow')),
	CONSTRAINT "ipd_class_changes_direction_ck" CHECK ("ipd_class_changes"."direction" in ('upgrade', 'downgrade')),
	CONSTRAINT "ipd_class_changes_status_ck" CHECK ("ipd_class_changes"."status" in ('active', 'superseded')),
	CONSTRAINT "ipd_class_changes_differs_ck" CHECK ("ipd_class_changes"."from_class" <> "ipd_class_changes"."to_class")
);
--> statement-breakpoint
CREATE TABLE "ipd_transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"from_bed_id" text NOT NULL,
	"to_bed_id" text NOT NULL,
	"reservation_id" text NOT NULL,
	"reason" text NOT NULL,
	"situation" text NOT NULL,
	"background" text NOT NULL,
	"assessment" text NOT NULL,
	"recommendation" text NOT NULL,
	"draft_id" text,
	"intensivist_approval_id" text,
	"status" text NOT NULL,
	"started_by" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"escalates_at" timestamp with time zone,
	"ended_by" text,
	"ended_at" timestamp with time zone,
	"cancel_reason" text,
	"cancel_note" text,
	CONSTRAINT "ipd_transfers_status_ck" CHECK ("ipd_transfers"."status" in ('open', 'accepted', 'cancelled')),
	CONSTRAINT "ipd_transfers_reason_ck" CHECK ("ipd_transfers"."reason" in ('clinical_step_up', 'clinical_step_down', 'post_op', 'isolation', 'gender_fix', 'patient_request', 'bed_management')),
	CONSTRAINT "ipd_transfers_beds_ck" CHECK ("ipd_transfers"."from_bed_id" <> "ipd_transfers"."to_bed_id"),
	CONSTRAINT "ipd_transfers_ended_ck" CHECK (("ipd_transfers"."status" = 'open') = ("ipd_transfers"."ended_at" is null)),
	CONSTRAINT "ipd_transfers_cancel_ck" CHECK (("ipd_transfers"."status" = 'cancelled') = ("ipd_transfers"."cancel_reason" is not null) and ("ipd_transfers"."cancel_reason" is null or "ipd_transfers"."cancel_reason" in ('patient_deteriorated', 'receiving_ward_declined', 'bed_unsuitable', 'plan_changed', 'other')))
);
--> statement-breakpoint
ALTER TABLE "ipd_class_changes" ADD CONSTRAINT "ipd_class_changes_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_class_changes" ADD CONSTRAINT "ipd_class_changes_stay_id_ipd_bed_stays_id_fk" FOREIGN KEY ("stay_id") REFERENCES "public"."ipd_bed_stays"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_transfers" ADD CONSTRAINT "ipd_transfers_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_transfers" ADD CONSTRAINT "ipd_transfers_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_transfers" ADD CONSTRAINT "ipd_transfers_from_bed_id_resources_id_fk" FOREIGN KEY ("from_bed_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_transfers" ADD CONSTRAINT "ipd_transfers_to_bed_id_resources_id_fk" FOREIGN KEY ("to_bed_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ipd_class_changes_admission_idx" ON "ipd_class_changes" USING btree ("admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_transfers_open_admission_ux" ON "ipd_transfers" USING btree ("admission_id") WHERE "ipd_transfers"."status" = 'open';--> statement-breakpoint
CREATE INDEX "ipd_transfers_open_idx" ON "ipd_transfers" USING btree ("to_bed_id") WHERE "ipd_transfers"."status" = 'open';