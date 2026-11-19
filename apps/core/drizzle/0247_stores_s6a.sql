CREATE TABLE "stores_bill_hold_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"hold_id" text NOT NULL,
	"step" text NOT NULL,
	"reason" text NOT NULL,
	"review_on" date,
	"as_role" text NOT NULL,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_bill_hold_steps_step_ck" CHECK ("stores_bill_hold_steps"."step" in ('released', 'kept')),
	CONSTRAINT "stores_bill_hold_steps_reason_ck" CHECK (length("stores_bill_hold_steps"."reason") > 0 and (("stores_bill_hold_steps"."step" = 'kept') = ("stores_bill_hold_steps"."review_on" is not null)))
);
--> statement-breakpoint
CREATE TABLE "stores_bill_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"bill_id" text NOT NULL,
	"kind" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"ends_at" timestamp with time zone,
	"trigger" text NOT NULL,
	"placed_by" text NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_bill_holds_kind_ck" CHECK ("stores_bill_holds"."kind" in ('duplicate_like', 'out_of_pattern', 'bank_cooling_off', 'kyc_incomplete', 'above_po', 'pay_after_grn', 'irn_missing')),
	CONSTRAINT "stores_bill_holds_ends_ck" CHECK (("stores_bill_holds"."kind" = 'bank_cooling_off') = ("stores_bill_holds"."ends_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "stores_paying_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"holds_cover_pharmacy" boolean NOT NULL,
	"msme_rule" text NOT NULL,
	"out_of_pattern_multiple_bps" integer NOT NULL,
	"first_bill_limit_paise" bigint NOT NULL,
	"dry_run_at" timestamp with time zone,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_paying_settings_msme_ck" CHECK ("stores_paying_settings"."msme_rule" in ('as_today', 'act')),
	CONSTRAINT "stores_paying_settings_limits_ck" CHECK ("stores_paying_settings"."out_of_pattern_multiple_bps" >= 10000 and "stores_paying_settings"."first_bill_limit_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "stores_service_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"ses_no" text NOT NULL,
	"purchase_order_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"department_id" text NOT NULL,
	"period_kind" text NOT NULL,
	"period_key" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"reverses_id" text,
	"note" text,
	"confirmed_by" text NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_service_entries_period_ck" CHECK ("stores_service_entries"."period_kind" in ('month', 'quarter', 'visit', 'term_start') and "stores_service_entries"."period_start" <= "stores_service_entries"."period_end"),
	CONSTRAINT "stores_service_entries_source_ck" CHECK ("stores_service_entries"."source" in ('laundry_month', 'amc_visit', 'manpower_month', 'canteen_month', 'term_start'))
);
--> statement-breakpoint
CREATE TABLE "stores_service_entry_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"ses_id" text NOT NULL,
	"item_id" text NOT NULL,
	"ordered_base" integer NOT NULL,
	"qty_base" integer NOT NULL,
	"short_reason" text,
	"rate_paise" bigint NOT NULL,
	"multiplier" integer NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	CONSTRAINT "stores_service_entry_lines_qty_ck" CHECK ("stores_service_entry_lines"."qty_base" >= 0 and "stores_service_entry_lines"."qty_base" <= "stores_service_entry_lines"."ordered_base" and "stores_service_entry_lines"."multiplier" > 0 and "stores_service_entry_lines"."rate_paise" >= 0),
	CONSTRAINT "stores_service_entry_lines_short_ck" CHECK ("stores_service_entry_lines"."qty_base" = "stores_service_entry_lines"."ordered_base" or "stores_service_entry_lines"."short_reason" is not null)
);
--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ALTER COLUMN "grn_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD COLUMN "ses_id" text;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD COLUMN "reference_checked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stores_bill_hold_steps" ADD CONSTRAINT "stores_bill_hold_steps_hold_id_stores_bill_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."stores_bill_holds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_bill_holds" ADD CONSTRAINT "stores_bill_holds_bill_id_supplier_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."supplier_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_service_entries" ADD CONSTRAINT "stores_service_entries_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_service_entries" ADD CONSTRAINT "stores_service_entries_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_service_entries" ADD CONSTRAINT "stores_service_entries_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_service_entry_lines" ADD CONSTRAINT "stores_service_entry_lines_ses_id_stores_service_entries_id_fk" FOREIGN KEY ("ses_id") REFERENCES "public"."stores_service_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_service_entry_lines" ADD CONSTRAINT "stores_service_entry_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stores_bill_hold_steps_release_ux" ON "stores_bill_hold_steps" USING btree ("hold_id") WHERE "stores_bill_hold_steps"."step" = 'released';--> statement-breakpoint
CREATE INDEX "stores_bill_holds_bill_idx" ON "stores_bill_holds" USING btree ("bill_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_paying_settings_version_ux" ON "stores_paying_settings" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_service_entries_no_ux" ON "stores_service_entries" USING btree ("ses_no");--> statement-breakpoint
CREATE INDEX "stores_service_entries_po_idx" ON "stores_service_entries" USING btree ("purchase_order_id","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_service_entry_lines_item_ux" ON "stores_service_entry_lines" USING btree ("ses_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_bill_lines_ses_item_ux" ON "supplier_bill_lines" USING btree ("bill_id","ses_id","item_id") WHERE "supplier_bill_lines"."ses_id" is not null;--> statement-breakpoint
CREATE INDEX "supplier_bill_lines_ses_idx" ON "supplier_bill_lines" USING btree ("ses_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payments_bank_reference_ux" ON "supplier_payments" USING btree ("mode","reference") WHERE "supplier_payments"."reference_checked" and "supplier_payments"."mode" in ('neft', 'rtgs', 'upi');--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_doc_ck" CHECK (("supplier_bill_lines"."grn_id" is null) <> ("supplier_bill_lines"."ses_id" is null));--> statement-breakpoint
CREATE TRIGGER stores_service_entries_append_only BEFORE UPDATE OR DELETE ON stores_service_entries
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_service_entry_lines_append_only BEFORE UPDATE OR DELETE ON stores_service_entry_lines
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_bill_holds_append_only BEFORE UPDATE OR DELETE ON stores_bill_holds
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_bill_hold_steps_append_only BEFORE UPDATE OR DELETE ON stores_bill_hold_steps
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_paying_settings_append_only BEFORE UPDATE OR DELETE ON stores_paying_settings
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();
