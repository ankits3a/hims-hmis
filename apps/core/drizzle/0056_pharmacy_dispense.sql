CREATE TABLE "pharmacy_dispense_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"dispense_id" text NOT NULL,
	"line_idx" integer NOT NULL,
	"rx_line" jsonb NOT NULL,
	"ordered_medicine_id" text,
	"dispensed_medicine_id" text,
	"substitution_type" text DEFAULT 'none' NOT NULL,
	"consent_by" text,
	"consent_at" timestamp with time zone,
	"item_id" text,
	"qty_base" integer,
	"batch_id" text,
	"reservation_id" text,
	"ledger_entry_id" text,
	"fefo_override" boolean DEFAULT false NOT NULL,
	"pick_note" text,
	"order_item_id" text,
	"invoice_line_id" text,
	"unit_paise" bigint,
	"price_winner" text,
	"schedule_flag" text,
	"status" text DEFAULT 'open' NOT NULL,
	"declined_reason" text,
	"declined_by" text,
	"declined_at" timestamp with time zone,
	CONSTRAINT "pharmacy_dispense_lines_status_ck" CHECK ("pharmacy_dispense_lines"."status" in ('open', 'declined')),
	CONSTRAINT "pharmacy_dispense_lines_substitution_ck" CHECK ("pharmacy_dispense_lines"."substitution_type" in ('none', 'resolved', 'generic')),
	CONSTRAINT "pharmacy_dispense_lines_generic_consent_ck" CHECK ("pharmacy_dispense_lines"."substitution_type" <> 'generic' or "pharmacy_dispense_lines"."consent_by" is not null),
	CONSTRAINT "pharmacy_dispense_lines_qty_ck" CHECK ("pharmacy_dispense_lines"."qty_base" is null or "pharmacy_dispense_lines"."qty_base" > 0),
	CONSTRAINT "pharmacy_dispense_lines_winner_ck" CHECK ("pharmacy_dispense_lines"."price_winner" is null or "pharmacy_dispense_lines"."price_winner" in ('batch_mrp', 'ceiling', 'tariff')),
	CONSTRAINT "pharmacy_dispense_lines_schedule_ck" CHECK ("pharmacy_dispense_lines"."schedule_flag" is null or "pharmacy_dispense_lines"."schedule_flag" in ('H', 'H1', 'X', 'OTC')),
	CONSTRAINT "pharmacy_dispense_lines_declined_ck" CHECK ("pharmacy_dispense_lines"."status" <> 'declined' or "pharmacy_dispense_lines"."declined_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "pharmacy_dispenses" (
	"id" text PRIMARY KEY NOT NULL,
	"dispense_no" text,
	"order_id" text,
	"prescription_id" text NOT NULL,
	"prescription_version" integer NOT NULL,
	"patient_id" text NOT NULL,
	"encounter_id" text NOT NULL,
	"store_resource_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"workflow_instance_id" text,
	"scheduled" boolean DEFAULT false NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"picked_by" text,
	"picked_at" timestamp with time zone,
	"invoice_id" text,
	"billed_at" timestamp with time zone,
	"handed_over_by" text,
	"handed_over_at" timestamp with time zone,
	"identity_confirmed_via" text,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pharmacy_dispenses_status_ck" CHECK ("pharmacy_dispenses"."status" in ('queued', 'claimed', 'verified', 'picked', 'billed', 'handed_over', 'cancelled')),
	CONSTRAINT "pharmacy_dispenses_claimed_has_order_ck" CHECK ("pharmacy_dispenses"."status" not in ('verified', 'picked', 'billed', 'handed_over') or ("pharmacy_dispenses"."order_id" is not null and "pharmacy_dispenses"."dispense_no" is not null and "pharmacy_dispenses"."store_resource_id" is not null)),
	CONSTRAINT "pharmacy_dispenses_identity_ck" CHECK ("pharmacy_dispenses"."identity_confirmed_via" is null or "pharmacy_dispenses"."identity_confirmed_via" in ('token', 'phone_last4'))
);
--> statement-breakpoint
CREATE TABLE "pharmacy_reg_h1" (
	"seq" bigserial NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"dispense_line_id" text NOT NULL,
	"dispensed_at" timestamp with time zone NOT NULL,
	"patient_id" text NOT NULL,
	"patient_name" text NOT NULL,
	"patient_address" text,
	"prescriber_name" text NOT NULL,
	"prescriber_reg_no" text,
	"drug_name" text NOT NULL,
	"medicine_id" text,
	"batch_no" text NOT NULL,
	"qty_base" integer NOT NULL,
	"unit" text NOT NULL,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pharmacy_reg_h1_qty_ck" CHECK ("pharmacy_reg_h1"."qty_base" > 0)
);
--> statement-breakpoint
CREATE TABLE "pharmacy_sale_items" (
	"item_id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD CONSTRAINT "pharmacy_dispense_lines_dispense_id_pharmacy_dispenses_id_fk" FOREIGN KEY ("dispense_id") REFERENCES "public"."pharmacy_dispenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD CONSTRAINT "pharmacy_dispense_lines_ordered_medicine_id_formulary_medicines_id_fk" FOREIGN KEY ("ordered_medicine_id") REFERENCES "public"."formulary_medicines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD CONSTRAINT "pharmacy_dispense_lines_dispensed_medicine_id_formulary_medicines_id_fk" FOREIGN KEY ("dispensed_medicine_id") REFERENCES "public"."formulary_medicines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD CONSTRAINT "pharmacy_dispense_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD CONSTRAINT "pharmacy_dispense_lines_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD CONSTRAINT "pharmacy_dispense_lines_reservation_id_stock_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."stock_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD CONSTRAINT "pharmacy_dispense_lines_ledger_entry_id_stock_ledger_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."stock_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD CONSTRAINT "pharmacy_dispense_lines_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD CONSTRAINT "pharmacy_dispense_lines_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD CONSTRAINT "pharmacy_dispenses_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD CONSTRAINT "pharmacy_dispenses_prescription_id_opd_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."opd_prescriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD CONSTRAINT "pharmacy_dispenses_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD CONSTRAINT "pharmacy_dispenses_encounter_id_opd_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."opd_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD CONSTRAINT "pharmacy_dispenses_store_resource_id_resources_id_fk" FOREIGN KEY ("store_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD CONSTRAINT "pharmacy_dispenses_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_reg_h1" ADD CONSTRAINT "pharmacy_reg_h1_dispense_line_id_pharmacy_dispense_lines_id_fk" FOREIGN KEY ("dispense_line_id") REFERENCES "public"."pharmacy_dispense_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_reg_h1" ADD CONSTRAINT "pharmacy_reg_h1_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_reg_h1" ADD CONSTRAINT "pharmacy_reg_h1_medicine_id_formulary_medicines_id_fk" FOREIGN KEY ("medicine_id") REFERENCES "public"."formulary_medicines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_sale_items" ADD CONSTRAINT "pharmacy_sale_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_sale_items" ADD CONSTRAINT "pharmacy_sale_items_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_dispense_lines_idx_ux" ON "pharmacy_dispense_lines" USING btree ("dispense_id","line_idx");--> statement-breakpoint
CREATE INDEX "pharmacy_dispense_lines_batch_idx" ON "pharmacy_dispense_lines" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_dispenses_no_ux" ON "pharmacy_dispenses" USING btree ("dispense_no");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_dispenses_live_rx_ux" ON "pharmacy_dispenses" USING btree ("prescription_id","prescription_version") WHERE "pharmacy_dispenses"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "pharmacy_dispenses_status_idx" ON "pharmacy_dispenses" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "pharmacy_dispenses_patient_idx" ON "pharmacy_dispenses" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "pharmacy_dispenses_encounter_idx" ON "pharmacy_dispenses" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "pharmacy_reg_h1_dispensed_idx" ON "pharmacy_reg_h1" USING btree ("dispensed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_sale_items_service_ux" ON "pharmacy_sale_items" USING btree ("service_id");--> statement-breakpoint
-- ═══ PLAN 16c T1 — THE H1 REGISTER IS APPEND-ONLY, HAND-CARRIED (drizzle-kit emits no triggers) ═══
--
-- Rule 65(3), Drugs and Cosmetics Rules: the Schedule H1 register is a statutory record retained
-- three years. It is written once at hand-over (16c T4) and has no edit endpoint; this trigger is
-- why there cannot be one. The `lab_results_immutable` shape (migration 0046), applied unconditionally.
CREATE OR REPLACE FUNCTION pharmacy_reg_h1_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy_reg_h1_immutable: a Schedule H1 register row may not be deleted (id %)', OLD.id;
  END IF;
  RAISE EXCEPTION 'pharmacy_reg_h1_immutable: a Schedule H1 register row may not be edited (id %) — a wrong entry is corrected by a further entry, never by an edit', OLD.id;
END $$;--> statement-breakpoint
CREATE TRIGGER pharmacy_reg_h1_immutable
  BEFORE UPDATE OR DELETE ON pharmacy_reg_h1
  FOR EACH ROW
  EXECUTE FUNCTION pharmacy_reg_h1_forbid_mutation();
