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
	"corrects_act_id" text,
	"incident_id" text,
	"ward_id" text,
	CONSTRAINT "ipd_emar_acts_kind_ck" CHECK ("ipd_emar_acts"."kind" in ('given', 'held', 'missed', 'refused', 'reoffered', 'cancelled', 'entered_in_error', 'medication_incident')),
	CONSTRAINT "ipd_emar_acts_given_ck" CHECK ("ipd_emar_acts"."kind" <> 'given' or ("ipd_emar_acts"."patient_check" in ('scan', 'override') and "ipd_emar_acts"."label_id" is not null)),
	CONSTRAINT "ipd_emar_acts_override_ck" CHECK (coalesce("ipd_emar_acts"."patient_check", '') <> 'override' or ("ipd_emar_acts"."override_reason" is not null and "ipd_emar_acts"."note" is not null)),
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
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" text
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
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_emar_issues_units_ck" CHECK ("ipd_emar_issues"."units" > 0 and "ipd_emar_issues"."strip_size" > 0),
	CONSTRAINT "ipd_emar_issues_own_ck" CHECK (not "ipd_emar_issues"."own_medicine" or ("ipd_emar_issues"."own_batch_no" is not null and "ipd_emar_issues"."own_expiry" is not null and "ipd_emar_issues"."item_id" is null))
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
	CONSTRAINT "ipd_emar_narcotic_kind_ck" CHECK ("ipd_emar_narcotic_register"."kind" in ('received', 'given', 'wasted', 'returned')),
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
CREATE UNIQUE INDEX "ipd_emar_labels_code_ux" ON "ipd_emar_labels" USING btree ("code");--> statement-breakpoint
CREATE INDEX "ipd_emar_labels_issue_idx" ON "ipd_emar_labels" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "ipd_emar_narcotic_order_idx" ON "ipd_emar_narcotic_register" USING btree ("order_id","at");--> statement-breakpoint
CREATE INDEX "ipd_emar_returns_issue_idx" ON "ipd_emar_returns" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_emar_verbal_order_ux" ON "ipd_emar_verbal_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "ipd_emar_verifications_order_idx" ON "ipd_emar_verifications" USING btree ("order_id");--> statement-breakpoint
CREATE FUNCTION ipd_emar_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ipd_emar_append_only: % rows are append-only (% refused)', TG_TABLE_NAME, TG_OP; END $$;--> statement-breakpoint
CREATE TRIGGER ipd_emar_verifications_append_only BEFORE UPDATE OR DELETE ON ipd_emar_verifications FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER ipd_emar_issues_append_only BEFORE UPDATE OR DELETE ON ipd_emar_issues FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER ipd_emar_labels_append_only BEFORE UPDATE OR DELETE ON ipd_emar_labels FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER ipd_emar_returns_append_only BEFORE UPDATE OR DELETE ON ipd_emar_returns FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER ipd_emar_acts_append_only BEFORE UPDATE OR DELETE ON ipd_emar_acts FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER ipd_emar_infusion_events_append_only BEFORE UPDATE OR DELETE ON ipd_emar_infusion_events FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER ipd_emar_narcotic_register_append_only BEFORE UPDATE OR DELETE ON ipd_emar_narcotic_register FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();
