CREATE TABLE "stores_msme_objection_closes" (
	"id" text PRIMARY KEY NOT NULL,
	"objection_id" text NOT NULL,
	"closed_on" date NOT NULL,
	"note" text NOT NULL,
	"closed_by" text NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_msme_objection_closes_note_ck" CHECK (length("stores_msme_objection_closes"."note") > 0)
);
--> statement-breakpoint
CREATE TABLE "stores_msme_objections" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor_id" text NOT NULL,
	"grn_id" text,
	"ses_id" text,
	"kind" text NOT NULL,
	"raised_on" date NOT NULL,
	"reason" text NOT NULL,
	"raised_by" text NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_msme_objections_doc_ck" CHECK (("stores_msme_objections"."grn_id" is null) <> ("stores_msme_objections"."ses_id" is null)),
	CONSTRAINT "stores_msme_objections_kind_ck" CHECK ("stores_msme_objections"."kind" in ('qc_rejection', 'short') and length("stores_msme_objections"."reason") > 0)
);
--> statement-breakpoint
CREATE TABLE "stores_tally_ledgers" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_tally_ledgers_ck" CHECK (length("stores_tally_ledgers"."key") between 1 and 80 and length("stores_tally_ledgers"."name") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "stores_tax_table_signs" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"document_ref" text NOT NULL,
	"signed_by" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_tax_table_signs_doc_ck" CHECK (length("stores_tax_table_signs"."document_ref") > 0)
);
--> statement-breakpoint
CREATE TABLE "stores_tax_tables" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"document_ref" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_tax_tables_kind_ck" CHECK ("stores_tax_tables"."kind" in ('tds', 'gst_credit')),
	CONSTRAINT "stores_tax_tables_doc_ck" CHECK (length("stores_tax_tables"."document_ref") > 0)
);
--> statement-breakpoint
CREATE TABLE "stores_tds_certificates" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor_id" text NOT NULL,
	"number" text NOT NULL,
	"rate_bps" integer NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"document_ref" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_tds_certificates_ck" CHECK ("stores_tds_certificates"."rate_bps" between 0 and 10000 and "stores_tds_certificates"."valid_from" <= "stores_tds_certificates"."valid_to" and length("stores_tds_certificates"."document_ref") > 0)
);
--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD COLUMN "gst_credit" text;--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD COLUMN "reverse_charge" boolean;--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD COLUMN "tds_paise" bigint;--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD COLUMN "tds_nature" text;--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD COLUMN "tds_ref" text;--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD COLUMN "tds_reason" text;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD COLUMN "irn" text;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD COLUMN "tds_paise" bigint;--> statement-breakpoint
ALTER TABLE "stores_paying_settings" ADD COLUMN "tds_goods" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stores_paying_settings" ADD COLUMN "msme_traders_on_clock" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "stores_msme_objection_closes" ADD CONSTRAINT "stores_msme_objection_closes_objection_id_stores_msme_objections_id_fk" FOREIGN KEY ("objection_id") REFERENCES "public"."stores_msme_objections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_msme_objections" ADD CONSTRAINT "stores_msme_objections_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_msme_objections" ADD CONSTRAINT "stores_msme_objections_grn_id_grns_id_fk" FOREIGN KEY ("grn_id") REFERENCES "public"."grns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_tax_table_signs" ADD CONSTRAINT "stores_tax_table_signs_table_id_stores_tax_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."stores_tax_tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_tds_certificates" ADD CONSTRAINT "stores_tds_certificates_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stores_msme_objection_closes_ux" ON "stores_msme_objection_closes" USING btree ("objection_id");--> statement-breakpoint
CREATE INDEX "stores_msme_objections_grn_idx" ON "stores_msme_objections" USING btree ("grn_id");--> statement-breakpoint
CREATE INDEX "stores_msme_objections_ses_idx" ON "stores_msme_objections" USING btree ("ses_id");--> statement-breakpoint
CREATE INDEX "stores_tally_ledgers_key_idx" ON "stores_tally_ledgers" USING btree ("key","set_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_tax_table_signs_table_ux" ON "stores_tax_table_signs" USING btree ("table_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_tax_tables_version_ux" ON "stores_tax_tables" USING btree ("kind","version");--> statement-breakpoint
CREATE INDEX "stores_tds_certificates_vendor_idx" ON "stores_tds_certificates" USING btree ("vendor_id","valid_from");--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_gst_credit_ck" CHECK ("supplier_bill_lines"."gst_credit" is null or "supplier_bill_lines"."gst_credit" in ('eligible', 'not_available', 'shared'));--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_reverse_charge_ck" CHECK ("supplier_bill_lines"."reverse_charge" is not true or ("supplier_bill_lines"."cgst_paise" = 0 and "supplier_bill_lines"."sgst_paise" = 0 and "supplier_bill_lines"."igst_paise" = 0));--> statement-breakpoint
ALTER TABLE "supplier_bill_lines" ADD CONSTRAINT "supplier_bill_lines_tds_ck" CHECK ("supplier_bill_lines"."tds_paise" is null or ("supplier_bill_lines"."tds_paise" >= 0 and "supplier_bill_lines"."tds_paise" <= "supplier_bill_lines"."taxable_paise"));--> statement-breakpoint
CREATE TRIGGER stores_tax_tables_append_only BEFORE UPDATE OR DELETE ON stores_tax_tables
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_tax_table_signs_append_only BEFORE UPDATE OR DELETE ON stores_tax_table_signs
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_tds_certificates_append_only BEFORE UPDATE OR DELETE ON stores_tds_certificates
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_msme_objections_append_only BEFORE UPDATE OR DELETE ON stores_msme_objections
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_msme_objection_closes_append_only BEFORE UPDATE OR DELETE ON stores_msme_objection_closes
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_tally_ledgers_append_only BEFORE UPDATE OR DELETE ON stores_tally_ledgers
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();
