-- ═══ PHARMACY P19: WALK-IN RETAIL SALES ═══
--
-- Phase doc: docs/superpowers/plans/2026-09-17-phase-pharmacy-p19-retail-sales.md.
-- Three new tables: the retail store's Form 20/21 licence (append-only by use), a walk-in sale and
-- its lines. The H1 register gains `retail_line_id` and `prescriber_address`, and `dispense_line_id`
-- becomes nullable under a CHECK that exactly one of the two is set. Every existing register row
-- has a dispense line and no retail line, so the CHECK holds for them. The register's immutability
-- trigger fires on row UPDATE and DELETE only; these are schema changes. Additive otherwise.
CREATE TABLE "pharmacy_retail_licences" (
	"id" text PRIMARY KEY NOT NULL,
	"store_resource_id" text NOT NULL,
	"form20_no" text NOT NULL,
	"form21_no" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"pharmacist_in_charge" text NOT NULL,
	"note" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pharmacy_retail_licences_dates_ck" CHECK ("pharmacy_retail_licences"."valid_to" >= "pharmacy_retail_licences"."valid_from"),
	CONSTRAINT "pharmacy_retail_licences_text_ck" CHECK (btrim("pharmacy_retail_licences"."form20_no") <> '' and btrim("pharmacy_retail_licences"."form21_no") <> '' and btrim("pharmacy_retail_licences"."pharmacist_in_charge") <> '')
);
--> statement-breakpoint
CREATE TABLE "pharmacy_retail_sale_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"sale_id" text NOT NULL,
	"line_idx" integer NOT NULL,
	"medicine_id" text NOT NULL,
	"item_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"qty_base" integer NOT NULL,
	"ledger_entry_id" text NOT NULL,
	"invoice_line_id" text NOT NULL,
	"unit_paise" bigint NOT NULL,
	"price_winner" text NOT NULL,
	"schedule_flag" text,
	"fefo_override" boolean DEFAULT false NOT NULL,
	CONSTRAINT "pharmacy_retail_sale_lines_qty_ck" CHECK ("pharmacy_retail_sale_lines"."qty_base" > 0),
	CONSTRAINT "pharmacy_retail_sale_lines_winner_ck" CHECK ("pharmacy_retail_sale_lines"."price_winner" in ('batch_mrp', 'ceiling', 'tariff')),
	CONSTRAINT "pharmacy_retail_sale_lines_schedule_ck" CHECK ("pharmacy_retail_sale_lines"."schedule_flag" is null or "pharmacy_retail_sale_lines"."schedule_flag" in ('H', 'H1', 'OTC'))
);
--> statement-breakpoint
CREATE TABLE "pharmacy_retail_sales" (
	"id" text PRIMARY KEY NOT NULL,
	"store_resource_id" text NOT NULL,
	"licence_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"registered_here" boolean DEFAULT false NOT NULL,
	"scheduled" boolean NOT NULL,
	"rx_prescriber_name" text,
	"rx_prescriber_reg_no" text,
	"rx_prescriber_address" text,
	"rx_date" date,
	"rx_document_id" text,
	"invoice_id" text NOT NULL,
	"pharmacist_reg_no" text,
	"sold_by" text NOT NULL,
	"sold_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pharmacy_retail_sales_rx_ck" CHECK (not "pharmacy_retail_sales"."scheduled" or ("pharmacy_retail_sales"."rx_prescriber_name" is not null and "pharmacy_retail_sales"."rx_prescriber_reg_no" is not null and "pharmacy_retail_sales"."rx_prescriber_address" is not null and "pharmacy_retail_sales"."rx_date" is not null and "pharmacy_retail_sales"."rx_document_id" is not null and "pharmacy_retail_sales"."pharmacist_reg_no" is not null))
);
--> statement-breakpoint
ALTER TABLE "pharmacy_reg_h1" ALTER COLUMN "dispense_line_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pharmacy_reg_h1" ADD COLUMN "retail_line_id" text;--> statement-breakpoint
ALTER TABLE "pharmacy_reg_h1" ADD COLUMN "prescriber_address" text;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_licences" ADD CONSTRAINT "pharmacy_retail_licences_store_resource_id_resources_id_fk" FOREIGN KEY ("store_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_licences" ADD CONSTRAINT "pharmacy_retail_licences_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sale_lines" ADD CONSTRAINT "pharmacy_retail_sale_lines_sale_id_pharmacy_retail_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."pharmacy_retail_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sale_lines" ADD CONSTRAINT "pharmacy_retail_sale_lines_medicine_id_formulary_medicines_id_fk" FOREIGN KEY ("medicine_id") REFERENCES "public"."formulary_medicines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sale_lines" ADD CONSTRAINT "pharmacy_retail_sale_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sale_lines" ADD CONSTRAINT "pharmacy_retail_sale_lines_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sale_lines" ADD CONSTRAINT "pharmacy_retail_sale_lines_ledger_entry_id_stock_ledger_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."stock_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sale_lines" ADD CONSTRAINT "pharmacy_retail_sale_lines_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sales" ADD CONSTRAINT "pharmacy_retail_sales_store_resource_id_resources_id_fk" FOREIGN KEY ("store_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sales" ADD CONSTRAINT "pharmacy_retail_sales_licence_id_pharmacy_retail_licences_id_fk" FOREIGN KEY ("licence_id") REFERENCES "public"."pharmacy_retail_licences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sales" ADD CONSTRAINT "pharmacy_retail_sales_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sales" ADD CONSTRAINT "pharmacy_retail_sales_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sales" ADD CONSTRAINT "pharmacy_retail_sales_sold_by_users_id_fk" FOREIGN KEY ("sold_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pharmacy_retail_licences_store_idx" ON "pharmacy_retail_licences" USING btree ("store_resource_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_retail_sale_lines_idx_ux" ON "pharmacy_retail_sale_lines" USING btree ("sale_id","line_idx");--> statement-breakpoint
CREATE INDEX "pharmacy_retail_sale_lines_batch_idx" ON "pharmacy_retail_sale_lines" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_retail_sales_invoice_ux" ON "pharmacy_retail_sales" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "pharmacy_retail_sales_sold_idx" ON "pharmacy_retail_sales" USING btree ("sold_at");--> statement-breakpoint
CREATE INDEX "pharmacy_retail_sales_patient_idx" ON "pharmacy_retail_sales" USING btree ("patient_id");--> statement-breakpoint
ALTER TABLE "pharmacy_reg_h1" ADD CONSTRAINT "pharmacy_reg_h1_retail_line_id_pharmacy_retail_sale_lines_id_fk" FOREIGN KEY ("retail_line_id") REFERENCES "public"."pharmacy_retail_sale_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_reg_h1" ADD CONSTRAINT "pharmacy_reg_h1_one_source_ck" CHECK (("pharmacy_reg_h1"."dispense_line_id" is null) <> ("pharmacy_reg_h1"."retail_line_id" is null));