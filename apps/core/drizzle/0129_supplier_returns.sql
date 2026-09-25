CREATE TABLE "stock_recalls" (
	"id" text PRIMARY KEY NOT NULL,
	"recall_no" text NOT NULL,
	"batch_id" text NOT NULL,
	"item_id" text NOT NULL,
	"source" text NOT NULL,
	"reference" text,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"raised_by" text NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"close_note" text,
	CONSTRAINT "stock_recalls_source_ck" CHECK ("stock_recalls"."source" in ('cdsco', 'manufacturer', 'internal')),
	CONSTRAINT "stock_recalls_status_ck" CHECK ("stock_recalls"."status" in ('open', 'closed')),
	CONSTRAINT "stock_recalls_closed_ck" CHECK (("stock_recalls"."status" = 'closed') = ("stock_recalls"."closed_at" is not null) and ("stock_recalls"."closed_at" is null) = ("stock_recalls"."closed_by" is null))
);
--> statement-breakpoint
CREATE TABLE "stock_write_off_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"write_off_id" text NOT NULL,
	"item_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"qty_base" integer NOT NULL,
	"value_paise" bigint NOT NULL,
	"ledger_entry_id" text,
	CONSTRAINT "stock_write_off_lines_qty_ck" CHECK ("stock_write_off_lines"."qty_base" > 0 and "stock_write_off_lines"."value_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_write_offs" (
	"id" text PRIMARY KEY NOT NULL,
	"write_off_no" text NOT NULL,
	"store_resource_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"total_value_paise" bigint DEFAULT 0 NOT NULL,
	"approval_id" text NOT NULL,
	"disposal_agency" text,
	"manifest_no" text,
	"disposal_date" date,
	"note" text,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"posted_by" text,
	"posted_at" timestamp with time zone,
	"refused_at" timestamp with time zone,
	CONSTRAINT "stock_write_offs_reason_ck" CHECK ("stock_write_offs"."reason" in ('expiry', 'damage', 'recall')),
	CONSTRAINT "stock_write_offs_status_ck" CHECK ("stock_write_offs"."status" in ('requested', 'posted', 'refused')),
	CONSTRAINT "stock_write_offs_value_ck" CHECK ("stock_write_offs"."total_value_paise" >= 0),
	CONSTRAINT "stock_write_offs_posted_ck" CHECK (("stock_write_offs"."status" = 'posted') = ("stock_write_offs"."posted_at" is not null) and ("stock_write_offs"."posted_at" is null) = ("stock_write_offs"."posted_by" is null) and ("stock_write_offs"."status" <> 'posted' or ("stock_write_offs"."disposal_agency" is not null and "stock_write_offs"."manifest_no" is not null and "stock_write_offs"."disposal_date" is not null))),
	CONSTRAINT "stock_write_offs_refused_ck" CHECK (("stock_write_offs"."status" = 'refused') = ("stock_write_offs"."refused_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "supplier_credit_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"credit_no" text NOT NULL,
	"return_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"vendor_credit_note_no" text NOT NULL,
	"credit_note_date" date NOT NULL,
	"amount_paise" bigint NOT NULL,
	"debit_note_paise" bigint NOT NULL,
	"difference_paise" bigint NOT NULL,
	"difference_reason" text,
	"status" text NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "supplier_credit_notes_status_ck" CHECK ("supplier_credit_notes"."status" in ('accepted', 'cancelled')),
	CONSTRAINT "supplier_credit_notes_money_ck" CHECK ("supplier_credit_notes"."amount_paise" > 0 and "supplier_credit_notes"."amount_paise" <= "supplier_credit_notes"."debit_note_paise" and "supplier_credit_notes"."difference_paise" = "supplier_credit_notes"."debit_note_paise" - "supplier_credit_notes"."amount_paise"),
	CONSTRAINT "supplier_credit_notes_reason_ck" CHECK (("supplier_credit_notes"."difference_paise" = 0) = ("supplier_credit_notes"."difference_reason" is null)),
	CONSTRAINT "supplier_credit_notes_cancelled_ck" CHECK (("supplier_credit_notes"."status" = 'cancelled') = ("supplier_credit_notes"."cancelled_at" is not null) and ("supplier_credit_notes"."cancelled_at" is null) = ("supplier_credit_notes"."cancel_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "supplier_return_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"return_id" text NOT NULL,
	"item_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"store_resource_id" text NOT NULL,
	"reason" text NOT NULL,
	"qty_base" integer NOT NULL,
	"rate_paise" bigint NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"hsn_code" text,
	"ledger_entry_id" text,
	CONSTRAINT "supplier_return_lines_reason_ck" CHECK ("supplier_return_lines"."reason" in ('expired', 'near_expiry', 'damaged', 'recalled')),
	CONSTRAINT "supplier_return_lines_qty_ck" CHECK ("supplier_return_lines"."qty_base" > 0),
	CONSTRAINT "supplier_return_lines_money_ck" CHECK ("supplier_return_lines"."rate_paise" >= 0 and "supplier_return_lines"."gst_rate_bps" >= 0 and "supplier_return_lines"."taxable_paise" = "supplier_return_lines"."qty_base" * "supplier_return_lines"."rate_paise" and "supplier_return_lines"."cgst_paise" >= 0 and "supplier_return_lines"."sgst_paise" >= 0 and "supplier_return_lines"."igst_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_returns" (
	"id" text PRIMARY KEY NOT NULL,
	"return_no" text NOT NULL,
	"vendor_id" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"recall_id" text,
	"inter_state" boolean DEFAULT false NOT NULL,
	"taxable_paise" bigint DEFAULT 0 NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"note" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"dispatched_by" text,
	"dispatched_at" timestamp with time zone,
	"debit_note_no" text,
	"debit_note_date" date,
	"vendor_gstin" text,
	"credited_paise" bigint DEFAULT 0 NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_returns_status_ck" CHECK ("supplier_returns"."status" in ('draft', 'approved', 'dispatched', 'credited', 'closed', 'cancelled')),
	CONSTRAINT "supplier_returns_source_ck" CHECK ("supplier_returns"."source" in ('manual', 'agent', 'recall')),
	CONSTRAINT "supplier_returns_money_ck" CHECK ("supplier_returns"."taxable_paise" >= 0 and "supplier_returns"."cgst_paise" >= 0 and "supplier_returns"."sgst_paise" >= 0 and "supplier_returns"."igst_paise" >= 0 and "supplier_returns"."total_paise" = "supplier_returns"."taxable_paise" + "supplier_returns"."cgst_paise" + "supplier_returns"."sgst_paise" + "supplier_returns"."igst_paise"),
	CONSTRAINT "supplier_returns_tax_kind_ck" CHECK (("supplier_returns"."inter_state" and "supplier_returns"."cgst_paise" = 0 and "supplier_returns"."sgst_paise" = 0) or (not "supplier_returns"."inter_state" and "supplier_returns"."igst_paise" = 0)),
	CONSTRAINT "supplier_returns_approved_ck" CHECK (("supplier_returns"."approved_at" is null) = ("supplier_returns"."approved_by" is null) and ("supplier_returns"."status" not in ('approved', 'dispatched', 'credited', 'closed') or "supplier_returns"."approved_by" is not null)),
	CONSTRAINT "supplier_returns_dispatched_ck" CHECK (("supplier_returns"."status" in ('dispatched', 'credited', 'closed')) = ("supplier_returns"."dispatched_at" is not null) and ("supplier_returns"."dispatched_at" is null) = ("supplier_returns"."dispatched_by" is null) and ("supplier_returns"."dispatched_at" is null) = ("supplier_returns"."debit_note_no" is null) and ("supplier_returns"."debit_note_no" is null) = ("supplier_returns"."debit_note_date" is null)),
	CONSTRAINT "supplier_returns_credited_ck" CHECK ("supplier_returns"."credited_paise" >= 0 and "supplier_returns"."credited_paise" <= "supplier_returns"."total_paise" and ("supplier_returns"."status" = 'credited' or "supplier_returns"."credited_paise" = 0)),
	CONSTRAINT "supplier_returns_closed_ck" CHECK (("supplier_returns"."status" = 'closed') = ("supplier_returns"."closed_at" is not null) and ("supplier_returns"."closed_at" is null) = ("supplier_returns"."close_reason" is null) and ("supplier_returns"."closed_at" is null) = ("supplier_returns"."closed_by" is null)),
	CONSTRAINT "supplier_returns_cancelled_ck" CHECK (("supplier_returns"."status" = 'cancelled') = ("supplier_returns"."cancelled_at" is not null) and ("supplier_returns"."cancelled_at" is null) = ("supplier_returns"."cancel_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "supplier_payment_run_lines" DROP CONSTRAINT "supplier_payment_run_lines_money_ck";--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "expiry_return_days" integer;--> statement-breakpoint
ALTER TABLE "stock_recalls" ADD CONSTRAINT "stock_recalls_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_recalls" ADD CONSTRAINT "stock_recalls_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_write_off_lines" ADD CONSTRAINT "stock_write_off_lines_write_off_id_stock_write_offs_id_fk" FOREIGN KEY ("write_off_id") REFERENCES "public"."stock_write_offs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_write_off_lines" ADD CONSTRAINT "stock_write_off_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_write_off_lines" ADD CONSTRAINT "stock_write_off_lines_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_write_offs" ADD CONSTRAINT "stock_write_offs_store_resource_id_resources_id_fk" FOREIGN KEY ("store_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_return_id_supplier_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."supplier_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_return_id_supplier_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."supplier_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_store_resource_id_resources_id_fk" FOREIGN KEY ("store_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_recall_id_stock_recalls_id_fk" FOREIGN KEY ("recall_id") REFERENCES "public"."stock_recalls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_recalls_recall_no_ux" ON "stock_recalls" USING btree ("recall_no");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_recalls_open_batch_ux" ON "stock_recalls" USING btree ("batch_id") WHERE "stock_recalls"."status" = 'open';--> statement-breakpoint
CREATE INDEX "stock_recalls_status_idx" ON "stock_recalls" USING btree ("status","raised_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_write_off_lines_batch_ux" ON "stock_write_off_lines" USING btree ("write_off_id","batch_id");--> statement-breakpoint
CREATE INDEX "stock_write_off_lines_batch_idx" ON "stock_write_off_lines" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_write_offs_write_off_no_ux" ON "stock_write_offs" USING btree ("write_off_no");--> statement-breakpoint
CREATE INDEX "stock_write_offs_approval_idx" ON "stock_write_offs" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "stock_write_offs_status_idx" ON "stock_write_offs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_credit_notes_credit_no_ux" ON "supplier_credit_notes" USING btree ("credit_no");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_credit_notes_live_return_ux" ON "supplier_credit_notes" USING btree ("return_id") WHERE "supplier_credit_notes"."status" = 'accepted';--> statement-breakpoint
CREATE INDEX "supplier_credit_notes_vendor_idx" ON "supplier_credit_notes" USING btree ("vendor_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_return_lines_batch_ux" ON "supplier_return_lines" USING btree ("return_id","batch_id","store_resource_id");--> statement-breakpoint
CREATE INDEX "supplier_return_lines_batch_idx" ON "supplier_return_lines" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_returns_return_no_ux" ON "supplier_returns" USING btree ("return_no");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_returns_debit_note_no_ux" ON "supplier_returns" USING btree ("debit_note_no") WHERE "supplier_returns"."debit_note_no" is not null;--> statement-breakpoint
CREATE INDEX "supplier_returns_vendor_idx" ON "supplier_returns" USING btree ("vendor_id","status");--> statement-breakpoint
CREATE INDEX "supplier_returns_status_idx" ON "supplier_returns" USING btree ("status");--> statement-breakpoint
ALTER TABLE "supplier_payment_run_lines" ADD CONSTRAINT "supplier_payment_run_lines_money_ck" CHECK ("supplier_payment_run_lines"."pay_paise" >= 0 and "supplier_payment_run_lines"."credit_paise" >= 0 and "supplier_payment_run_lines"."pay_paise" + "supplier_payment_run_lines"."credit_paise" > 0);