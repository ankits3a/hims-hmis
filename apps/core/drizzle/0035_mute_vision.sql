CREATE TABLE "daycare_encounters" (
	"id" text PRIMARY KEY NOT NULL,
	"encounter_no" text NOT NULL,
	"patient_id" text NOT NULL,
	"opd_encounter_id" text,
	"payer_class" text NOT NULL,
	"scheme_ref" text,
	"status" text DEFAULT 'booked' NOT NULL,
	"bay_resource_id" text,
	"escort" jsonb,
	"escort_patient_id" text,
	"checked_in_at" timestamp with time zone,
	"discharged_at" timestamp with time zone,
	"converted_at" timestamp with time zone,
	"outcome" text,
	"handoff_document_id" text,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"re_verify_identity" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daycare_encounters_payer_class_ck" CHECK ("daycare_encounters"."payer_class" in ('self_pay', 'insured_tpa', 'govt_scheme', 'fp_scheme', 'corporate_credit', 'membership_prepaid', 'staff_dependant', 'charity')),
	CONSTRAINT "daycare_encounters_status_ck" CHECK ("daycare_encounters"."status" in ('booked', 'checked_in', 'in_theatre', 'in_recovery', 'discharged', 'converted', 'absconded', 'cancelled', 'deceased')),
	CONSTRAINT "daycare_encounters_escort_not_self_ck" CHECK ("daycare_encounters"."escort_patient_id" is distinct from "daycare_encounters"."patient_id")
);
--> statement-breakpoint
CREATE TABLE "ot_case_gates" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"kind" text NOT NULL,
	"workflow_instance_id" text NOT NULL,
	"waivable" boolean DEFAULT false NOT NULL,
	"evidence" jsonb,
	"satisfied_by" text,
	"satisfied_at" timestamp with time zone,
	"override" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ot_case_gates_kind_ck" CHECK ("ot_case_gates"."kind" in ('anaesthesia_review', 'consent_procedure', 'consent_anaesthesia', 'site_marking', 'npo', 'deposit', 'escort', 'privilege', 'mlc'))
);
--> statement-breakpoint
CREATE TABLE "ot_case_implants" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"encounter_id" text NOT NULL,
	"item_id" text,
	"batch_id" text,
	"lot_id" text,
	"serial" text,
	"sticker_ref" text,
	"service_code" text NOT NULL,
	"qty_base" integer NOT NULL,
	"source" text DEFAULT 'consignment' NOT NULL,
	"state" text DEFAULT 'deploying' NOT NULL,
	"ledger_entry_id" text,
	"event_id" text,
	"deployed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deployed_by" text NOT NULL,
	"verified_by" text,
	"explanted_at" timestamp with time zone,
	"explant_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ot_case_implants_source_ck" CHECK ("ot_case_implants"."source" in ('consignment', 'patient_supplied')),
	CONSTRAINT "ot_case_implants_state_ck" CHECK ("ot_case_implants"."state" in ('deploying', 'confirmed', 'explanted')),
	CONSTRAINT "ot_case_implants_qty_ck" CHECK ("ot_case_implants"."qty_base" > 0),
	CONSTRAINT "ot_case_implants_source_lot_ck" CHECK (("ot_case_implants"."source" = 'consignment') = ("ot_case_implants"."lot_id" is not null)),
	CONSTRAINT "ot_case_implants_explant_ck" CHECK (("ot_case_implants"."explanted_at" is null) = ("ot_case_implants"."explant_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "ot_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"encounter_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"theatre_resource_id" text NOT NULL,
	"list_date" date NOT NULL,
	"seq" integer NOT NULL,
	"procedure_code" text NOT NULL,
	"procedure_class" text NOT NULL,
	"laterality" text,
	"surgeon_id" text NOT NULL,
	"anaesthetist_id" text,
	"anaesthesia_type" text,
	"asa_grade" integer,
	"package_service_code" text NOT NULL,
	"quote_paise" bigint NOT NULL,
	"tariff_version_id" text NOT NULL,
	"payer_class" text NOT NULL,
	"workflow_instance_id" text NOT NULL,
	"wheel_in" timestamp with time zone,
	"induction" timestamp with time zone,
	"incision" timestamp with time zone,
	"closure" timestamp with time zone,
	"wheel_out" timestamp with time zone,
	"wound_class" text,
	"cancellation_reason" text,
	"cancellation_attribution" text,
	"return_of_case_id" text,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ot_cases_payer_class_ck" CHECK ("ot_cases"."payer_class" in ('self_pay', 'insured_tpa', 'govt_scheme', 'fp_scheme', 'corporate_credit', 'membership_prepaid', 'staff_dependant', 'charity')),
	CONSTRAINT "ot_cases_laterality_ck" CHECK ("ot_cases"."laterality" is null or "ot_cases"."laterality" in ('left', 'right', 'bilateral')),
	CONSTRAINT "ot_cases_anaesthesia_type_ck" CHECK ("ot_cases"."anaesthesia_type" is null or "ot_cases"."anaesthesia_type" in ('general', 'spinal', 'regional', 'local_sedation')),
	CONSTRAINT "ot_cases_cancellation_attribution_ck" CHECK ("ot_cases"."cancellation_attribution" is null or "ot_cases"."cancellation_attribution" in ('patient', 'hospital', 'surgeon', 'payer', 'clinical')),
	CONSTRAINT "ot_cases_quote_ck" CHECK ("ot_cases"."quote_paise" >= 0),
	CONSTRAINT "ot_cases_seq_ck" CHECK ("ot_cases"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "ot_checklist_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"phase" text NOT NULL,
	"items" jsonb NOT NULL,
	"participants" jsonb NOT NULL,
	"halted" boolean DEFAULT false NOT NULL,
	"halt_reason" text,
	"completed_at" timestamp with time zone,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ot_checklist_runs_phase_ck" CHECK ("ot_checklist_runs"."phase" in ('signin', 'timeout', 'signout')),
	CONSTRAINT "ot_checklist_runs_halt_ck" CHECK (("ot_checklist_runs"."halted" = false and "ot_checklist_runs"."halt_reason" is null) or ("ot_checklist_runs"."halted" = true and "ot_checklist_runs"."halt_reason" is not null and "ot_checklist_runs"."completed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "ot_counts" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"round" text NOT NULL,
	"item_type" text NOT NULL,
	"expected" integer NOT NULL,
	"counted" integer NOT NULL,
	"scrub_by" text NOT NULL,
	"circulating_by" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ot_counts_two_person_ck" CHECK ("ot_counts"."scrub_by" <> "ot_counts"."circulating_by"),
	CONSTRAINT "ot_counts_round_ck" CHECK ("ot_counts"."round" in ('initial', 'closing', 'final')),
	CONSTRAINT "ot_counts_nonneg_ck" CHECK ("ot_counts"."expected" >= 0 and "ot_counts"."counted" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ot_definitions" (
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
	CONSTRAINT "ot_definitions_kind_ck" CHECK ("ot_definitions"."kind" in ('criteria', 'privileges', 'deposit_policy', 'pacu_thresholds')),
	CONSTRAINT "ot_definitions_status_ck" CHECK ("ot_definitions"."status" in ('draft', 'active', 'superseded')),
	CONSTRAINT "ot_definitions_version_ck" CHECK ("ot_definitions"."version" > 0),
	CONSTRAINT "ot_definitions_published_ck" CHECK ("ot_definitions"."status" = 'draft' or ("ot_definitions"."published_by" is not null and "ot_definitions"."published_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "ot_deposit_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"encounter_id" text NOT NULL,
	"receipt_id" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"paid_by" jsonb,
	"held_at" timestamp with time zone DEFAULT now() NOT NULL,
	"held_by" text NOT NULL,
	"released_at" timestamp with time zone,
	"released_reason" text,
	CONSTRAINT "ot_deposit_holds_amount_ck" CHECK ("ot_deposit_holds"."amount_paise" > 0),
	CONSTRAINT "ot_deposit_holds_release_ck" CHECK (("ot_deposit_holds"."released_at" is null) = ("ot_deposit_holds"."released_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "ot_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"encounter_id" text NOT NULL,
	"case_id" text,
	"kind" text NOT NULL,
	"detail" jsonb NOT NULL,
	"reported_by" text NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	CONSTRAINT "ot_incidents_kind_ck" CHECK ("ot_incidents"."kind" in ('identity_mismatch', 'timeout_halted', 'count_mismatch', 'death_on_table', 'wrong_bay_score')),
	CONSTRAINT "ot_incidents_resolution_ck" CHECK (("ot_incidents"."resolved_at" is null) = ("ot_incidents"."resolution" is null))
);
--> statement-breakpoint
CREATE TABLE "ot_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"list_date" date NOT NULL,
	"theatre_resource_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ot_lists_status_ck" CHECK ("ot_lists"."status" in ('draft', 'published', 'superseded')),
	CONSTRAINT "ot_lists_version_ck" CHECK ("ot_lists"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "ot_specimens" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"encounter_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"specimen_no" text NOT NULL,
	"site" text NOT NULL,
	"container" text NOT NULL,
	"dispatch_destination" text,
	"dispatched_at" timestamp with time zone,
	"dispatched_by" text,
	"received_ack" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ot_specimens_dispatch_ck" CHECK (("ot_specimens"."dispatched_at" is null) = ("ot_specimens"."dispatched_by" is null))
);
--> statement-breakpoint
CREATE TABLE "pacu_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"encounter_id" text NOT NULL,
	"case_id" text NOT NULL,
	"scale" text NOT NULL,
	"values" jsonb NOT NULL,
	"total" integer NOT NULL,
	"scored_by" text NOT NULL,
	"bay_resource_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pacu_scores_total_ck" CHECK ("pacu_scores"."total" >= 0)
);
--> statement-breakpoint
ALTER TABLE "daycare_encounters" ADD CONSTRAINT "daycare_encounters_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daycare_encounters" ADD CONSTRAINT "daycare_encounters_bay_resource_id_resources_id_fk" FOREIGN KEY ("bay_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daycare_encounters" ADD CONSTRAINT "daycare_encounters_escort_patient_id_patients_id_fk" FOREIGN KEY ("escort_patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ot_case_gates" ADD CONSTRAINT "ot_case_gates_case_id_ot_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."ot_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ot_case_implants" ADD CONSTRAINT "ot_case_implants_case_id_ot_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."ot_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ot_case_implants" ADD CONSTRAINT "ot_case_implants_encounter_id_daycare_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."daycare_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ot_cases" ADD CONSTRAINT "ot_cases_encounter_id_daycare_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."daycare_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ot_cases" ADD CONSTRAINT "ot_cases_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ot_cases" ADD CONSTRAINT "ot_cases_theatre_resource_id_resources_id_fk" FOREIGN KEY ("theatre_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ot_checklist_runs" ADD CONSTRAINT "ot_checklist_runs_case_id_ot_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."ot_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ot_counts" ADD CONSTRAINT "ot_counts_case_id_ot_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."ot_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ot_deposit_holds" ADD CONSTRAINT "ot_deposit_holds_encounter_id_daycare_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."daycare_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ot_incidents" ADD CONSTRAINT "ot_incidents_encounter_id_daycare_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."daycare_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ot_incidents" ADD CONSTRAINT "ot_incidents_case_id_ot_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."ot_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ot_lists" ADD CONSTRAINT "ot_lists_theatre_resource_id_resources_id_fk" FOREIGN KEY ("theatre_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ot_specimens" ADD CONSTRAINT "ot_specimens_case_id_ot_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."ot_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ot_specimens" ADD CONSTRAINT "ot_specimens_encounter_id_daycare_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."daycare_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ot_specimens" ADD CONSTRAINT "ot_specimens_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pacu_scores" ADD CONSTRAINT "pacu_scores_encounter_id_daycare_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."daycare_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pacu_scores" ADD CONSTRAINT "pacu_scores_case_id_ot_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."ot_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pacu_scores" ADD CONSTRAINT "pacu_scores_bay_resource_id_resources_id_fk" FOREIGN KEY ("bay_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daycare_encounters_no_ux" ON "daycare_encounters" USING btree ("encounter_no");--> statement-breakpoint
CREATE INDEX "daycare_encounters_patient_idx" ON "daycare_encounters" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "daycare_encounters_status_idx" ON "daycare_encounters" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ot_case_gates_case_kind_ux" ON "ot_case_gates" USING btree ("case_id","kind");--> statement-breakpoint
CREATE INDEX "ot_case_gates_instance_idx" ON "ot_case_gates" USING btree ("workflow_instance_id");--> statement-breakpoint
CREATE INDEX "ot_case_implants_case_idx" ON "ot_case_implants" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "ot_case_implants_encounter_idx" ON "ot_case_implants" USING btree ("encounter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ot_case_implants_case_serial_ux" ON "ot_case_implants" USING btree ("case_id","serial") WHERE "ot_case_implants"."serial" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ot_case_implants_case_lot_sticker_ux" ON "ot_case_implants" USING btree ("case_id","lot_id","sticker_ref") WHERE "ot_case_implants"."sticker_ref" is not null;--> statement-breakpoint
CREATE INDEX "ot_cases_encounter_idx" ON "ot_cases" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "ot_cases_list_idx" ON "ot_cases" USING btree ("list_date","theatre_resource_id","seq");--> statement-breakpoint
CREATE INDEX "ot_cases_instance_idx" ON "ot_cases" USING btree ("workflow_instance_id");--> statement-breakpoint
CREATE INDEX "ot_checklist_runs_case_idx" ON "ot_checklist_runs" USING btree ("case_id","phase");--> statement-breakpoint
CREATE UNIQUE INDEX "ot_counts_case_round_item_ux" ON "ot_counts" USING btree ("case_id","round","item_type");--> statement-breakpoint
CREATE UNIQUE INDEX "ot_definitions_kind_version_ux" ON "ot_definitions" USING btree ("kind","version");--> statement-breakpoint
CREATE UNIQUE INDEX "ot_definitions_one_active_ux" ON "ot_definitions" USING btree ("kind") WHERE "ot_definitions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "ot_deposit_holds_encounter_idx" ON "ot_deposit_holds" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "ot_deposit_holds_receipt_idx" ON "ot_deposit_holds" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "ot_incidents_encounter_idx" ON "ot_incidents" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "ot_incidents_kind_idx" ON "ot_incidents" USING btree ("kind","reported_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ot_lists_date_theatre_version_ux" ON "ot_lists" USING btree ("list_date","theatre_resource_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "ot_specimens_no_ux" ON "ot_specimens" USING btree ("specimen_no");--> statement-breakpoint
CREATE INDEX "ot_specimens_case_idx" ON "ot_specimens" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "pacu_scores_encounter_idx" ON "pacu_scores" USING btree ("encounter_id","occurred_at");--> statement-breakpoint
CREATE FUNCTION ot_forbid_timestamp_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.wheel_in  IS NOT NULL AND NEW.wheel_in  IS DISTINCT FROM OLD.wheel_in)
  OR (OLD.induction IS NOT NULL AND NEW.induction IS DISTINCT FROM OLD.induction)
  OR (OLD.incision  IS NOT NULL AND NEW.incision  IS DISTINCT FROM OLD.incision)
  OR (OLD.closure   IS NOT NULL AND NEW.closure   IS DISTINCT FROM OLD.closure)
  OR (OLD.wheel_out IS NOT NULL AND NEW.wheel_out IS DISTINCT FROM OLD.wheel_out)
  THEN RAISE EXCEPTION 'ot_timestamp_immutable: ot_cases % — wheel_in, induction, incision, closure and wheel_out are write-once and are set by their transitions (Plan 15 DD8)', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER ot_cases_timestamps_immutable BEFORE UPDATE ON ot_cases FOR EACH ROW EXECUTE FUNCTION ot_forbid_timestamp_rewrite();
