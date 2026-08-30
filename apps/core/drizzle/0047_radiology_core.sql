CREATE TABLE "imaging_bill_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_bill_decisions_kind_ck" CHECK ("imaging_bill_decisions"."kind" in ('contrast_not_given', 'repeat_no_charge', 'performed_then_cancelled', 'acquired_unbilled')),
	CONSTRAINT "imaging_bill_decisions_resolved_ck" CHECK (("imaging_bill_decisions"."resolved_by" is null) = ("imaging_bill_decisions"."resolved_at" is null)),
	CONSTRAINT "imaging_bill_decisions_resolution_ck" CHECK (("imaging_bill_decisions"."resolved_at" is null) = ("imaging_bill_decisions"."resolution" is null))
);
--> statement-breakpoint
CREATE TABLE "imaging_critical_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"category" text NOT NULL,
	"communicated_to" text,
	"channel" text,
	"read_back_text" text,
	"communicated_at" timestamp with time zone,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_critical_findings_category_ck" CHECK ("imaging_critical_findings"."category" in ('red', 'orange', 'yellow')),
	CONSTRAINT "imaging_critical_findings_ack_ck" CHECK (("imaging_critical_findings"."acknowledged_by" is null) = ("imaging_critical_findings"."acknowledged_at" is null))
);
--> statement-breakpoint
CREATE TABLE "imaging_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"drafted_by" text NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone,
	"approval_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_definitions_kind_ck" CHECK ("imaging_definitions"."kind" in ('study_types', 'pregnancy_policy', 'critical_categories')),
	CONSTRAINT "imaging_definitions_status_ck" CHECK ("imaging_definitions"."status" in ('draft', 'active', 'superseded')),
	CONSTRAINT "imaging_definitions_version_ck" CHECK ("imaging_definitions"."version" > 0),
	CONSTRAINT "imaging_definitions_published_ck" CHECK ("imaging_definitions"."status" = 'draft' or ("imaging_definitions"."published_by" is not null and "imaging_definitions"."published_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "imaging_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"template_key" text NOT NULL,
	"body" jsonb NOT NULL,
	"impression" text,
	"laterality" text,
	"critical_category" text,
	"signer_id" text,
	"signed_at" timestamp with time zone,
	"second_factor_at" timestamp with time zone,
	"amendment_reason" text,
	"supersedes_id" text,
	"external_reporter_id" text,
	"provenance" jsonb,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_reports_status_ck" CHECK ("imaging_reports"."status" in ('prelim', 'draft', 'signed', 'amended', 'superseded')),
	CONSTRAINT "imaging_reports_version_ck" CHECK ("imaging_reports"."version" > 0),
	CONSTRAINT "imaging_reports_critical_category_ck" CHECK ("imaging_reports"."critical_category" is null or "imaging_reports"."critical_category" in ('red', 'orange', 'yellow')),
	CONSTRAINT "imaging_reports_laterality_ck" CHECK ("imaging_reports"."laterality" is null or "imaging_reports"."laterality" in ('left', 'right', 'bilateral', 'na')),
	CONSTRAINT "imaging_reports_signed_shape_ck" CHECK ("imaging_reports"."status" in ('prelim', 'draft')
          or ("imaging_reports"."signer_id" is not null and "imaging_reports"."signed_at" is not null and "imaging_reports"."second_factor_at" is not null)),
	CONSTRAINT "imaging_reports_amendment_ck" CHECK ("imaging_reports"."supersedes_id" is null or "imaging_reports"."amendment_reason" is not null),
	CONSTRAINT "imaging_reports_prelim_unpublished_ck" CHECK ("imaging_reports"."status" <> 'prelim' or "imaging_reports"."published_at" is null)
);
--> statement-breakpoint
CREATE TABLE "imaging_safety_screenings" (
	"id" text PRIMARY KEY NOT NULL,
	"study_id" text NOT NULL,
	"kind" text NOT NULL,
	"workflow_instance_id" text NOT NULL,
	"waivable" boolean DEFAULT false NOT NULL,
	"evidence" jsonb,
	"satisfied_by" text,
	"satisfied_at" timestamp with time zone,
	"override" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_safety_screenings_kind_ck" CHECK ("imaging_safety_screenings"."kind" in ('identity_two_factor', 'pregnancy_screen', 'contrast_consent', 'renal_function', 'prior_contrast_reaction', 'mri_safety', 'form_f', 'chaperone_present', 'laterality_confirm', 'mlc_check'))
);
--> statement-breakpoint
CREATE TABLE "imaging_studies" (
	"id" text PRIMARY KEY NOT NULL,
	"order_item_id" text NOT NULL,
	"order_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"encounter_no" text NOT NULL,
	"study_type_code" text NOT NULL,
	"service_id" text NOT NULL,
	"accession_no" text NOT NULL,
	"laterality" text DEFAULT 'na' NOT NULL,
	"priority" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"workflow_instance_id" text NOT NULL,
	"ionising" boolean DEFAULT false NOT NULL,
	"device_resource_id" text,
	"scheduled_at" timestamp with time zone,
	"checked_in_at" timestamp with time zone,
	"acquisition_started_at" timestamp with time zone,
	"acquired_at" timestamp with time zone,
	"acquired_by" text,
	"late_entry" boolean DEFAULT false NOT NULL,
	"image_source" text,
	"study_instance_uid" text,
	"dose_ctdivol" numeric(10, 3),
	"dose_dlp" numeric(10, 3),
	"dose_dap" numeric(10, 3),
	"fluoro_seconds" integer,
	"dose_manual" boolean DEFAULT false NOT NULL,
	"contrast_given" boolean DEFAULT false NOT NULL,
	"contrast_agent" text,
	"contrast_volume_ml" numeric(8, 2),
	"repeat_of_study_id" text,
	"repeat_reason" text,
	"form_f_required" boolean DEFAULT false NOT NULL,
	"invoice_line_id" text,
	"authorised_by" text,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_studies_order_item_id_unique" UNIQUE("order_item_id"),
	CONSTRAINT "imaging_studies_accession_no_unique" UNIQUE("accession_no"),
	CONSTRAINT "imaging_studies_status_ck" CHECK ("imaging_studies"."status" in ('scheduled', 'checked_in', 'ready', 'in_acquisition', 'acquired', 'reported', 'published', 'cancelled', 'no_show', 'rescheduled')),
	CONSTRAINT "imaging_studies_laterality_ck" CHECK ("imaging_studies"."laterality" in ('left', 'right', 'bilateral', 'na')),
	CONSTRAINT "imaging_studies_priority_ck" CHECK ("imaging_studies"."priority" in ('routine', 'urgent', 'stat')),
	CONSTRAINT "imaging_studies_image_source_ck" CHECK ("imaging_studies"."image_source" is null or "imaging_studies"."image_source" in ('pacs', 'no_pacs_images', 'outside')),
	CONSTRAINT "imaging_studies_authorised_by_ck" CHECK ("imaging_studies"."authorised_by" is null or "imaging_studies"."authorised_by" in ('invoice', 'payer_branch', 'daycare', 'stat')),
	CONSTRAINT "imaging_studies_dose_ck" CHECK ("imaging_studies"."acquired_at" is null or "imaging_studies"."ionising" = false
          or "imaging_studies"."dose_ctdivol" is not null or "imaging_studies"."dose_dlp" is not null
          or "imaging_studies"."dose_dap" is not null or "imaging_studies"."fluoro_seconds" is not null),
	CONSTRAINT "imaging_studies_repeat_ck" CHECK (("imaging_studies"."repeat_of_study_id" is null) = ("imaging_studies"."repeat_reason" is null)),
	CONSTRAINT "imaging_studies_contrast_ck" CHECK ("imaging_studies"."contrast_given" = true or ("imaging_studies"."contrast_agent" is null and "imaging_studies"."contrast_volume_ml" is null)),
	CONSTRAINT "imaging_studies_image_source_required_ck" CHECK ("imaging_studies"."acquired_at" is null or "imaging_studies"."image_source" is not null)
);
--> statement-breakpoint
CREATE TABLE "pcpndt_form_f" (
	"id" text PRIMARY KEY NOT NULL,
	"serial_no" integer NOT NULL,
	"serial_year" integer NOT NULL,
	"machine_id" text NOT NULL,
	"person_id" text NOT NULL,
	"study_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"indication_code" text NOT NULL,
	"gestation_weeks" integer,
	"sections" jsonb NOT NULL,
	"declaration" jsonb NOT NULL,
	"referral" jsonb NOT NULL,
	"applicability" text NOT NULL,
	"result_summary" text,
	"status" text DEFAULT 'open' NOT NULL,
	"signed_by" text,
	"signed_at" timestamp with time zone,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pcpndt_form_f_applicability_ck" CHECK ("pcpndt_form_f"."applicability" in ('pregnant', 'not_pregnant', 'indication_only')),
	CONSTRAINT "pcpndt_form_f_status_ck" CHECK ("pcpndt_form_f"."status" in ('open', 'recorded')),
	CONSTRAINT "pcpndt_form_f_serial_ck" CHECK ("pcpndt_form_f"."serial_no" > 0),
	CONSTRAINT "pcpndt_form_f_recorded_shape_ck" CHECK ("pcpndt_form_f"."status" = 'open' or ("pcpndt_form_f"."signed_by" is not null and "pcpndt_form_f"."signed_at" is not null)),
	CONSTRAINT "pcpndt_form_f_verified_ck" CHECK (("pcpndt_form_f"."verified_by" is null) = ("pcpndt_form_f"."verified_at" is null)),
	CONSTRAINT "pcpndt_form_f_verify_after_record_ck" CHECK ("pcpndt_form_f"."verified_at" is null or "pcpndt_form_f"."status" = 'recorded')
);
--> statement-breakpoint
CREATE TABLE "pcpndt_form_f_serials" (
	"machine_id" text NOT NULL,
	"year" integer NOT NULL,
	"next_no" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "pcpndt_form_f_serials_machine_id_year_pk" PRIMARY KEY("machine_id","year")
);
--> statement-breakpoint
CREATE TABLE "pcpndt_registered_machines" (
	"id" text PRIMARY KEY NOT NULL,
	"registration_id" text NOT NULL,
	"device_resource_id" text NOT NULL,
	"make" text NOT NULL,
	"model" text NOT NULL,
	"serial" text NOT NULL,
	"form_b_ref" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pcpndt_registered_persons" (
	"id" text PRIMARY KEY NOT NULL,
	"registration_id" text NOT NULL,
	"user_id" text NOT NULL,
	"qualification" text NOT NULL,
	"council_reg_no" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pcpndt_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"site" text NOT NULL,
	"registration_no" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"incharge_user_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pcpndt_registrations_registration_no_unique" UNIQUE("registration_no"),
	CONSTRAINT "pcpndt_registrations_status_ck" CHECK ("pcpndt_registrations"."status" in ('active', 'suspended', 'cancelled')),
	CONSTRAINT "pcpndt_registrations_validity_ck" CHECK ("pcpndt_registrations"."valid_to" >= "pcpndt_registrations"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "imaging_bill_decisions" ADD CONSTRAINT "imaging_bill_decisions_study_id_imaging_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_critical_findings" ADD CONSTRAINT "imaging_critical_findings_report_id_imaging_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."imaging_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_reports" ADD CONSTRAINT "imaging_reports_study_id_imaging_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_safety_screenings" ADD CONSTRAINT "imaging_safety_screenings_study_id_imaging_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD CONSTRAINT "imaging_studies_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD CONSTRAINT "imaging_studies_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD CONSTRAINT "imaging_studies_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD CONSTRAINT "imaging_studies_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD CONSTRAINT "imaging_studies_device_resource_id_resources_id_fk" FOREIGN KEY ("device_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD CONSTRAINT "imaging_studies_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pcpndt_form_f" ADD CONSTRAINT "pcpndt_form_f_machine_id_pcpndt_registered_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."pcpndt_registered_machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pcpndt_form_f" ADD CONSTRAINT "pcpndt_form_f_person_id_pcpndt_registered_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."pcpndt_registered_persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pcpndt_form_f" ADD CONSTRAINT "pcpndt_form_f_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pcpndt_form_f_serials" ADD CONSTRAINT "pcpndt_form_f_serials_machine_id_pcpndt_registered_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."pcpndt_registered_machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pcpndt_registered_machines" ADD CONSTRAINT "pcpndt_registered_machines_registration_id_pcpndt_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."pcpndt_registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pcpndt_registered_machines" ADD CONSTRAINT "pcpndt_registered_machines_device_resource_id_resources_id_fk" FOREIGN KEY ("device_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pcpndt_registered_persons" ADD CONSTRAINT "pcpndt_registered_persons_registration_id_pcpndt_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."pcpndt_registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pcpndt_registered_persons" ADD CONSTRAINT "pcpndt_registered_persons_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imaging_bill_decisions_study_idx" ON "imaging_bill_decisions" USING btree ("study_id");--> statement-breakpoint
CREATE INDEX "imaging_bill_decisions_open_idx" ON "imaging_bill_decisions" USING btree ("resolved_at","raised_at");--> statement-breakpoint
CREATE INDEX "imaging_critical_findings_report_idx" ON "imaging_critical_findings" USING btree ("report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_definitions_kind_version_ux" ON "imaging_definitions" USING btree ("kind","version");--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_definitions_one_active_ux" ON "imaging_definitions" USING btree ("kind") WHERE "imaging_definitions"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_reports_study_version_ux" ON "imaging_reports" USING btree ("study_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_reports_one_signed_ux" ON "imaging_reports" USING btree ("study_id") WHERE "imaging_reports"."status" = 'signed';--> statement-breakpoint
CREATE INDEX "imaging_reports_study_idx" ON "imaging_reports" USING btree ("study_id");--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_safety_screenings_study_kind_ux" ON "imaging_safety_screenings" USING btree ("study_id","kind");--> statement-breakpoint
CREATE INDEX "imaging_safety_screenings_instance_idx" ON "imaging_safety_screenings" USING btree ("workflow_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_studies_slot_ux" ON "imaging_studies" USING btree ("device_resource_id","scheduled_at") WHERE "imaging_studies"."status" not in ('cancelled', 'rescheduled', 'no_show');--> statement-breakpoint
CREATE INDEX "imaging_studies_worklist_idx" ON "imaging_studies" USING btree ("status","priority","scheduled_at");--> statement-breakpoint
CREATE INDEX "imaging_studies_patient_idx" ON "imaging_studies" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "imaging_studies_order_idx" ON "imaging_studies" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pcpndt_form_f_machine_serial_ux" ON "pcpndt_form_f" USING btree ("machine_id","serial_year","serial_no");--> statement-breakpoint
CREATE UNIQUE INDEX "pcpndt_form_f_study_ux" ON "pcpndt_form_f" USING btree ("study_id");--> statement-breakpoint
CREATE INDEX "pcpndt_form_f_patient_idx" ON "pcpndt_form_f" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "pcpndt_form_f_person_idx" ON "pcpndt_form_f" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pcpndt_registered_machines_device_active_ux" ON "pcpndt_registered_machines" USING btree ("device_resource_id") WHERE "pcpndt_registered_machines"."active" = true;--> statement-breakpoint
CREATE INDEX "pcpndt_registered_machines_registration_idx" ON "pcpndt_registered_machines" USING btree ("registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pcpndt_registered_persons_registration_user_ux" ON "pcpndt_registered_persons" USING btree ("registration_id","user_id");--> statement-breakpoint
CREATE INDEX "pcpndt_registered_persons_user_idx" ON "pcpndt_registered_persons" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pcpndt_registrations_status_idx" ON "pcpndt_registrations" USING btree ("status","valid_to");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- HAND-CARRIED: the two immutability triggers. drizzle-kit emits tables, constraints and indexes
-- and NEVER a trigger, so everything below is written by hand exactly as `0043`, `0044` and `0045`
-- did — and this block is the only place these guarantees exist.
--
-- ═══ WHY A WHOLE-ROW COMPARISON RATHER THAN A LIST OF FROZEN COLUMNS ═══
--
-- `0044`/`0045`'s `orders_forbid_identity_change` enumerates the columns it freezes, and `0045`
-- exists BECAUSE that list was incomplete: `authority` and `external_referrer_id` were left mutable
-- and turned a completed clinician order into a referral fee after the fact, refused by nothing.
-- That is the failure mode of an allow-list written as a deny-list.
--
-- These two tables invert it. **Everything is frozen except a NAMED pair**, compared as whole rows
-- with those two keys removed:
--
--     (to_jsonb(NEW) - 'status' - 'published_at') IS DISTINCT FROM (to_jsonb(OLD) - …)
--
-- Three properties follow, and the third is the one that matters in two years:
--   · the plan's Assertion Book mutant *"the trigger omits `body`"* (T8 A5) / *"omits `sections`"*
--     (T6 A4) CANNOT be written by omission — there is nothing to omit from;
--   · `IS DISTINCT FROM` handles NULLs, so setting a null column to a value is caught;
--   · **a column added to either table by a LATER migration is frozen by default.** 18b adds
--     `provenance` writes and 18a-ii adds return-compiler columns; each must consciously widen this
--     trigger to make one mutable, instead of silently inheriting mutability.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- §11.6 / E11 — an amended report is VERSIONED, never overwritten. This is the table a courtroom
-- reads: the signed document, its signer, the instant, and the second factor behind it. `status`
-- and `published_at` are the two columns publication and supersession move, and nothing else moves
-- at all. `amend` therefore INSERTS v(n+1) and flips v(n) to `superseded` — which this permits —
-- rather than UPDATEing v1, which it refuses (T8 A2's mutant).
CREATE OR REPLACE FUNCTION imaging_reports_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'imaging_report_immutable: imaging_reports rows are append-only (DELETE refused)';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'published_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'published_at') THEN
    RAISE EXCEPTION 'imaging_report_immutable: only status and published_at may change after insert';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER imaging_reports_immutable BEFORE UPDATE OR DELETE ON imaging_reports FOR EACH ROW EXECUTE FUNCTION imaging_reports_forbid_mutation();--> statement-breakpoint

-- DD14 / A4 — a Form F row is a statutory declaration and is APPEND-ONLY the moment it is written.
-- `verified_by` and `verified_at` are the only columns that may ever change, and only the PCPNDT
-- in-charge sets them: separation of duties means the officer who VERIFIES a form is never the one
-- who WROTE it (`verifyFormF` refuses `same_actor`). The mutant this refuses is *"the trigger omits
-- `sections`"* — Part F carries the indication for the scan, which is the field an inspection turns
-- on, and it must not be editable after the inspector has left.
CREATE OR REPLACE FUNCTION pcpndt_form_f_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pcpndt_form_f_immutable: pcpndt_form_f rows are append-only (DELETE refused)';
  END IF;
  IF (to_jsonb(NEW) - 'verified_by' - 'verified_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'verified_by' - 'verified_at') THEN
    RAISE EXCEPTION 'pcpndt_form_f_immutable: only verified_by and verified_at may change after insert';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER pcpndt_form_f_immutable BEFORE UPDATE OR DELETE ON pcpndt_form_f FOR EACH ROW EXECUTE FUNCTION pcpndt_form_f_forbid_mutation();
