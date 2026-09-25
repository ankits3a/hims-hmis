CREATE TABLE "supplier_bill_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"bill_id" text NOT NULL,
	"grn_id" text NOT NULL,
	"item_id" text NOT NULL,
	"uom" text NOT NULL,
	"multiplier" integer NOT NULL,
	"qty_packs" integer NOT NULL,
	"rate_paise" bigint NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"expected_base" integer NOT NULL,
	"expected_rate_paise" bigint NOT NULL,
	"expected_taxable_paise" bigint NOT NULL,
	"expected_gst_rate_bps" integer NOT NULL,
	"mismatch" text,
	CONSTRAINT "supplier_bill_lines_qty_ck" CHECK ("supplier_bill_lines"."qty_packs" >= 0 and "supplier_bill_lines"."multiplier" > 0 and "supplier_bill_lines"."expected_base" >= 0),
	CONSTRAINT "supplier_bill_lines_money_ck" CHECK ("supplier_bill_lines"."rate_paise" >= 0 and "supplier_bill_lines"."gst_rate_bps" >= 0 and "supplier_bill_lines"."taxable_paise" = "supplier_bill_lines"."qty_packs" * "supplier_bill_lines"."rate_paise")
);
--> statement-breakpoint
CREATE TABLE "supplier_bills" (
	"id" text PRIMARY KEY NOT NULL,
	"bill_no" text NOT NULL,
	"vendor_id" text NOT NULL,
	"vendor_bill_no" text NOT NULL,
	"vendor_bill_key" text NOT NULL,
	"bill_date" date NOT NULL,
	"fy" text NOT NULL,
	"purchase_order_id" text,
	"status" text NOT NULL,
	"inter_state" boolean DEFAULT false NOT NULL,
	"taxable_paise" bigint DEFAULT 0 NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"round_off_paise" integer DEFAULT 0 NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"expected_total_paise" bigint DEFAULT 0 NOT NULL,
	"held_reason" text,
	"matched_at" timestamp with time zone,
	"difference_accepted_by" text,
	"difference_reason" text,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"acceptance_date" date,
	"msme" boolean DEFAULT false NOT NULL,
	"terms_days" integer,
	"due_date" date,
	"paid_paise" bigint DEFAULT 0 NOT NULL,
	"note" text,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_bills_status_ck" CHECK ("supplier_bills"."status" in ('draft', 'matched', 'held_for_match', 'accepted', 'part_paid', 'paid', 'cancelled')),
	CONSTRAINT "supplier_bills_money_ck" CHECK ("supplier_bills"."taxable_paise" >= 0 and "supplier_bills"."cgst_paise" >= 0 and "supplier_bills"."sgst_paise" >= 0 and "supplier_bills"."igst_paise" >= 0 and "supplier_bills"."round_off_paise" between -99 and 99 and "supplier_bills"."total_paise" = "supplier_bills"."taxable_paise" + "supplier_bills"."cgst_paise" + "supplier_bills"."sgst_paise" + "supplier_bills"."igst_paise" + "supplier_bills"."round_off_paise"),
	CONSTRAINT "supplier_bills_tax_kind_ck" CHECK (("supplier_bills"."inter_state" and "supplier_bills"."cgst_paise" = 0 and "supplier_bills"."sgst_paise" = 0) or (not "supplier_bills"."inter_state" and "supplier_bills"."igst_paise" = 0)),
	CONSTRAINT "supplier_bills_paid_ck" CHECK ("supplier_bills"."paid_paise" >= 0 and "supplier_bills"."paid_paise" <= "supplier_bills"."total_paise"),
	CONSTRAINT "supplier_bills_accepted_ck" CHECK ("supplier_bills"."status" not in ('accepted', 'part_paid', 'paid') or ("supplier_bills"."accepted_by" is not null and "supplier_bills"."due_date" is not null)),
	CONSTRAINT "supplier_bills_difference_ck" CHECK (("supplier_bills"."difference_accepted_by" is null) = ("supplier_bills"."difference_reason" is null)),
	CONSTRAINT "supplier_bills_cancelled_ck" CHECK (("supplier_bills"."status" = 'cancelled') = ("supplier_bills"."cancelled_at" is not null) and ("supplier_bills"."cancelled_at" is null) = ("supplier_bills"."cancel_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "supplier_payment_run_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"bill_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"pay_paise" bigint NOT NULL,
	"credit_paise" bigint DEFAULT 0 NOT NULL,
	"payment_id" text,
	CONSTRAINT "supplier_payment_run_lines_money_ck" CHECK ("supplier_payment_run_lines"."pay_paise" > 0 and "supplier_payment_run_lines"."credit_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_payment_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_no" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"note" text,
	"approval_id" text,
	"submitted_at" timestamp with time zone,
	"authorised_by" text,
	"authorised_at" timestamp with time zone,
	"rejection_note" text,
	"completed_at" timestamp with time zone,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_payment_runs_status_ck" CHECK ("supplier_payment_runs"."status" in ('draft', 'pending_authorisation', 'authorised', 'completed', 'cancelled')),
	CONSTRAINT "supplier_payment_runs_source_ck" CHECK ("supplier_payment_runs"."source" in ('manual', 'agent')),
	CONSTRAINT "supplier_payment_runs_total_ck" CHECK ("supplier_payment_runs"."total_paise" >= 0),
	CONSTRAINT "supplier_payment_runs_authorised_ck" CHECK (("supplier_payment_runs"."authorised_at" is null) = ("supplier_payment_runs"."authorised_by" is null) and ("supplier_payment_runs"."status" not in ('authorised', 'completed') or "supplier_payment_runs"."authorised_by" is not null)),
	CONSTRAINT "supplier_payment_runs_cancelled_ck" CHECK (("supplier_payment_runs"."status" = 'cancelled') = ("supplier_payment_runs"."cancelled_at" is not null) and ("supplier_payment_runs"."cancelled_at" is null) = ("supplier_payment_runs"."cancel_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_no" text NOT NULL,
	"run_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"mode" text NOT NULL,
	"reference" text,
	"paid_on" date NOT NULL,
	"amount_paise" bigint NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_payments_mode_ck" CHECK ("supplier_payments"."mode" in ('neft', 'rtgs', 'upi', 'cheque', 'cash')),
	CONSTRAINT "supplier_payments_reference_ck" CHECK ("supplier_payments"."mode" = 'cash' or "supplier_payments"."reference" is not null),
	CONSTRAINT "supplier_payments_amount_ck" CHECK ("supplier_payments"."amount_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_bill_id_supplier_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."supplier_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_grn_id_grns_id_fk" FOREIGN KEY ("grn_id") REFERENCES "public"."grns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_run_lines" ADD CONSTRAINT "supplier_payment_run_lines_run_id_supplier_payment_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."supplier_payment_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_run_lines" ADD CONSTRAINT "supplier_payment_run_lines_bill_id_supplier_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."supplier_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_run_lines" ADD CONSTRAINT "supplier_payment_run_lines_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_run_lines" ADD CONSTRAINT "supplier_payment_run_lines_payment_id_supplier_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_run_id_supplier_payment_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."supplier_payment_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_bill_lines_grn_item_ux" ON "supplier_bill_lines" USING btree ("bill_id","grn_id","item_id");--> statement-breakpoint
CREATE INDEX "supplier_bill_lines_grn_idx" ON "supplier_bill_lines" USING btree ("grn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_bills_bill_no_ux" ON "supplier_bills" USING btree ("bill_no");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_bills_vendor_key_fy_ux" ON "supplier_bills" USING btree ("vendor_id","vendor_bill_key","fy") WHERE "supplier_bills"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "supplier_bills_vendor_idx" ON "supplier_bills" USING btree ("vendor_id","status");--> statement-breakpoint
CREATE INDEX "supplier_bills_status_due_idx" ON "supplier_bills" USING btree ("status","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payment_run_lines_bill_ux" ON "supplier_payment_run_lines" USING btree ("run_id","bill_id");--> statement-breakpoint
CREATE INDEX "supplier_payment_run_lines_bill_idx" ON "supplier_payment_run_lines" USING btree ("bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payment_runs_run_no_ux" ON "supplier_payment_runs" USING btree ("run_no");--> statement-breakpoint
CREATE INDEX "supplier_payment_runs_status_idx" ON "supplier_payment_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payments_payment_no_ux" ON "supplier_payments" USING btree ("payment_no");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payments_run_vendor_ux" ON "supplier_payments" USING btree ("run_id","vendor_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_vendor_idx" ON "supplier_payments" USING btree ("vendor_id","paid_on");