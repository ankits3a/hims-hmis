CREATE TABLE "consignment_lots" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor_id" text NOT NULL,
	"agreement_document_id" text NOT NULL,
	"challan_no" text NOT NULL,
	"challan_date" date NOT NULL,
	"item_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"store_resource_id" text NOT NULL,
	"qty_received" integer DEFAULT 0 NOT NULL,
	"qty_deployed" integer DEFAULT 0 NOT NULL,
	"qty_returned" integer DEFAULT 0 NOT NULL,
	"deemed_supply_deadline" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consignment_lots_status_ck" CHECK ("consignment_lots"."status" in ('open', 'reconciled', 'closed')),
	CONSTRAINT "consignment_lots_qty_ck" CHECK ("consignment_lots"."qty_deployed" + "consignment_lots"."qty_returned" <= "consignment_lots"."qty_received")
);
--> statement-breakpoint
CREATE TABLE "grn_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"grn_id" text NOT NULL,
	"item_id" text NOT NULL,
	"uom" text NOT NULL,
	"qty_in_uom" integer NOT NULL,
	"qty_base" integer NOT NULL,
	"batch_no" text,
	"mfg_date" date,
	"expiry_date" date,
	"mrp_paise" bigint,
	"mrp_uom" text,
	"unit_cost_paise" bigint NOT NULL,
	"free_goods" boolean DEFAULT false NOT NULL,
	"qty_accepted_base" integer DEFAULT 0 NOT NULL,
	"qty_rejected_base" integer DEFAULT 0 NOT NULL,
	"reject_reason" text,
	"near_expiry" boolean DEFAULT false NOT NULL,
	"temp_log_ref" text,
	"batch_id" text,
	CONSTRAINT "grn_lines_qty_in_uom_ck" CHECK ("grn_lines"."qty_in_uom" > 0),
	CONSTRAINT "grn_lines_qty_base_ck" CHECK ("grn_lines"."qty_base" > 0)
);
--> statement-breakpoint
CREATE TABLE "grns" (
	"id" text PRIMARY KEY NOT NULL,
	"grn_no" text NOT NULL,
	"vendor_id" text NOT NULL,
	"source" text NOT NULL,
	"po_ref" text,
	"challan_no" text NOT NULL,
	"challan_date" date NOT NULL,
	"invoice_no" text,
	"store_resource_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"captured_by" text NOT NULL,
	"qc_by" text,
	"posted_at" timestamp with time zone,
	"approval_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grns_source_ck" CHECK ("grns"."source" in ('challan', 'consignment_challan', 'donation')),
	CONSTRAINT "grns_status_ck" CHECK ("grns"."status" in ('draft', 'gate_qc', 'accepted', 'partially_accepted', 'rejected', 'posted'))
);
--> statement-breakpoint
CREATE TABLE "item_barcodes" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"code" text NOT NULL,
	"pack_uom" text NOT NULL,
	"vendor_id" text
);
--> statement-breakpoint
CREATE TABLE "item_price_regulations" (
	"seq" bigserial NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"mrp_default_paise" bigint,
	"mrp_uom" text,
	"ceiling_paise" bigint,
	"effective_from" timestamp with time zone NOT NULL,
	"gazette_ref" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_uoms" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"uom" text NOT NULL,
	"to_base_multiplier" integer NOT NULL,
	"is_purchase_uom" boolean DEFAULT false NOT NULL,
	"is_issue_uom" boolean DEFAULT false NOT NULL,
	CONSTRAINT "item_uoms_multiplier_ck" CHECK ("item_uoms"."to_base_multiplier" > 0)
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"class" text NOT NULL,
	"formulary_medicine_id" text,
	"hsn_code" text,
	"gst_rate_bps" integer,
	"base_uom" text NOT NULL,
	"batch_tracked" boolean NOT NULL,
	"serial_tracked" boolean DEFAULT false NOT NULL,
	"storage_class" text DEFAULT 'ambient' NOT NULL,
	"shelf_life_days" integer,
	"abc_class" text,
	"ved_class" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_class_ck" CHECK ("items"."class" in ('drug', 'consumable', 'consumable_dated', 'reagent', 'implant', 'stationery', 'linen', 'gas', 'asset', 'service')),
	CONSTRAINT "items_storage_class_ck" CHECK ("items"."storage_class" in ('ambient', 'cold_2_8', 'frozen', 'narcotic', 'flammable')),
	CONSTRAINT "items_class_formulary_ck" CHECK (("items"."class" = 'drug') = ("items"."formulary_medicine_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"resource_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"item_id" text NOT NULL,
	"qty_on_hand" integer DEFAULT 0 NOT NULL,
	"qty_reserved" integer DEFAULT 0 NOT NULL,
	"qty_frozen" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_pk" PRIMARY KEY("resource_id","batch_id"),
	CONSTRAINT "stock_balances_non_negative_ck" CHECK ("stock_balances"."qty_on_hand" >= 0 and "stock_balances"."qty_reserved" <= "stock_balances"."qty_on_hand" and "stock_balances"."qty_frozen" <= "stock_balances"."qty_on_hand")
);
--> statement-breakpoint
CREATE TABLE "stock_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"batch_no" text NOT NULL,
	"mfg_date" date,
	"expiry_date" date,
	"mrp_paise" bigint,
	"mrp_uom" text,
	"landed_cost_paise" bigint NOT NULL,
	"vendor_id" text,
	"grn_line_id" text,
	"ownership" text NOT NULL,
	"consignment_lot_id" text,
	"recall_status" text DEFAULT 'none' NOT NULL,
	"expiry_notified_thresholds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_batches_ownership_ck" CHECK ("stock_batches"."ownership" in ('owned', 'consignment', 'loaner', 'donated')),
	CONSTRAINT "stock_batches_recall_status_ck" CHECK ("stock_batches"."recall_status" in ('none', 'frozen'))
);
--> statement-breakpoint
CREATE TABLE "stock_ledger" (
	"seq" bigserial NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"item_id" text NOT NULL,
	"qty_delta" integer NOT NULL,
	"reason" text NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"event_id" text,
	"patient_id" text,
	"encounter_id" text,
	"cost_center" text,
	"actor_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_ledger_qty_delta_ck" CHECK ("stock_ledger"."qty_delta" <> 0),
	CONSTRAINT "stock_ledger_reason_ck" CHECK ("stock_ledger"."reason" in ('grn', 'issue', 'receive', 'consume', 'return'))
);
--> statement-breakpoint
CREATE TABLE "stock_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"qty" integer NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'held' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_reservations_qty_ck" CHECK ("stock_reservations"."qty" > 0),
	CONSTRAINT "stock_reservations_status_ck" CHECK ("stock_reservations"."status" in ('held', 'consumed', 'released'))
);
--> statement-breakpoint
CREATE TABLE "transfer_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"transfer_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"qty_issued" integer NOT NULL,
	"qty_received" integer,
	"discrepancy_reason" text,
	CONSTRAINT "transfer_lines_qty_issued_ck" CHECK ("transfer_lines"."qty_issued" > 0)
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"from_resource_id" text NOT NULL,
	"to_resource_id" text NOT NULL,
	"status" text DEFAULT 'in_transit' NOT NULL,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_by" text,
	"received_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "transfers_status_ck" CHECK ("transfers"."status" in ('in_transit', 'received', 'discrepancy'))
);
--> statement-breakpoint
CREATE TABLE "vendor_bank_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor_id" text NOT NULL,
	"old_masked" text,
	"new_masked" text NOT NULL,
	"new_bank" jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"approval_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"cooling_off_until" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_bank_changes_status_ck" CHECK ("vendor_bank_changes"."status" in ('pending', 'applied', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "vendor_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor_id" text NOT NULL,
	"type" text NOT NULL,
	"number" text NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"file_ref" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_documents_type_ck" CHECK ("vendor_documents"."type" in ('drug_licence_20b', 'drug_licence_21b', 'gst_certificate', 'pan', 'cancelled_cheque', 'udyam', 'dpdp_processor_agreement', 'consignment_agreement', 'iso', 'aerb_type_approval'))
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"legal_name" text NOT NULL,
	"trade_name" text,
	"gstin" text,
	"gstin_verified_at" timestamp with time zone,
	"pan" text,
	"msme_udyam_no" text,
	"msme_class" text,
	"payment_terms_days" integer,
	"class_flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bank" jsonb,
	"first_payment_allowed_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"blacklist_until" timestamp with time zone,
	"blacklist_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendors_status_ck" CHECK ("vendors"."status" in ('draft', 'active', 'suspended', 'blacklisted'))
);
--> statement-breakpoint
ALTER TABLE "consignment_lots" ADD CONSTRAINT "consignment_lots_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consignment_lots" ADD CONSTRAINT "consignment_lots_agreement_document_id_vendor_documents_id_fk" FOREIGN KEY ("agreement_document_id") REFERENCES "public"."vendor_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consignment_lots" ADD CONSTRAINT "consignment_lots_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consignment_lots" ADD CONSTRAINT "consignment_lots_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consignment_lots" ADD CONSTRAINT "consignment_lots_store_resource_id_resources_id_fk" FOREIGN KEY ("store_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grn_lines" ADD CONSTRAINT "grn_lines_grn_id_grns_id_fk" FOREIGN KEY ("grn_id") REFERENCES "public"."grns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grn_lines" ADD CONSTRAINT "grn_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grn_lines" ADD CONSTRAINT "grn_lines_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grns" ADD CONSTRAINT "grns_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grns" ADD CONSTRAINT "grns_store_resource_id_resources_id_fk" FOREIGN KEY ("store_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_barcodes" ADD CONSTRAINT "item_barcodes_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_price_regulations" ADD CONSTRAINT "item_price_regulations_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_uoms" ADD CONSTRAINT "item_uoms_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_formulary_medicine_id_formulary_medicines_id_fk" FOREIGN KEY ("formulary_medicine_id") REFERENCES "public"."formulary_medicines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_lines" ADD CONSTRAINT "transfer_lines_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_lines" ADD CONSTRAINT "transfer_lines_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_resource_id_resources_id_fk" FOREIGN KEY ("from_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_resource_id_resources_id_fk" FOREIGN KEY ("to_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bank_changes" ADD CONSTRAINT "vendor_bank_changes_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_documents" ADD CONSTRAINT "vendor_documents_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consignment_lots_vendor_idx" ON "consignment_lots" USING btree ("vendor_id","challan_date");--> statement-breakpoint
CREATE INDEX "consignment_lots_batch_idx" ON "consignment_lots" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "consignment_lots_deadline_idx" ON "consignment_lots" USING btree ("deemed_supply_deadline");--> statement-breakpoint
CREATE INDEX "grn_lines_grn_idx" ON "grn_lines" USING btree ("grn_id");--> statement-breakpoint
CREATE INDEX "grn_lines_item_idx" ON "grn_lines" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grns_grn_no_ux" ON "grns" USING btree ("grn_no");--> statement-breakpoint
CREATE INDEX "grns_vendor_idx" ON "grns" USING btree ("vendor_id","challan_date");--> statement-breakpoint
CREATE INDEX "grns_store_status_idx" ON "grns" USING btree ("store_resource_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "item_barcodes_code_lower_ux" ON "item_barcodes" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "item_barcodes_item_idx" ON "item_barcodes" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "item_price_regulations_item_idx" ON "item_price_regulations" USING btree ("item_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "item_uoms_item_uom_lower_ux" ON "item_uoms" USING btree ("item_id",lower("uom"));--> statement-breakpoint
CREATE UNIQUE INDEX "items_code_lower_ux" ON "items" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "items_class_active_idx" ON "items" USING btree ("class","active");--> statement-breakpoint
CREATE INDEX "items_formulary_medicine_idx" ON "items" USING btree ("formulary_medicine_id");--> statement-breakpoint
CREATE INDEX "stock_balances_item_idx" ON "stock_balances" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_batches_item_batch_ownership_ux" ON "stock_batches" USING btree ("item_id",lower("batch_no"),"ownership");--> statement-breakpoint
CREATE INDEX "stock_batches_item_expiry_idx" ON "stock_batches" USING btree ("item_id","expiry_date");--> statement-breakpoint
CREATE INDEX "stock_batches_recall_idx" ON "stock_batches" USING btree ("recall_status");--> statement-breakpoint
CREATE INDEX "stock_ledger_resource_batch_idx" ON "stock_ledger" USING btree ("resource_id","batch_id","seq");--> statement-breakpoint
CREATE INDEX "stock_ledger_item_idx" ON "stock_ledger" USING btree ("item_id","seq");--> statement-breakpoint
CREATE INDEX "stock_ledger_encounter_idx" ON "stock_ledger" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "stock_reservations_resource_batch_idx" ON "stock_reservations" USING btree ("resource_id","batch_id");--> statement-breakpoint
CREATE INDEX "stock_reservations_ref_idx" ON "stock_reservations" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "transfer_lines_transfer_idx" ON "transfer_lines" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX "transfers_from_idx" ON "transfers" USING btree ("from_resource_id","status");--> statement-breakpoint
CREATE INDEX "transfers_to_idx" ON "transfers" USING btree ("to_resource_id","status");--> statement-breakpoint
CREATE INDEX "vendor_bank_changes_vendor_idx" ON "vendor_bank_changes" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "vendor_documents_vendor_type_idx" ON "vendor_documents" USING btree ("vendor_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_code_lower_ux" ON "vendors" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "vendors_status_idx" ON "vendors" USING btree ("status");