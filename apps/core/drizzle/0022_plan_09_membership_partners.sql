-- PLAN 09 T1 — memberships, coupons and the accrual ledger: seventeen tables, two modules.
--
-- ═══ WHY THE COMPOSITE FK BELOW SHIPS WITH THE DEFAULT `ON UPDATE NO ACTION` ═══
--
-- `commission_accruals_counterparty_class_fk` is
--   (counterparty_id, payee_class) REFERENCES counterparties (id, payee_class)
-- and together with `commission_accruals_payable_class_ck` it is what makes C-1 structural: money
-- can never be owed to an `external_rmp`, by construction rather than by convention.
--
-- IT MUST NOT BE `ON UPDATE CASCADE`, and this is a MEASUREMENT rather than a preference (plan
-- §3 Q1, spiked 2026-08-25). Against a parallel table pair carrying CASCADE, changing a
-- counterparty's class to `external_rmp` while a payable child pointed at it was still refused —
-- BUT ONLY BECAUSE THE CHILD'S CHECK RE-FIRED ON THE CASCADED WRITE. The foreign key itself was
-- satisfied: it had dutifully rewritten the child's `payee_class` to match the new parent value.
-- So a LATER ledger table that carries this composite FK WITHOUT that CHECK would be silently
-- relabelled `external_rmp` by a cascade, and its rows would become payouts to a class that may
-- never be paid, with no error anywhere.
--
-- Under the default `NO ACTION` the refusal comes from the FK itself, in both directions:
--   update or delete on table "counterparties" violates foreign key constraint
--   … Key (id, payee_class)=(…, channel_partner) is still referenced from table "commission_accruals"
-- which is also why this migration adds NO trigger to `counterparties` (Assertion Book row A3 is
-- struck) and why a counterparty's class is FROZEN while any accrual row exists — receivable rows
-- included. O-7's `terminated` path is therefore `counterparties.status`, a different column, and
-- nothing in this phase may implement a status change as a class change.

CREATE TABLE "attribution_ids" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"counterparty_id" text NOT NULL,
	"patient_id" text,
	"service_hint" text,
	"state" text DEFAULT 'issued' NOT NULL,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_accrual_subjects" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"direction" text NOT NULL,
	"counterparty_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_accrual_subjects_direction_ck" CHECK ("commission_accrual_subjects"."direction" in ('payable', 'receivable'))
);
--> statement-breakpoint
CREATE TABLE "commission_accruals" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_id" text,
	"counterparty_id" text NOT NULL,
	"payee_class" text NOT NULL,
	"agreement_id" text NOT NULL,
	"direction" text NOT NULL,
	"invoice_id" text,
	"instrument_id" text,
	"kind" text NOT NULL,
	"state" text DEFAULT 'accrued' NOT NULL,
	"amount_paise" bigint NOT NULL,
	"rate_snapshot" jsonb NOT NULL,
	"basis_event_id" text,
	"basis_event_name" text,
	"period_key" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigserial NOT NULL,
	CONSTRAINT "commission_accruals_payable_class_ck" CHECK ("commission_accruals"."direction" <> 'payable' or "commission_accruals"."payee_class" in ('channel_partner', 'staff_internal')),
	CONSTRAINT "commission_accruals_direction_ck" CHECK ("commission_accruals"."direction" in ('payable', 'receivable'))
);
--> statement-breakpoint
CREATE TABLE "counterparties" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"payee_class" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"gstin" text,
	"contact" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counterparties_payee_class_ck" CHECK ("counterparties"."payee_class" in ('channel_partner', 'staff_internal', 'external_rmp')),
	CONSTRAINT "counterparties_status_ck" CHECK ("counterparties"."status" in ('active', 'suspended', 'terminated'))
);
--> statement-breakpoint
CREATE TABLE "partner_agreements" (
	"id" text PRIMARY KEY NOT NULL,
	"counterparty_id" text NOT NULL,
	"version_no" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"terms" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approval_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_ref_map" (
	"id" text PRIMARY KEY NOT NULL,
	"counterparty_id" text NOT NULL,
	"partner_ref" text NOT NULL,
	"attribution_id" text NOT NULL,
	"mapped_by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receivable_expectations" (
	"id" text PRIMARY KEY NOT NULL,
	"counterparty_id" text NOT NULL,
	"attribution_id" text,
	"agreement_id" text,
	"amount_paise" bigint NOT NULL,
	"state" text DEFAULT 'expected' NOT NULL,
	"statement_ref" text,
	"statement_period" text,
	"statement_line_no" integer,
	"dispute_reason" text,
	"expected_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"matched_at" timestamp with time zone,
	"written_off_at" timestamp with time zone,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigserial NOT NULL,
	CONSTRAINT "receivable_expectations_state_ck" CHECK ("receivable_expectations"."state" in ('expected', 'matched', 'disputed', 'written_off'))
);
--> statement-breakpoint
CREATE TABLE "coupon_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"counterparty_id" text,
	"plan_id" text,
	"benefit" jsonb NOT NULL,
	"scope" jsonb NOT NULL,
	"min_bill_paise" bigint DEFAULT 0 NOT NULL,
	"cap_paise" bigint,
	"single_use" boolean DEFAULT true NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone NOT NULL,
	"weekday_mask" integer DEFAULT 127 NOT NULL,
	"window_start_minute" integer,
	"window_end_minute" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"id" text PRIMARY KEY NOT NULL,
	"coupon_id" text NOT NULL,
	"cycle_no" integer DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"single_use" boolean NOT NULL,
	"patient_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"instance_id" text,
	"amount_paise" bigint DEFAULT 0 NOT NULL,
	"released_of_id" text,
	"reason" text,
	"actor_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
CREATE TABLE "covered_members" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"member_no" integer NOT NULL,
	"name" text NOT NULL,
	"relation" text,
	"phone" text,
	"patient_id" text,
	"honoured" boolean DEFAULT true NOT NULL,
	"source_row_no" integer,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlement_counters" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"benefit_key" text NOT NULL,
	"granted_qty" integer NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlement_movements" (
	"id" text PRIMARY KEY NOT NULL,
	"counter_id" text NOT NULL,
	"delta" integer NOT NULL,
	"kind" text NOT NULL,
	"invoice_id" text,
	"invoice_line_id" text,
	"reversal_of_id" text,
	"lapsed_restore" boolean DEFAULT false NOT NULL,
	"reason" text,
	"actor_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holder_book_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"counterparty_id" text NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"column_map_version" text NOT NULL,
	"rows_total" integer DEFAULT 0 NOT NULL,
	"rows_accepted" integer DEFAULT 0 NOT NULL,
	"rows_quarantined" integer DEFAULT 0 NOT NULL,
	"imported_by" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_quarantine" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"batch_id" text NOT NULL,
	"row_no" integer NOT NULL,
	"reason" text NOT NULL,
	"raw" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"counterparty_id" text,
	"card_code" text NOT NULL,
	"patient_id" text,
	"holder_name" text NOT NULL,
	"holder_phone" text,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"origin" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"partner_sale_ref" text,
	"import_id" text,
	"import_row_no" integer,
	"cap_overflow" jsonb,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"counterparty_id" text,
	"benefits" jsonb NOT NULL,
	"entitlements" jsonb NOT NULL,
	"family_cap" integer DEFAULT 1 NOT NULL,
	"validity_days" integer NOT NULL,
	"queue_perk" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_match_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"member_id" text,
	"reason" text NOT NULL,
	"candidates" jsonb NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"resolved_patient_id" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
-- ═══ THIS INDEX IS HOISTED ABOVE THE FOREIGN KEYS, AND THE ORDER IS LOAD-BEARING ═══
--
-- `drizzle-kit` emits every CREATE TABLE, then every foreign key, then every index. That order is
-- fine for ordinary single-column keys, which reference a PRIMARY KEY that already exists — but
-- `commission_accruals_counterparty_class_fk` references the PAIR `(id, payee_class)`, and
-- Postgres will not create a foreign key until a unique constraint or unique index on exactly
-- those columns exists. Left in generated order this migration fails outright with
-- `there is no unique constraint matching given keys for referenced table "counterparties"`,
-- MEASURED here on 2026-08-25 before this line was moved. The statement is unchanged; only its
-- position is. It is redundant against the primary key by design (DD4) and exists solely so a
-- child row can point at the pair.
CREATE UNIQUE INDEX "counterparties_id_payee_class_ux" ON "counterparties" USING btree ("id","payee_class");--> statement-breakpoint
ALTER TABLE "attribution_ids" ADD CONSTRAINT "attribution_ids_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_ids" ADD CONSTRAINT "attribution_ids_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_accrual_subjects" ADD CONSTRAINT "commission_accrual_subjects_agreement_id_partner_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."partner_agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_accrual_subjects" ADD CONSTRAINT "commission_accrual_subjects_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_accrual_subjects" ADD CONSTRAINT "commission_accrual_subjects_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_subject_id_commission_accrual_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."commission_accrual_subjects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_agreement_id_partner_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."partner_agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_counterparty_class_fk" FOREIGN KEY ("counterparty_id","payee_class") REFERENCES "public"."counterparties"("id","payee_class") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_agreements" ADD CONSTRAINT "partner_agreements_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_ref_map" ADD CONSTRAINT "partner_ref_map_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_ref_map" ADD CONSTRAINT "partner_ref_map_attribution_id_attribution_ids_id_fk" FOREIGN KEY ("attribution_id") REFERENCES "public"."attribution_ids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivable_expectations" ADD CONSTRAINT "receivable_expectations_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivable_expectations" ADD CONSTRAINT "receivable_expectations_attribution_id_attribution_ids_id_fk" FOREIGN KEY ("attribution_id") REFERENCES "public"."attribution_ids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivable_expectations" ADD CONSTRAINT "receivable_expectations_agreement_id_partner_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."partner_agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_definitions" ADD CONSTRAINT "coupon_definitions_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_definitions" ADD CONSTRAINT "coupon_definitions_plan_id_membership_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."membership_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_coupon_definitions_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupon_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_instance_id_membership_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."membership_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "covered_members" ADD CONSTRAINT "covered_members_instance_id_membership_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."membership_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "covered_members" ADD CONSTRAINT "covered_members_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_counters" ADD CONSTRAINT "entitlement_counters_instance_id_membership_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."membership_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_movements" ADD CONSTRAINT "entitlement_movements_counter_id_entitlement_counters_id_fk" FOREIGN KEY ("counter_id") REFERENCES "public"."entitlement_counters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_movements" ADD CONSTRAINT "entitlement_movements_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_movements" ADD CONSTRAINT "entitlement_movements_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holder_book_imports" ADD CONSTRAINT "holder_book_imports_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_instances" ADD CONSTRAINT "membership_instances_plan_id_membership_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."membership_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_instances" ADD CONSTRAINT "membership_instances_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_instances" ADD CONSTRAINT "membership_instances_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_instances" ADD CONSTRAINT "membership_instances_import_id_holder_book_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."holder_book_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_plans" ADD CONSTRAINT "membership_plans_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_match_queue" ADD CONSTRAINT "patient_match_queue_instance_id_membership_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."membership_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_match_queue" ADD CONSTRAINT "patient_match_queue_member_id_covered_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."covered_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_match_queue" ADD CONSTRAINT "patient_match_queue_resolved_patient_id_patients_id_fk" FOREIGN KEY ("resolved_patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribution_ids_code_ux" ON "attribution_ids" USING btree ("code");--> statement-breakpoint
CREATE INDEX "attribution_ids_counterparty_idx" ON "attribution_ids" USING btree ("counterparty_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_accrual_subjects_ux" ON "commission_accrual_subjects" USING btree ("agreement_id","invoice_id","direction");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_accruals_basis_event_ux" ON "commission_accruals" USING btree ("subject_id","basis_event_id");--> statement-breakpoint
CREATE INDEX "commission_accruals_counterparty_idx" ON "commission_accruals" USING btree ("counterparty_id","direction","state");--> statement-breakpoint
CREATE INDEX "commission_accruals_invoice_idx" ON "commission_accruals" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "commission_accruals_period_idx" ON "commission_accruals" USING btree ("period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "counterparties_code_ux" ON "counterparties" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_agreements_version_ux" ON "partner_agreements" USING btree ("counterparty_id","version_no");--> statement-breakpoint
CREATE INDEX "partner_agreements_effective_idx" ON "partner_agreements" USING btree ("counterparty_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_ref_map_ref_ux" ON "partner_ref_map" USING btree ("counterparty_id","partner_ref");--> statement-breakpoint
CREATE INDEX "receivable_expectations_state_idx" ON "receivable_expectations" USING btree ("counterparty_id","state");--> statement-breakpoint
CREATE INDEX "receivable_expectations_attribution_idx" ON "receivable_expectations" USING btree ("attribution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receivable_expectations_statement_line_ux" ON "receivable_expectations" USING btree ("counterparty_id","statement_ref","statement_line_no") WHERE "receivable_expectations"."statement_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "coupon_definitions_code_ux" ON "coupon_definitions" USING btree ("code");--> statement-breakpoint
CREATE INDEX "coupon_redemptions_coupon_idx" ON "coupon_redemptions" USING btree ("coupon_id");--> statement-breakpoint
CREATE INDEX "coupon_redemptions_invoice_idx" ON "coupon_redemptions" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coupon_redemptions_single_use_uq" ON "coupon_redemptions" USING btree ("coupon_id","cycle_no") WHERE "coupon_redemptions"."single_use" and "coupon_redemptions"."state" = 'redeemed';--> statement-breakpoint
CREATE UNIQUE INDEX "covered_members_instance_no_ux" ON "covered_members" USING btree ("instance_id","member_no");--> statement-breakpoint
CREATE INDEX "covered_members_patient_idx" ON "covered_members" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_counters_instance_benefit_ux" ON "entitlement_counters" USING btree ("instance_id","benefit_key");--> statement-breakpoint
CREATE INDEX "entitlement_movements_counter_idx" ON "entitlement_movements" USING btree ("counter_id");--> statement-breakpoint
CREATE INDEX "entitlement_movements_invoice_idx" ON "entitlement_movements" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "holder_book_imports_file_ux" ON "holder_book_imports" USING btree ("counterparty_id","file_hash");--> statement-breakpoint
CREATE INDEX "import_quarantine_batch_idx" ON "import_quarantine" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "membership_instances_card_code_idx" ON "membership_instances" USING btree ("card_code");--> statement-breakpoint
CREATE INDEX "membership_instances_patient_idx" ON "membership_instances" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_instances_sale_ref_ux" ON "membership_instances" USING btree ("counterparty_id","partner_sale_ref") WHERE "membership_instances"."partner_sale_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "membership_plans_code_ux" ON "membership_plans" USING btree ("code");--> statement-breakpoint
CREATE INDEX "patient_match_queue_state_idx" ON "patient_match_queue" USING btree ("state");--> statement-breakpoint
CREATE INDEX "patient_match_queue_instance_idx" ON "patient_match_queue" USING btree ("instance_id");--> statement-breakpoint
-- ═══ DD5 — THE APPEND-ONLY LEDGER, AND WHY IT DEFINES ITS OWN FUNCTION ═══
--
-- `0012_billing_immutability.sql` already ships this exact shape — one plpgsql function raising
-- unconditionally, attached BEFORE UPDATE OR DELETE FOR EACH ROW — and Q2 measured that it is
-- reusable verbatim. What is NOT reused is billing's FUNCTION: its message names the wrong module
-- ("billing_immutable"), and a function shared between two plans lets one plan's migration change
-- another plan's error text. Two functions, one shape.
--
-- The three tables below are the phase's money and benefit ledgers. A reversal is a NEGATIVE ROW,
-- an escrow is a state chosen at INSERT, a coupon release is a second row, and a restore is a
-- negating movement — so nothing here ever needs an UPDATE, which is exactly what lets the trigger
-- be total. `receivable_expectations` is deliberately NOT in this set: it records a CLAIM that
-- genuinely walks expected → matched → disputed → written_off, and mixing a claim into a ledger is
-- what makes an append-only ledger need an UPDATE.
--
-- Locking an immutable row is legal (`receipts.ts:178`, `lockInvoice`), so DD10's `FOR UPDATE`
-- serializer and this trigger are not in tension.
CREATE FUNCTION partner_ledger_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'partner_ledger_immutable: % rows are append-only (% refused)', TG_TABLE_NAME, TG_OP; END $$;--> statement-breakpoint
CREATE TRIGGER commission_accruals_immutable BEFORE UPDATE OR DELETE ON commission_accruals FOR EACH ROW EXECUTE FUNCTION partner_ledger_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER entitlement_movements_immutable BEFORE UPDATE OR DELETE ON entitlement_movements FOR EACH ROW EXECUTE FUNCTION partner_ledger_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER coupon_redemptions_immutable BEFORE UPDATE OR DELETE ON coupon_redemptions FOR EACH ROW EXECUTE FUNCTION partner_ledger_forbid_mutation();
