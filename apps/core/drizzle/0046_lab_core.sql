CREATE TABLE "lab_analytes" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"loinc_code" text,
	"name_en" text NOT NULL,
	"name_hi" text,
	"result_type" text NOT NULL,
	"unit" text,
	"decimals" integer DEFAULT 1 NOT NULL,
	"formula" text,
	"formula_guard" text,
	"absurd_low" numeric(14, 4),
	"absurd_high" numeric(14, 4),
	"critical_low" numeric(14, 4),
	"critical_high" numeric(14, 4),
	"delta_abs" numeric(14, 4),
	"delta_pct" numeric(6, 2),
	"delta_window_hours" integer,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_analytes_code_unique" UNIQUE("code"),
	CONSTRAINT "lab_analytes_result_type_ck" CHECK ("lab_analytes"."result_type" in ('numeric', 'text', 'coded', 'formula')),
	CONSTRAINT "lab_analytes_formula_ck" CHECK (("lab_analytes"."result_type" = 'formula') = ("lab_analytes"."formula" is not null)),
	CONSTRAINT "lab_analytes_absurd_ck" CHECK ("lab_analytes"."absurd_low" is null or "lab_analytes"."absurd_high" is null or "lab_analytes"."absurd_low" <= "lab_analytes"."absurd_high")
);
--> statement-breakpoint
CREATE TABLE "lab_critical_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_by" text NOT NULL,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"readback_text" text,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	CONSTRAINT "lab_critical_calls_closed_ck" CHECK (("lab_critical_calls"."closed_at" is null) = ("lab_critical_calls"."readback_text" is null) and ("lab_critical_calls"."closed_at" is null) = ("lab_critical_calls"."closed_by" is null))
);
--> statement-breakpoint
CREATE TABLE "lab_items" (
	"order_item_id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"service_id" text NOT NULL,
	"invoice_id" text,
	"invoice_line_id" text,
	"charge_reason" text NOT NULL,
	"consent_recorded_at" timestamp with time zone,
	"consent_recorded_by" text,
	"reflex_consented_at" timestamp with time zone,
	"priority" text DEFAULT 'routine' NOT NULL,
	"collection_site" text DEFAULT 'opd' NOT NULL,
	"identity_recheck_by" text,
	"tat_started_at" timestamp with time zone,
	"tat_stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_items_priority_ck" CHECK ("lab_items"."priority" in ('routine', 'urgent', 'stat')),
	CONSTRAINT "lab_items_charge_reason_ck" CHECK ("lab_items"."charge_reason" in ('lab_desk', 'lab_reflex', 'lab_addon', 'lab_walkin', 'package')),
	CONSTRAINT "lab_items_collection_site_ck" CHECK ("lab_items"."collection_site" in ('opd', 'ward', 'home', 'camp', 'external')),
	CONSTRAINT "lab_items_consent_ck" CHECK (("lab_items"."consent_recorded_at" is null) = ("lab_items"."consent_recorded_by" is null)),
	CONSTRAINT "lab_items_invoice_pair_ck" CHECK ("lab_items"."invoice_line_id" is null or "lab_items"."invoice_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "lab_orderable_analytes" (
	"service_id" text NOT NULL,
	"analyte_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "lab_orderable_analytes_service_id_analyte_id_pk" PRIMARY KEY("service_id","analyte_id")
);
--> statement-breakpoint
CREATE TABLE "lab_orderables" (
	"service_id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name_en" text NOT NULL,
	"name_hi" text,
	"discipline" text NOT NULL,
	"specimen_type" text NOT NULL,
	"container" text NOT NULL,
	"min_volume_ml" numeric(6, 2),
	"bench_key" text,
	"tat_minutes_routine" integer NOT NULL,
	"tat_minutes_stat" integer,
	"requires_fasting" boolean DEFAULT false NOT NULL,
	"consent_required" boolean DEFAULT false NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"notifiable" boolean DEFAULT false NOT NULL,
	"reports_foetal_sex" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_orderables_code_unique" UNIQUE("code"),
	CONSTRAINT "lab_orderables_discipline_ck" CHECK ("lab_orderables"."discipline" in ('haematology', 'biochemistry', 'serology', 'clinical_pathology', 'microbiology', 'histopathology')),
	CONSTRAINT "lab_orderables_tat_ck" CHECK ("lab_orderables"."tat_minutes_routine" > 0),
	CONSTRAINT "lab_orderables_no_foetal_sex_ck" CHECK ("lab_orderables"."reports_foetal_sex" = false)
);
--> statement-breakpoint
CREATE TABLE "lab_reference_ranges" (
	"id" text PRIMARY KEY NOT NULL,
	"analyte_id" text NOT NULL,
	"sex" text NOT NULL,
	"age_min_days" integer NOT NULL,
	"age_max_days" integer NOT NULL,
	"low" numeric(14, 4),
	"high" numeric(14, 4),
	"text" text,
	"critical_low" numeric(14, 4),
	"critical_high" numeric(14, 4),
	"source" text NOT NULL,
	"effective_from" date NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_reference_ranges_sex_ck" CHECK ("lab_reference_ranges"."sex" in ('male', 'female', 'other', 'any')),
	CONSTRAINT "lab_reference_ranges_age_ck" CHECK ("lab_reference_ranges"."age_min_days" <= "lab_reference_ranges"."age_max_days"),
	CONSTRAINT "lab_reference_ranges_value_ck" CHECK ("lab_reference_ranges"."low" is not null or "lab_reference_ranges"."high" is not null or "lab_reference_ranges"."text" is not null)
);
--> statement-breakpoint
CREATE TABLE "lab_reflex_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"analyte_id" text NOT NULL,
	"comparator" text NOT NULL,
	"threshold" numeric(14, 4) NOT NULL,
	"adds_service_id" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_reflex_rules_comparator_ck" CHECK ("lab_reflex_rules"."comparator" in ('gt', 'gte', 'lt', 'lte'))
);
--> statement-breakpoint
CREATE TABLE "lab_report_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"channel" text NOT NULL,
	"delivered_by" text NOT NULL,
	"collector_identity" text,
	"approval_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_report_deliveries_channel_ck" CHECK ("lab_report_deliveries"."channel" in ('print', 'whatsapp', 'in_person', 'doctor_screen')),
	CONSTRAINT "lab_report_deliveries_collector_ck" CHECK ("lab_report_deliveries"."channel" not in ('print', 'in_person') or "lab_report_deliveries"."collector_identity" is not null)
);
--> statement-breakpoint
CREATE TABLE "lab_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"signed_by" text,
	"signed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"publish_channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"print_count" integer DEFAULT 0 NOT NULL,
	"amendment_reason_code" text,
	"prior_version_id" text,
	"partial" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_reports_status_ck" CHECK ("lab_reports"."status" in ('draft', 'published', 'amended', 'superseded')),
	CONSTRAINT "lab_reports_version_ck" CHECK ("lab_reports"."version" >= 1),
	CONSTRAINT "lab_reports_published_ck" CHECK (("lab_reports"."status" = 'draft') = ("lab_reports"."published_at" is null)),
	CONSTRAINT "lab_reports_signed_ck" CHECK (("lab_reports"."signed_at" is null) = ("lab_reports"."signed_by" is null)),
	CONSTRAINT "lab_reports_prior_ck" CHECK (("lab_reports"."version" = 1) = ("lab_reports"."prior_version_id" is null))
);
--> statement-breakpoint
CREATE TABLE "lab_results" (
	"id" text PRIMARY KEY NOT NULL,
	"order_item_id" text NOT NULL,
	"analyte_id" text NOT NULL,
	"specimen_id" text,
	"value_numeric" numeric(14, 4),
	"value_text" text,
	"value_coded" text,
	"unit" text,
	"flag" text,
	"ref_low" numeric(14, 4),
	"ref_high" numeric(14, 4),
	"ref_text" text,
	"ref_range_id" text,
	"ref_note" text,
	"delta_flag" boolean DEFAULT false NOT NULL,
	"delta_prev_result_id" text,
	"absurd_overridden_by" text,
	"entered_by_type" text NOT NULL,
	"entered_by_id" text NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entry_mode" text NOT NULL,
	"analyzer_id" text,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"pathologist_review_pending" boolean DEFAULT false NOT NULL,
	"rerun_of" text,
	"supersedes_result_id" text,
	"remarks" text,
	CONSTRAINT "lab_results_flag_ck" CHECK ("lab_results"."flag" is null or "lab_results"."flag" in ('L', 'H', 'LL', 'HH', 'A', 'N')),
	CONSTRAINT "lab_results_entry_mode_ck" CHECK ("lab_results"."entry_mode" in ('manual', 'manual_from_printout', 'interface')),
	CONSTRAINT "lab_results_verification_status_ck" CHECK ("lab_results"."verification_status" in ('unverified', 'verified', 'autoverified')),
	CONSTRAINT "lab_results_entered_by_type_ck" CHECK ("lab_results"."entered_by_type" in ('user', 'agent', 'system', 'patient')),
	CONSTRAINT "lab_results_one_value_ck" CHECK ((case when "lab_results"."value_numeric" is null then 0 else 1 end
         + case when "lab_results"."value_text" is null then 0 else 1 end
         + case when "lab_results"."value_coded" is null then 0 else 1 end) = 1),
	CONSTRAINT "lab_results_verified_pair_ck" CHECK (("lab_results"."verified_at" is null) = ("lab_results"."verified_by" is null)),
	CONSTRAINT "lab_results_verified_status_ck" CHECK (("lab_results"."verification_status" = 'unverified') = ("lab_results"."verified_by" is null))
);
--> statement-breakpoint
CREATE TABLE "lab_sla_breaches" (
	"id" text PRIMARY KEY NOT NULL,
	"order_item_id" text NOT NULL,
	"stage" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"breached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_specimen_items" (
	"specimen_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "lab_specimen_items_specimen_id_order_item_id_pk" PRIMARY KEY("specimen_id","order_item_id")
);
--> statement-breakpoint
CREATE TABLE "lab_specimens" (
	"id" text PRIMARY KEY NOT NULL,
	"specimen_no" text NOT NULL,
	"order_group_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"specimen_type" text NOT NULL,
	"container" text NOT NULL,
	"status" text DEFAULT 'labelled' NOT NULL,
	"label_source" text DEFAULT 'printer' NOT NULL,
	"downtime_kit_serial" text,
	"collected_by" text,
	"collected_at" timestamp with time zone,
	"wristband_scanned" boolean DEFAULT false NOT NULL,
	"collection_site" text DEFAULT 'opd' NOT NULL,
	"received_by" text,
	"received_at" timestamp with time zone,
	"rejection_reason" text,
	"attributable_to" text,
	"recollection_of_specimen_id" text,
	"stored_at" timestamp with time zone,
	"disposed_at" timestamp with time zone,
	"service_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_specimens_specimen_no_unique" UNIQUE("specimen_no"),
	CONSTRAINT "lab_specimens_status_ck" CHECK ("lab_specimens"."status" in ('labelled', 'collected', 'in_transit', 'received', 'rejected', 'stored', 'disposed')),
	CONSTRAINT "lab_specimens_label_source_ck" CHECK ("lab_specimens"."label_source" in ('printer', 'downtime_kit')),
	CONSTRAINT "lab_specimens_collection_site_ck" CHECK ("lab_specimens"."collection_site" in ('opd', 'ward', 'home', 'camp', 'external')),
	CONSTRAINT "lab_specimens_rejection_reason_ck" CHECK ("lab_specimens"."rejection_reason" is null or "lab_specimens"."rejection_reason" in ('haemolysed', 'clotted', 'insufficient', 'wrong_container', 'unlabelled', 'mislabelled', 'leaked', 'contaminated', 'delayed_transport', 'temperature_excursion')),
	CONSTRAINT "lab_specimens_attributable_ck" CHECK ("lab_specimens"."attributable_to" is null or "lab_specimens"."attributable_to" in ('collection', 'transport', 'lab', 'patient')),
	CONSTRAINT "lab_specimens_rejected_ck" CHECK (("lab_specimens"."status" = 'rejected') = ("lab_specimens"."rejection_reason" is not null)),
	CONSTRAINT "lab_specimens_downtime_ck" CHECK (("lab_specimens"."label_source" = 'downtime_kit') or ("lab_specimens"."downtime_kit_serial" is null))
);
--> statement-breakpoint
ALTER TABLE "lab_critical_calls" ADD CONSTRAINT "lab_critical_calls_result_id_lab_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."lab_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_items" ADD CONSTRAINT "lab_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_items" ADD CONSTRAINT "lab_items_service_id_lab_orderables_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."lab_orderables"("service_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_items" ADD CONSTRAINT "lab_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_items" ADD CONSTRAINT "lab_items_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_orderable_analytes" ADD CONSTRAINT "lab_orderable_analytes_service_id_lab_orderables_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."lab_orderables"("service_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_orderable_analytes" ADD CONSTRAINT "lab_orderable_analytes_analyte_id_lab_analytes_id_fk" FOREIGN KEY ("analyte_id") REFERENCES "public"."lab_analytes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_orderables" ADD CONSTRAINT "lab_orderables_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_reference_ranges" ADD CONSTRAINT "lab_reference_ranges_analyte_id_lab_analytes_id_fk" FOREIGN KEY ("analyte_id") REFERENCES "public"."lab_analytes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_reflex_rules" ADD CONSTRAINT "lab_reflex_rules_analyte_id_lab_analytes_id_fk" FOREIGN KEY ("analyte_id") REFERENCES "public"."lab_analytes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_reflex_rules" ADD CONSTRAINT "lab_reflex_rules_adds_service_id_lab_orderables_service_id_fk" FOREIGN KEY ("adds_service_id") REFERENCES "public"."lab_orderables"("service_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_report_deliveries" ADD CONSTRAINT "lab_report_deliveries_report_id_lab_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."lab_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_reports" ADD CONSTRAINT "lab_reports_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_analyte_id_lab_analytes_id_fk" FOREIGN KEY ("analyte_id") REFERENCES "public"."lab_analytes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_specimen_id_lab_specimens_id_fk" FOREIGN KEY ("specimen_id") REFERENCES "public"."lab_specimens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_ref_range_id_lab_reference_ranges_id_fk" FOREIGN KEY ("ref_range_id") REFERENCES "public"."lab_reference_ranges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_sla_breaches" ADD CONSTRAINT "lab_sla_breaches_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_specimen_items" ADD CONSTRAINT "lab_specimen_items_specimen_id_lab_specimens_id_fk" FOREIGN KEY ("specimen_id") REFERENCES "public"."lab_specimens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_specimen_items" ADD CONSTRAINT "lab_specimen_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_specimens" ADD CONSTRAINT "lab_specimens_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_critical_calls_open_idx" ON "lab_critical_calls" USING btree ("opened_at") WHERE closed_at is null;--> statement-breakpoint
CREATE INDEX "lab_critical_calls_result_idx" ON "lab_critical_calls" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "lab_items_instance_idx" ON "lab_items" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "lab_items_service_idx" ON "lab_items" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "lab_items_invoice_idx" ON "lab_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "lab_orderable_analytes_analyte_idx" ON "lab_orderable_analytes" USING btree ("analyte_id");--> statement-breakpoint
CREATE INDEX "lab_orderables_bench_idx" ON "lab_orderables" USING btree ("bench_key");--> statement-breakpoint
CREATE INDEX "lab_orderables_active_idx" ON "lab_orderables" USING btree ("active");--> statement-breakpoint
CREATE INDEX "lab_reference_ranges_analyte_idx" ON "lab_reference_ranges" USING btree ("analyte_id","sex","age_min_days");--> statement-breakpoint
CREATE INDEX "lab_reflex_rules_analyte_idx" ON "lab_reflex_rules" USING btree ("analyte_id","active");--> statement-breakpoint
CREATE INDEX "lab_report_deliveries_report_idx" ON "lab_report_deliveries" USING btree ("report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_reports_order_version_ux" ON "lab_reports" USING btree ("order_id","version");--> statement-breakpoint
CREATE INDEX "lab_reports_status_idx" ON "lab_reports" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "lab_results_item_analyte_idx" ON "lab_results" USING btree ("order_item_id","analyte_id");--> statement-breakpoint
CREATE INDEX "lab_results_specimen_idx" ON "lab_results" USING btree ("specimen_id");--> statement-breakpoint
CREATE INDEX "lab_results_unverified_idx" ON "lab_results" USING btree ("verification_status","entered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_sla_breaches_item_stage_ux" ON "lab_sla_breaches" USING btree ("order_item_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_specimen_items_active_ux" ON "lab_specimen_items" USING btree ("order_item_id") WHERE active;--> statement-breakpoint
CREATE INDEX "lab_specimens_patient_idx" ON "lab_specimens" USING btree ("patient_id","collected_at");--> statement-breakpoint
CREATE INDEX "lab_specimens_status_date_idx" ON "lab_specimens" USING btree ("status","service_date");--> statement-breakpoint
CREATE INDEX "lab_specimens_group_idx" ON "lab_specimens" USING btree ("order_group_id");--> statement-breakpoint

-- ═══ PLAN 17 T1 — THE TWO IMMUTABILITY TRIGGERS, HAND-CARRIED (drizzle-kit emits no triggers) ═══
--
-- The `0043` shape (`patient_identity_forbid_mutation`), which is itself the `0012` billing shape:
-- a guarantee enforced in application code is one forgotten code path away from being false, and
-- both of these guarantees are what a NABL auditor and a court read a report against.
--
-- ═══ 1. A VERIFIED RESULT'S CLINICAL CONTENT IS FROZEN ═══
--
-- Not "a verified row may not be updated": the `unverified → verified` move IS an update, and it is
-- the one this table exists to allow (the WHEN clause fires on the OLD row's status, so that move
-- passes). What is frozen is everything a pathologist signed — the value, the unit, the flag, the
-- snapshotted range, the delta, the entry provenance.
--
-- `pathologist_review_pending` is the ONE exception and it is deliberate (DD11): a night-mode
-- release lands in the morning queue and the pathologist's review has to be able to close it. It
-- carries no clinical content — it is a queue flag — and excluding it by NAME from the comparison
-- is what stops "the reviewer needs one column" becoming "the trigger was dropped".
--
-- A correction after verification is a NEW row with `supersedes_result_id` and a new report
-- version (DD13, 02 H8). There is no edit endpoint and this trigger is why there cannot be one.
CREATE OR REPLACE FUNCTION lab_results_forbid_verified_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lab_result_immutable: a verified result may not be deleted (id %)', OLD.id;
  END IF;
  IF (to_jsonb(NEW) - 'pathologist_review_pending')
     IS DISTINCT FROM (to_jsonb(OLD) - 'pathologist_review_pending') THEN
    RAISE EXCEPTION 'lab_result_immutable: result % is % — correct it with a superseding row, never an edit', OLD.id, OLD.verification_status;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER lab_results_immutable
  BEFORE UPDATE OR DELETE ON lab_results
  FOR EACH ROW
  WHEN (OLD.verification_status <> 'unverified')
  EXECUTE FUNCTION lab_results_forbid_verified_mutation();--> statement-breakpoint

-- ═══ 2. A PUBLISHED REPORT'S SNAPSHOT IS FROZEN ═══
--
-- Two columns may still move on a published report and neither is part of the document: `print_count`
-- (the release register counts hand-overs) and `status` (an amendment marks the old version
-- `superseded`, which is the whole point of versioning). Everything else — the snapshot itself, the
-- signatory, the instants, the version, the order — is the signed artefact.
--
-- An amendment is version n+1 with `prior_version_id` (DD13, T7 A6). A report that could be edited
-- in place would make "which report did the patient receive" unanswerable.
CREATE OR REPLACE FUNCTION lab_reports_forbid_published_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lab_report_immutable: a published report may not be deleted (id %)', OLD.id;
  END IF;
  IF (to_jsonb(NEW) - 'print_count' - 'status')
     IS DISTINCT FROM (to_jsonb(OLD) - 'print_count' - 'status') THEN
    RAISE EXCEPTION 'lab_report_immutable: report % version % is published — amend it as a new version, never an edit', OLD.id, OLD.version;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER lab_reports_immutable
  BEFORE UPDATE OR DELETE ON lab_reports
  FOR EACH ROW
  WHEN (OLD.status <> 'draft')
  EXECUTE FUNCTION lab_reports_forbid_published_mutation();
