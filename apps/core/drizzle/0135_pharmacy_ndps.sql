CREATE TABLE "controlled_stock_register" (
	"seq" bigserial NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"ledger_entry_id" text NOT NULL,
	"store_resource_id" text NOT NULL,
	"item_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"medicine_id" text,
	"drug_name" text NOT NULL,
	"batch_no" text NOT NULL,
	"expiry_date" date,
	"ndps_class" text,
	"schedule_flag" text,
	"movement" text NOT NULL,
	"direction" text NOT NULL,
	"qty_base" integer NOT NULL,
	"unit" text NOT NULL,
	"balance_after" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"holder_id" text NOT NULL,
	"holder_name" text NOT NULL,
	"witness_id" text NOT NULL,
	"witness_name" text NOT NULL,
	"holder_reg_no" text,
	"extra_witnesses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counterparty" text,
	"counterparty_address" text,
	"counterparty_licence" text,
	"document_ref" text,
	"document_date" date,
	"rx_ref" text,
	"patient_id" text,
	"prescriber_name" text,
	"prescriber_reg_no" text,
	"retained_document_id" text,
	"collected_by" text,
	"collected_id_proof" text,
	"note" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "controlled_stock_register_qty_ck" CHECK ("controlled_stock_register"."qty_base" > 0 and "controlled_stock_register"."balance_after" >= 0),
	CONSTRAINT "controlled_stock_register_direction_ck" CHECK ("controlled_stock_register"."direction" in ('in', 'out')),
	CONSTRAINT "controlled_stock_register_movement_ck" CHECK ("controlled_stock_register"."movement" in ('grn', 'issue', 'receive', 'consume', 'return', 'adjust')),
	CONSTRAINT "controlled_stock_register_two_keys_ck" CHECK ("controlled_stock_register"."witness_id" <> "controlled_stock_register"."holder_id"),
	CONSTRAINT "controlled_stock_register_ndps_ck" CHECK ("controlled_stock_register"."ndps_class" is null or "controlled_stock_register"."ndps_class" in ('narcotic', 'psychotropic'))
);
--> statement-breakpoint
CREATE TABLE "pharmacy_controlled_licences" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"licence_no" text NOT NULL,
	"form" text NOT NULL,
	"issuing_authority" text NOT NULL,
	"holder_name" text NOT NULL,
	"responsible_person" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_until" date NOT NULL,
	"document_ref" text,
	"note" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pharmacy_controlled_licences_kind_ck" CHECK ("pharmacy_controlled_licences"."kind" in ('ndps_rmi', 'schedule_x')),
	CONSTRAINT "pharmacy_controlled_licences_dates_ck" CHECK ("pharmacy_controlled_licences"."valid_until" >= "pharmacy_controlled_licences"."valid_from"),
	CONSTRAINT "pharmacy_controlled_licences_text_ck" CHECK (btrim("pharmacy_controlled_licences"."licence_no") <> '' and btrim("pharmacy_controlled_licences"."form") <> '' and btrim("pharmacy_controlled_licences"."issuing_authority") <> '' and btrim("pharmacy_controlled_licences"."holder_name") <> '' and btrim("pharmacy_controlled_licences"."responsible_person") <> '')
);
--> statement-breakpoint
CREATE TABLE "pharmacy_end_prescribers" (
	"id" text PRIMARY KEY NOT NULL,
	"doctor_id" text NOT NULL,
	"training" text NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" text,
	"end_reason" text,
	CONSTRAINT "pharmacy_end_prescribers_ended_ck" CHECK (("pharmacy_end_prescribers"."ended_at" is null) = ("pharmacy_end_prescribers"."ended_by" is null) and ("pharmacy_end_prescribers"."ended_at" is null) = ("pharmacy_end_prescribers"."end_reason" is null)),
	CONSTRAINT "pharmacy_end_prescribers_text_ck" CHECK (btrim("pharmacy_end_prescribers"."training") <> '')
);
--> statement-breakpoint
ALTER TABLE "formulary_salts" ADD COLUMN "ndps_class" text;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD COLUMN "kind" text DEFAULT 'blind' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD COLUMN "witness_id" text;--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD COLUMN "ndps_class" text;--> statement-breakpoint
ALTER TABLE "controlled_stock_register" ADD CONSTRAINT "controlled_stock_register_ledger_entry_id_stock_ledger_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."stock_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_stock_register" ADD CONSTRAINT "controlled_stock_register_store_resource_id_resources_id_fk" FOREIGN KEY ("store_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_stock_register" ADD CONSTRAINT "controlled_stock_register_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_stock_register" ADD CONSTRAINT "controlled_stock_register_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_stock_register" ADD CONSTRAINT "controlled_stock_register_medicine_id_formulary_medicines_id_fk" FOREIGN KEY ("medicine_id") REFERENCES "public"."formulary_medicines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_controlled_licences" ADD CONSTRAINT "pharmacy_controlled_licences_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_end_prescribers" ADD CONSTRAINT "pharmacy_end_prescribers_doctor_id_opd_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."opd_doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_end_prescribers" ADD CONSTRAINT "pharmacy_end_prescribers_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_end_prescribers" ADD CONSTRAINT "pharmacy_end_prescribers_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "controlled_stock_register_ledger_ux" ON "controlled_stock_register" USING btree ("ledger_entry_id");--> statement-breakpoint
CREATE INDEX "controlled_stock_register_store_idx" ON "controlled_stock_register" USING btree ("store_resource_id","occurred_at");--> statement-breakpoint
CREATE INDEX "controlled_stock_register_batch_idx" ON "controlled_stock_register" USING btree ("batch_id","seq");--> statement-breakpoint
CREATE INDEX "pharmacy_controlled_licences_kind_idx" ON "pharmacy_controlled_licences" USING btree ("kind","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_end_prescribers_current_ux" ON "pharmacy_end_prescribers" USING btree ("doctor_id") WHERE "pharmacy_end_prescribers"."ended_at" is null;--> statement-breakpoint
ALTER TABLE "formulary_salts" ADD CONSTRAINT "formulary_salts_ndps_class_ck" CHECK ("formulary_salts"."ndps_class" is null or "formulary_salts"."ndps_class" in ('narcotic', 'psychotropic'));--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_kind_ck" CHECK ("stock_counts"."kind" in ('blind', 'controlled_check'));--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_witness_ck" CHECK ("stock_ledger"."witness_id" is null or "stock_ledger"."witness_id" <> "stock_ledger"."actor_id");--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD CONSTRAINT "pharmacy_dispense_lines_ndps_ck" CHECK ("pharmacy_dispense_lines"."ndps_class" is null or "pharmacy_dispense_lines"."ndps_class" in ('narcotic', 'psychotropic'));--> statement-breakpoint
-- ═══ PHARMACY P6 — THE CONTROLLED-DRUG REGISTER IS APPEND-ONLY, HAND-CARRIED (drizzle-kit emits no triggers) ═══
-- NDPS Rules 1985 r.52R / Form 3H and D&C Rules 1945 r.65(21): the register of the cabinet is kept on
-- serially numbered pages and produced to the inspector; a wrong entry is corrected by a further entry. It
-- is written by the ledger in the same transaction as the movement (`materials/controlled.ts`) and has no
-- edit path; this trigger is why there cannot be one. The `pharmacy_reg_h1` shape (migration 0056).
CREATE OR REPLACE FUNCTION controlled_stock_register_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'controlled_stock_register_immutable: a controlled-drug register row may not be deleted (id %)', OLD.id;
  END IF;
  RAISE EXCEPTION 'controlled_stock_register_immutable: a controlled-drug register row may not be edited (id %) — a wrong entry is corrected by a further entry, never by an edit', OLD.id;
END $$;--> statement-breakpoint
CREATE TRIGGER controlled_stock_register_immutable
  BEFORE UPDATE OR DELETE ON controlled_stock_register
  FOR EACH ROW
  EXECUTE FUNCTION controlled_stock_register_forbid_mutation();
