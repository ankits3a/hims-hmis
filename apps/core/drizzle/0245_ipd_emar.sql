CREATE TABLE "ipd_emar_acts" (
	"id" text PRIMARY KEY NOT NULL,
	"dose_id" text NOT NULL,
	"order_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"kind" text NOT NULL,
	"slot_seq" integer,
	"at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"actor_id" text NOT NULL,
	"provenance" text NOT NULL,
	"reason" text,
	"note" text,
	"patient_check" text,
	"override_reason" text,
	"wristband_code" text,
	"label_id" text,
	"second_nurse_id" text,
	"weight_kg" double precision,
	"late" boolean DEFAULT false NOT NULL,
	"lasa_confirmed" boolean DEFAULT false NOT NULL,
	"npo_override" text,
	"npo_doctor_id" text,
	"npo_reason" text,
	"corrects_act_id" text,
	"incident_id" text,
	"ward_id" text,
	CONSTRAINT "ipd_emar_acts_kind_ck" CHECK ("ipd_emar_acts"."kind" in ('given', 'held', 'missed', 'refused', 'reoffered', 'cancelled', 'entered_in_error', 'medication_incident')),
	CONSTRAINT "ipd_emar_acts_given_ck" CHECK ("ipd_emar_acts"."kind" <> 'given' or ("ipd_emar_acts"."patient_check" in ('scan', 'override') and "ipd_emar_acts"."label_id" is not null)),
	CONSTRAINT "ipd_emar_acts_override_ck" CHECK (coalesce("ipd_emar_acts"."patient_check", '') <> 'override' or ("ipd_emar_acts"."override_reason" is not null and "ipd_emar_acts"."note" is not null)),
	CONSTRAINT "ipd_emar_acts_npo_ck" CHECK ("ipd_emar_acts"."npo_override" is null or ("ipd_emar_acts"."npo_override" in ('sips_allowed', 'doctor_ok') and "ipd_emar_acts"."npo_reason" is not null and ("ipd_emar_acts"."npo_override" <> 'doctor_ok' or "ipd_emar_acts"."npo_doctor_id" is not null))),
	CONSTRAINT "ipd_emar_acts_correction_ck" CHECK (("ipd_emar_acts"."kind" in ('entered_in_error', 'medication_incident')) = ("ipd_emar_acts"."corrects_act_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "ipd_emar_allergy_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"allergy_id" text NOT NULL,
	"substances" jsonb NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"doctor_decision" text,
	"doctor_reason" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" text,
	CONSTRAINT "ipd_emar_allergy_flags_decision_ck" CHECK ("ipd_emar_allergy_flags"."doctor_decision" is null or ("ipd_emar_allergy_flags"."doctor_decision" in ('stop', 'continue') and "ipd_emar_allergy_flags"."doctor_reason" is not null and "ipd_emar_allergy_flags"."decided_by" is not null)),
	CONSTRAINT "ipd_emar_allergy_flags_resolve_ck" CHECK ("ipd_emar_allergy_flags"."resolved_at" is null or "ipd_emar_allergy_flags"."doctor_decision" is not null)
);
--> statement-breakpoint
CREATE TABLE "ipd_emar_doses" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"window_minutes" integer NOT NULL,
	"prn" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"reoffer" boolean DEFAULT false NOT NULL,
	"reoffered_at" timestamp with time zone,
	"slot_seq" integer DEFAULT 0 NOT NULL,
	"last_act_id" text,
	"miss_alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_emar_doses_status_ck" CHECK ("ipd_emar_doses"."status" in ('scheduled', 'given', 'held', 'missed', 'refused', 'cancelled')),
	CONSTRAINT "ipd_emar_doses_window_ck" CHECK ("ipd_emar_doses"."window_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "ipd_emar_infusion_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"event" text NOT NULL,
	"rate_ml_per_hour" double precision,
	"at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"actor_id" text NOT NULL,
	"second_nurse_id" text,
	"patient_check" text,
	"override_reason" text,
	"override_note" text,
	"wristband_code" text,
	"label_id" text,
	CONSTRAINT "ipd_emar_infusion_check_ck" CHECK ("ipd_emar_infusion_events"."event" not in ('start', 'rate_change') or ("ipd_emar_infusion_events"."patient_check" in ('scan', 'override') and "ipd_emar_infusion_events"."label_id" is not null)),
	CONSTRAINT "ipd_emar_infusion_event_ck" CHECK ("ipd_emar_infusion_events"."event" in ('start', 'rate_change', 'pause', 'resume', 'stop'))
);
--> statement-breakpoint
CREATE TABLE "ipd_emar_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"item_id" text,
	"store_id" text,
	"batches" jsonb NOT NULL,
	"units" integer NOT NULL,
	"strip_size" integer NOT NULL,
	"own_medicine" boolean NOT NULL,
	"own_batch_no" text,
	"own_expiry" text,
	"printer_id" text,
	"reissue_reason" text,
	"reissue_note" text,
	"supersedes_issue_id" text,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_emar_issues_units_ck" CHECK ("ipd_emar_issues"."units" > 0 and "ipd_emar_issues"."strip_size" > 0),
	CONSTRAINT "ipd_emar_issues_reissue_ck" CHECK ("ipd_emar_issues"."reissue_reason" is null or "ipd_emar_issues"."reissue_reason" in ('lost', 'damaged', 'extra_supply')),
	CONSTRAINT "ipd_emar_issues_own_ck" CHECK (not "ipd_emar_issues"."own_medicine" or ("ipd_emar_issues"."own_batch_no" is not null and "ipd_emar_issues"."own_expiry" is not null and "ipd_emar_issues"."item_id" is null))
);
--> statement-breakpoint
CREATE TABLE "ipd_emar_label_uses" (
	"id" text PRIMARY KEY NOT NULL,
	"label_id" text NOT NULL,
	"act_id" text NOT NULL,
	"units" double precision NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_emar_label_uses_units_ck" CHECK ("ipd_emar_label_uses"."units" <> 0)
);
--> statement-breakpoint
CREATE TABLE "ipd_emar_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"order_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"code" text NOT NULL,
	"seq" integer NOT NULL,
	"units" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ipd_emar_narcotic_register" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"kind" text NOT NULL,
	"qty" double precision NOT NULL,
	"unit" text NOT NULL,
	"issue_id" text,
	"act_id" text,
	"reason" text,
	"actor_id" text NOT NULL,
	"witness_id" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_emar_narcotic_kind_ck" CHECK ("ipd_emar_narcotic_register"."kind" in ('received', 'given', 'wasted', 'returned', 'reversal')),
	CONSTRAINT "ipd_emar_narcotic_witness_ck" CHECK ("ipd_emar_narcotic_register"."kind" <> 'wasted' or ("ipd_emar_narcotic_register"."witness_id" is not null and "ipd_emar_narcotic_register"."witness_id" <> "ipd_emar_narcotic_register"."actor_id"))
);
--> statement-breakpoint
CREATE TABLE "ipd_emar_returns" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"order_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"units" integer NOT NULL,
	"credited_units" integer NOT NULL,
	"reason" text NOT NULL,
	"batches" jsonb NOT NULL,
	"returned_by" text NOT NULL,
	"returned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_emar_returns_units_ck" CHECK ("ipd_emar_returns"."units" > 0 and "ipd_emar_returns"."credited_units" >= 0 and "ipd_emar_returns"."credited_units" <= "ipd_emar_returns"."units")
);
--> statement-breakpoint
CREATE TABLE "ipd_emar_second_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"checker_id" text NOT NULL,
	"for_user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"order_id" text NOT NULL,
	"dose_id" text,
	"medicine_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "ipd_emar_second_checks_self_ck" CHECK ("ipd_emar_second_checks"."checker_id" <> "ipd_emar_second_checks"."for_user_id")
);
--> statement-breakpoint
CREATE TABLE "ipd_emar_verbal_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"recorded_by" text NOT NULL,
	"from_doctor_id" text NOT NULL,
	"read_back" boolean NOT NULL,
	"emergency" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"sign_by" timestamp with time zone NOT NULL,
	"signed_at" timestamp with time zone,
	"signed_by" text,
	"nudged_at" timestamp with time zone,
	CONSTRAINT "ipd_emar_verbal_read_back_ck" CHECK ("ipd_emar_verbal_orders"."read_back")
);
--> statement-breakpoint
CREATE TABLE "ipd_emar_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"decision" text NOT NULL,
	"checks" jsonb NOT NULL,
	"findings" jsonb NOT NULL,
	"note" text,
	"allergy_override_reason" text,
	"allergy_override_text" text,
	"verified_by" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_emar_verifications_decision_ck" CHECK ("ipd_emar_verifications"."decision" in ('verified', 'rejected', 'query'))
);
--> statement-breakpoint
ALTER TABLE "ipd_emar_acts" ADD CONSTRAINT "ipd_emar_acts_dose_id_ipd_emar_doses_id_fk" FOREIGN KEY ("dose_id") REFERENCES "public"."ipd_emar_doses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_acts" ADD CONSTRAINT "ipd_emar_acts_order_id_ipd_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."ipd_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_acts" ADD CONSTRAINT "ipd_emar_acts_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_acts" ADD CONSTRAINT "ipd_emar_acts_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_allergy_flags" ADD CONSTRAINT "ipd_emar_allergy_flags_order_id_ipd_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."ipd_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_allergy_flags" ADD CONSTRAINT "ipd_emar_allergy_flags_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_allergy_flags" ADD CONSTRAINT "ipd_emar_allergy_flags_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_doses" ADD CONSTRAINT "ipd_emar_doses_order_id_ipd_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."ipd_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_doses" ADD CONSTRAINT "ipd_emar_doses_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_doses" ADD CONSTRAINT "ipd_emar_doses_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_infusion_events" ADD CONSTRAINT "ipd_emar_infusion_events_order_id_ipd_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."ipd_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_infusion_events" ADD CONSTRAINT "ipd_emar_infusion_events_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_issues" ADD CONSTRAINT "ipd_emar_issues_order_id_ipd_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."ipd_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_issues" ADD CONSTRAINT "ipd_emar_issues_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_issues" ADD CONSTRAINT "ipd_emar_issues_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_label_uses" ADD CONSTRAINT "ipd_emar_label_uses_label_id_ipd_emar_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."ipd_emar_labels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_labels" ADD CONSTRAINT "ipd_emar_labels_issue_id_ipd_emar_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."ipd_emar_issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_labels" ADD CONSTRAINT "ipd_emar_labels_order_id_ipd_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."ipd_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_labels" ADD CONSTRAINT "ipd_emar_labels_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_narcotic_register" ADD CONSTRAINT "ipd_emar_narcotic_register_order_id_ipd_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."ipd_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_narcotic_register" ADD CONSTRAINT "ipd_emar_narcotic_register_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_returns" ADD CONSTRAINT "ipd_emar_returns_issue_id_ipd_emar_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."ipd_emar_issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_returns" ADD CONSTRAINT "ipd_emar_returns_order_id_ipd_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."ipd_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_returns" ADD CONSTRAINT "ipd_emar_returns_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_verbal_orders" ADD CONSTRAINT "ipd_emar_verbal_orders_order_id_ipd_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."ipd_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_verbal_orders" ADD CONSTRAINT "ipd_emar_verbal_orders_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_emar_verifications" ADD CONSTRAINT "ipd_emar_verifications_order_id_ipd_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."ipd_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_emar_acts_slot_ux" ON "ipd_emar_acts" USING btree ("dose_id","slot_seq") WHERE "ipd_emar_acts"."slot_seq" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_emar_acts_correction_ux" ON "ipd_emar_acts" USING btree ("corrects_act_id") WHERE "ipd_emar_acts"."corrects_act_id" is not null;--> statement-breakpoint
CREATE INDEX "ipd_emar_acts_order_idx" ON "ipd_emar_acts" USING btree ("order_id","at");--> statement-breakpoint
CREATE INDEX "ipd_emar_acts_admission_idx" ON "ipd_emar_acts" USING btree ("admission_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_emar_allergy_flags_ux" ON "ipd_emar_allergy_flags" USING btree ("order_id","allergy_id");--> statement-breakpoint
CREATE INDEX "ipd_emar_allergy_flags_open_idx" ON "ipd_emar_allergy_flags" USING btree ("admission_id") WHERE "ipd_emar_allergy_flags"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_emar_doses_slot_ux" ON "ipd_emar_doses" USING btree ("order_id","due_at");--> statement-breakpoint
CREATE INDEX "ipd_emar_doses_admission_idx" ON "ipd_emar_doses" USING btree ("admission_id","due_at");--> statement-breakpoint
CREATE INDEX "ipd_emar_doses_open_idx" ON "ipd_emar_doses" USING btree ("due_at") WHERE "ipd_emar_doses"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "ipd_emar_infusion_order_idx" ON "ipd_emar_infusion_events" USING btree ("order_id","at");--> statement-breakpoint
CREATE INDEX "ipd_emar_issues_order_idx" ON "ipd_emar_issues" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "ipd_emar_issues_admission_idx" ON "ipd_emar_issues" USING btree ("admission_id");--> statement-breakpoint
CREATE INDEX "ipd_emar_label_uses_label_idx" ON "ipd_emar_label_uses" USING btree ("label_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_emar_labels_code_ux" ON "ipd_emar_labels" USING btree ("code");--> statement-breakpoint
CREATE INDEX "ipd_emar_labels_issue_idx" ON "ipd_emar_labels" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "ipd_emar_narcotic_order_idx" ON "ipd_emar_narcotic_register" USING btree ("order_id","at");--> statement-breakpoint
CREATE INDEX "ipd_emar_returns_issue_idx" ON "ipd_emar_returns" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_emar_verbal_order_ux" ON "ipd_emar_verbal_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "ipd_emar_verifications_order_idx" ON "ipd_emar_verifications" USING btree ("order_id");--> statement-breakpoint
CREATE FUNCTION ipd_emar_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ipd_emar_append_only: % rows are append-only (% refused)', TG_TABLE_NAME, TG_OP; END $$;
--> statement-breakpoint
CREATE TRIGGER ipd_emar_verifications_append_only BEFORE UPDATE OR DELETE ON ipd_emar_verifications FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_issues_append_only BEFORE UPDATE OR DELETE ON ipd_emar_issues FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_labels_append_only BEFORE UPDATE OR DELETE ON ipd_emar_labels FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_label_uses_append_only BEFORE UPDATE OR DELETE ON ipd_emar_label_uses FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_returns_append_only BEFORE UPDATE OR DELETE ON ipd_emar_returns FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_acts_append_only BEFORE UPDATE OR DELETE ON ipd_emar_acts FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_infusion_events_append_only BEFORE UPDATE OR DELETE ON ipd_emar_infusion_events FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_narcotic_register_append_only BEFORE UPDATE OR DELETE ON ipd_emar_narcotic_register FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_verifications_no_truncate BEFORE TRUNCATE ON ipd_emar_verifications FOR EACH STATEMENT EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_issues_no_truncate BEFORE TRUNCATE ON ipd_emar_issues FOR EACH STATEMENT EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_labels_no_truncate BEFORE TRUNCATE ON ipd_emar_labels FOR EACH STATEMENT EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_label_uses_no_truncate BEFORE TRUNCATE ON ipd_emar_label_uses FOR EACH STATEMENT EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_returns_no_truncate BEFORE TRUNCATE ON ipd_emar_returns FOR EACH STATEMENT EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_acts_no_truncate BEFORE TRUNCATE ON ipd_emar_acts FOR EACH STATEMENT EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_infusion_events_no_truncate BEFORE TRUNCATE ON ipd_emar_infusion_events FOR EACH STATEMENT EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_narcotic_register_no_truncate BEFORE TRUNCATE ON ipd_emar_narcotic_register FOR EACH STATEMENT EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_verbal_orders_no_truncate BEFORE TRUNCATE ON ipd_emar_verbal_orders FOR EACH STATEMENT EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_emar_second_checks_no_truncate BEFORE TRUNCATE ON ipd_emar_second_checks FOR EACH STATEMENT EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE FUNCTION ipd_emar_verbal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ipd_emar_append_only: ipd_emar_verbal_orders rows are never deleted'; END IF;
  IF (NEW.id, NEW.order_id, NEW.admission_id, NEW.recorded_by, NEW.from_doctor_id, NEW.read_back, NEW.emergency, NEW.recorded_at, NEW.sign_by)
     IS DISTINCT FROM (OLD.id, OLD.order_id, OLD.admission_id, OLD.recorded_by, OLD.from_doctor_id, OLD.read_back, OLD.emergency, OLD.recorded_at, OLD.sign_by)
  THEN RAISE EXCEPTION 'ipd_emar_append_only: a verbal order''s record is fixed'; END IF;
  IF OLD.signed_at IS NOT NULL AND (NEW.signed_at, NEW.signed_by) IS DISTINCT FROM (OLD.signed_at, OLD.signed_by)
  THEN RAISE EXCEPTION 'ipd_emar_append_only: a verbal order is signed once'; END IF;
  IF NEW.signed_at IS NOT NULL AND NEW.signed_by IS NULL THEN RAISE EXCEPTION 'ipd_emar_append_only: a signature names its signer'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ipd_emar_verbal_orders_guard BEFORE UPDATE OR DELETE ON ipd_emar_verbal_orders FOR EACH ROW EXECUTE FUNCTION ipd_emar_verbal_guard();
--> statement-breakpoint
CREATE FUNCTION ipd_emar_second_check_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ipd_emar_append_only: ipd_emar_second_checks rows are never deleted'; END IF;
  IF (NEW.id, NEW.checker_id, NEW.for_user_id, NEW.purpose, NEW.order_id, NEW.dose_id, NEW.medicine_id, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.checker_id, OLD.for_user_id, OLD.purpose, OLD.order_id, OLD.dose_id, OLD.medicine_id, OLD.created_at, OLD.expires_at)
  THEN RAISE EXCEPTION 'ipd_emar_append_only: a second check''s record is fixed'; END IF;
  IF OLD.used_at IS NOT NULL OR NEW.used_at IS NULL THEN RAISE EXCEPTION 'ipd_emar_append_only: a second check is spent once'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ipd_emar_second_checks_guard BEFORE UPDATE OR DELETE ON ipd_emar_second_checks FOR EACH ROW EXECUTE FUNCTION ipd_emar_second_check_guard();
--> statement-breakpoint
ALTER TABLE ipd_emar_verifications ENABLE ALWAYS TRIGGER ipd_emar_verifications_append_only;
--> statement-breakpoint
ALTER TABLE ipd_emar_issues ENABLE ALWAYS TRIGGER ipd_emar_issues_append_only;
--> statement-breakpoint
ALTER TABLE ipd_emar_labels ENABLE ALWAYS TRIGGER ipd_emar_labels_append_only;
--> statement-breakpoint
ALTER TABLE ipd_emar_label_uses ENABLE ALWAYS TRIGGER ipd_emar_label_uses_append_only;
--> statement-breakpoint
ALTER TABLE ipd_emar_returns ENABLE ALWAYS TRIGGER ipd_emar_returns_append_only;
--> statement-breakpoint
ALTER TABLE ipd_emar_acts ENABLE ALWAYS TRIGGER ipd_emar_acts_append_only;
--> statement-breakpoint
ALTER TABLE ipd_emar_infusion_events ENABLE ALWAYS TRIGGER ipd_emar_infusion_events_append_only;
--> statement-breakpoint
ALTER TABLE ipd_emar_narcotic_register ENABLE ALWAYS TRIGGER ipd_emar_narcotic_register_append_only;
--> statement-breakpoint
ALTER TABLE ipd_emar_verifications ENABLE ALWAYS TRIGGER ipd_emar_verifications_no_truncate;
--> statement-breakpoint
ALTER TABLE ipd_emar_issues ENABLE ALWAYS TRIGGER ipd_emar_issues_no_truncate;
--> statement-breakpoint
ALTER TABLE ipd_emar_labels ENABLE ALWAYS TRIGGER ipd_emar_labels_no_truncate;
--> statement-breakpoint
ALTER TABLE ipd_emar_label_uses ENABLE ALWAYS TRIGGER ipd_emar_label_uses_no_truncate;
--> statement-breakpoint
ALTER TABLE ipd_emar_returns ENABLE ALWAYS TRIGGER ipd_emar_returns_no_truncate;
--> statement-breakpoint
ALTER TABLE ipd_emar_acts ENABLE ALWAYS TRIGGER ipd_emar_acts_no_truncate;
--> statement-breakpoint
ALTER TABLE ipd_emar_infusion_events ENABLE ALWAYS TRIGGER ipd_emar_infusion_events_no_truncate;
--> statement-breakpoint
ALTER TABLE ipd_emar_narcotic_register ENABLE ALWAYS TRIGGER ipd_emar_narcotic_register_no_truncate;
--> statement-breakpoint
ALTER TABLE ipd_emar_verbal_orders ENABLE ALWAYS TRIGGER ipd_emar_verbal_orders_no_truncate;
--> statement-breakpoint
ALTER TABLE ipd_emar_second_checks ENABLE ALWAYS TRIGGER ipd_emar_second_checks_no_truncate;
--> statement-breakpoint
ALTER TABLE ipd_emar_verbal_orders ENABLE ALWAYS TRIGGER ipd_emar_verbal_orders_guard;
--> statement-breakpoint
ALTER TABLE ipd_emar_second_checks ENABLE ALWAYS TRIGGER ipd_emar_second_checks_guard;
