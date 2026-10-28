CREATE TABLE "ipd_care_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"done_at" timestamp with time zone NOT NULL,
	"done_by" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "ipd_care_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"kind" text NOT NULL,
	"score" integer NOT NULL,
	"interval_minutes" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"started_by" text NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	CONSTRAINT "ipd_care_plans_kind_ck" CHECK ("ipd_care_plans"."kind" in ('fall', 'pressure'))
);
--> statement-breakpoint
CREATE TABLE "ipd_crash_cart_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"cart_id" text NOT NULL,
	"kind" text NOT NULL,
	"seal_no" text,
	"previous_seal_no" text,
	"recount" jsonb,
	"shift_date" date NOT NULL,
	"shift" text NOT NULL,
	"by_user" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"note" text,
	CONSTRAINT "ipd_crash_cart_checks_kind_ck" CHECK ("ipd_crash_cart_checks"."kind" in ('check', 'used'))
);
--> statement-breakpoint
CREATE TABLE "ipd_crash_carts" (
	"id" text PRIMARY KEY NOT NULL,
	"ward_id" text NOT NULL,
	"code" text NOT NULL,
	"contents" jsonb NOT NULL,
	"seal_no" text NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_check_at" timestamp with time zone,
	CONSTRAINT "ipd_crash_carts_status_ck" CHECK ("ipd_crash_carts"."status" in ('ready', 'needs_restock'))
);
--> statement-breakpoint
CREATE TABLE "ipd_line_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"line_id" text NOT NULL,
	"review_date" date NOT NULL,
	"decision" text NOT NULL,
	"reviewed_by" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"note" text,
	CONSTRAINT "ipd_line_reviews_decision_ck" CHECK ("ipd_line_reviews"."decision" in ('keep', 'remove'))
);
--> statement-breakpoint
CREATE TABLE "ipd_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"ward_id" text,
	"kind" text NOT NULL,
	"site" text NOT NULL,
	"inserted_at" timestamp with time zone NOT NULL,
	"inserted_by" text NOT NULL,
	"due_removal_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" text,
	"removed_reason" text,
	CONSTRAINT "ipd_lines_kind_ck" CHECK ("ipd_lines"."kind" in ('urinary_catheter', 'central_line', 'cannula')),
	CONSTRAINT "ipd_lines_removed_ck" CHECK ("ipd_lines"."removed_at" is null or "ipd_lines"."removed_at" >= "ipd_lines"."inserted_at")
);
--> statement-breakpoint
CREATE TABLE "ipd_narcotic_key_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"ward_id" text NOT NULL,
	"user_id" text NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ipd_nurse_registrations" (
	"user_id" text PRIMARY KEY NOT NULL,
	"council" text NOT NULL,
	"registration_no" text NOT NULL,
	"valid_until" date NOT NULL,
	"verified_by" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"revoked_by" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "ipd_nurse_registrations_revoked_ck" CHECK (("ipd_nurse_registrations"."revoked_at" is null) = ("ipd_nurse_registrations"."revoked_by" is null))
);
--> statement-breakpoint
CREATE TABLE "ipd_restraint_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"restraint_id" text NOT NULL,
	"kind" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"notified" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ipd_restraint_alerts_kind_ck" CHECK ("ipd_restraint_alerts"."kind" in ('check_missed', 'lapsed'))
);
--> statement-breakpoint
CREATE TABLE "ipd_restraint_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"restraint_id" text NOT NULL,
	"done_at" timestamp with time zone NOT NULL,
	"done_by" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"circulation" boolean NOT NULL,
	"skin" boolean NOT NULL,
	"hydration" boolean NOT NULL,
	"toileting" boolean NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "ipd_restraints" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"ward_id" text,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"psychiatric" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"ordered_by" text NOT NULL,
	"ordered_at" timestamp with time zone NOT NULL,
	"review_due_at" timestamp with time zone NOT NULL,
	"last_reviewed_by" text,
	"last_reviewed_at" timestamp with time zone,
	"started_by" text,
	"started_at" timestamp with time zone,
	"ended_by" text,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	"lapsed_at" timestamp with time zone,
	"family_told_name" text,
	"family_told_relation" text,
	"family_told_at" timestamp with time zone,
	"family_told_by" text,
	"nominated_representative" boolean DEFAULT false NOT NULL,
	CONSTRAINT "ipd_restraints_kind_ck" CHECK ("ipd_restraints"."kind" in ('physical', 'chemical', 'seclusion')),
	CONSTRAINT "ipd_restraints_status_ck" CHECK ("ipd_restraints"."status" in ('ordered', 'active', 'ended', 'lapsed')),
	CONSTRAINT "ipd_restraints_active_ck" CHECK ("ipd_restraints"."status" <> 'active' or "ipd_restraints"."started_at" is not null),
	CONSTRAINT "ipd_restraints_ordered_ck" CHECK ("ipd_restraints"."status" <> 'ordered' or "ipd_restraints"."started_at" is null)
);
--> statement-breakpoint
CREATE TABLE "ipd_risk_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"morse" integer NOT NULL,
	"braden" integer NOT NULL,
	"scored_at" timestamp with time zone NOT NULL,
	"scored_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ipd_safety_events" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"ward_id" text,
	"kind" text NOT NULL,
	"present_on_admission" boolean DEFAULT false NOT NULL,
	"line_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"note" text,
	CONSTRAINT "ipd_safety_events_kind_ck" CHECK ("ipd_safety_events"."kind" in ('fall', 'pressure_injury', 'medication_error', 'line_infection')),
	CONSTRAINT "ipd_safety_events_line_ck" CHECK (("ipd_safety_events"."kind" = 'line_infection') = ("ipd_safety_events"."line_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "ipd_ward_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"ward_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"text" text NOT NULL,
	"raised_by" text NOT NULL,
	"raised_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ipd_ward_stock_par" (
	"id" text PRIMARY KEY NOT NULL,
	"ward_id" text NOT NULL,
	"item_id" text NOT NULL,
	"par" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_ward_stock_par_ck" CHECK ("ipd_ward_stock_par"."par" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ipd_ward_stock_uses" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"ward_id" text NOT NULL,
	"item_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"qty" integer NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"staff_error" boolean DEFAULT false NOT NULL,
	"in_package" boolean DEFAULT false NOT NULL,
	"waived_by" text,
	"waived_reason" text,
	"charged" boolean NOT NULL,
	"not_charged_why" text,
	"recorded_by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_ward_stock_uses_outcome_ck" CHECK ("ipd_ward_stock_uses"."outcome" in ('used', 'issued', 'wasted', 'refused')),
	CONSTRAINT "ipd_ward_stock_uses_qty_ck" CHECK ("ipd_ward_stock_uses"."qty" > 0),
	CONSTRAINT "ipd_ward_stock_uses_waste_ck" CHECK ("ipd_ward_stock_uses"."outcome" <> 'wasted' or "ipd_ward_stock_uses"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "ipd_ward_stores" (
	"ward_id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"supply_store_id" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ipd_care_checks" ADD CONSTRAINT "ipd_care_checks_plan_id_ipd_care_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."ipd_care_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_care_checks" ADD CONSTRAINT "ipd_care_checks_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_care_plans" ADD CONSTRAINT "ipd_care_plans_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_care_plans" ADD CONSTRAINT "ipd_care_plans_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_crash_cart_checks" ADD CONSTRAINT "ipd_crash_cart_checks_cart_id_ipd_crash_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."ipd_crash_carts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_crash_carts" ADD CONSTRAINT "ipd_crash_carts_ward_id_resources_id_fk" FOREIGN KEY ("ward_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_line_reviews" ADD CONSTRAINT "ipd_line_reviews_line_id_ipd_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."ipd_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_lines" ADD CONSTRAINT "ipd_lines_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_lines" ADD CONSTRAINT "ipd_lines_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_lines" ADD CONSTRAINT "ipd_lines_ward_id_resources_id_fk" FOREIGN KEY ("ward_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_narcotic_key_holds" ADD CONSTRAINT "ipd_narcotic_key_holds_ward_id_resources_id_fk" FOREIGN KEY ("ward_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_restraint_alerts" ADD CONSTRAINT "ipd_restraint_alerts_restraint_id_ipd_restraints_id_fk" FOREIGN KEY ("restraint_id") REFERENCES "public"."ipd_restraints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_restraint_checks" ADD CONSTRAINT "ipd_restraint_checks_restraint_id_ipd_restraints_id_fk" FOREIGN KEY ("restraint_id") REFERENCES "public"."ipd_restraints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_restraints" ADD CONSTRAINT "ipd_restraints_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_restraints" ADD CONSTRAINT "ipd_restraints_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_restraints" ADD CONSTRAINT "ipd_restraints_ward_id_resources_id_fk" FOREIGN KEY ("ward_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_risk_scores" ADD CONSTRAINT "ipd_risk_scores_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_risk_scores" ADD CONSTRAINT "ipd_risk_scores_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_safety_events" ADD CONSTRAINT "ipd_safety_events_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_safety_events" ADD CONSTRAINT "ipd_safety_events_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_safety_events" ADD CONSTRAINT "ipd_safety_events_ward_id_resources_id_fk" FOREIGN KEY ("ward_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_safety_events" ADD CONSTRAINT "ipd_safety_events_line_id_ipd_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."ipd_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_ward_incidents" ADD CONSTRAINT "ipd_ward_incidents_ward_id_resources_id_fk" FOREIGN KEY ("ward_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_ward_stock_par" ADD CONSTRAINT "ipd_ward_stock_par_ward_id_resources_id_fk" FOREIGN KEY ("ward_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_ward_stock_uses" ADD CONSTRAINT "ipd_ward_stock_uses_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_ward_stock_uses" ADD CONSTRAINT "ipd_ward_stock_uses_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_ward_stock_uses" ADD CONSTRAINT "ipd_ward_stock_uses_ward_id_resources_id_fk" FOREIGN KEY ("ward_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_ward_stores" ADD CONSTRAINT "ipd_ward_stores_ward_id_resources_id_fk" FOREIGN KEY ("ward_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_ward_stores" ADD CONSTRAINT "ipd_ward_stores_store_id_resources_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_ward_stores" ADD CONSTRAINT "ipd_ward_stores_supply_store_id_resources_id_fk" FOREIGN KEY ("supply_store_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ipd_care_checks_plan_idx" ON "ipd_care_checks" USING btree ("plan_id","done_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_care_plans_live_ux" ON "ipd_care_plans" USING btree ("admission_id","kind") WHERE "ipd_care_plans"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "ipd_crash_cart_checks_cart_idx" ON "ipd_crash_cart_checks" USING btree ("cart_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_crash_carts_code_ux" ON "ipd_crash_carts" USING btree ("ward_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_line_reviews_ux" ON "ipd_line_reviews" USING btree ("line_id","review_date");--> statement-breakpoint
CREATE INDEX "ipd_lines_admission_idx" ON "ipd_lines" USING btree ("admission_id");--> statement-breakpoint
CREATE INDEX "ipd_lines_ward_idx" ON "ipd_lines" USING btree ("ward_id","inserted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_narcotic_key_holds_live_ux" ON "ipd_narcotic_key_holds" USING btree ("ward_id") WHERE "ipd_narcotic_key_holds"."released_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_restraint_alerts_ux" ON "ipd_restraint_alerts" USING btree ("restraint_id","kind","due_at");--> statement-breakpoint
CREATE INDEX "ipd_restraint_checks_restraint_idx" ON "ipd_restraint_checks" USING btree ("restraint_id","done_at");--> statement-breakpoint
CREATE INDEX "ipd_restraints_admission_idx" ON "ipd_restraints" USING btree ("admission_id");--> statement-breakpoint
CREATE INDEX "ipd_restraints_ordered_idx" ON "ipd_restraints" USING btree ("ordered_at");--> statement-breakpoint
CREATE INDEX "ipd_risk_scores_admission_idx" ON "ipd_risk_scores" USING btree ("admission_id","scored_at");--> statement-breakpoint
CREATE INDEX "ipd_safety_events_ward_idx" ON "ipd_safety_events" USING btree ("ward_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ipd_ward_incidents_ward_idx" ON "ipd_ward_incidents" USING btree ("ward_id","raised_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_ward_stock_par_ux" ON "ipd_ward_stock_par" USING btree ("ward_id","item_id");--> statement-breakpoint
CREATE INDEX "ipd_ward_stock_uses_admission_idx" ON "ipd_ward_stock_uses" USING btree ("admission_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION ipd_ward_safety_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ipd_ward_safety_append_only: % rows are append-only (% refused)', TG_TABLE_NAME, TG_OP; END $$;--> statement-breakpoint
CREATE TRIGGER ipd_risk_scores_append_only BEFORE UPDATE OR DELETE ON ipd_risk_scores FOR EACH ROW EXECUTE FUNCTION ipd_ward_safety_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER ipd_care_checks_append_only BEFORE UPDATE OR DELETE ON ipd_care_checks FOR EACH ROW EXECUTE FUNCTION ipd_ward_safety_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER ipd_restraint_checks_append_only BEFORE UPDATE OR DELETE ON ipd_restraint_checks FOR EACH ROW EXECUTE FUNCTION ipd_ward_safety_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER ipd_safety_events_append_only BEFORE UPDATE OR DELETE ON ipd_safety_events FOR EACH ROW EXECUTE FUNCTION ipd_ward_safety_forbid_mutation();
