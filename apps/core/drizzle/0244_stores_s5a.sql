CREATE TABLE "stores_delegations" (
	"id" text PRIMARY KEY NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text NOT NULL,
	"scope" text NOT NULL,
	"department_id" text,
	"from_at" timestamp with time zone NOT NULL,
	"to_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_delegations_scope_ck" CHECK ("stores_delegations"."scope" in ('hod_approval')),
	CONSTRAINT "stores_delegations_window_ck" CHECK ("stores_delegations"."to_at" > "stores_delegations"."from_at" and "stores_delegations"."to_at" <= "stores_delegations"."from_at" + interval '30 days'),
	CONSTRAINT "stores_delegations_self_ck" CHECK ("stores_delegations"."from_user_id" <> "stores_delegations"."to_user_id"),
	CONSTRAINT "stores_delegations_dept_ck" CHECK ("stores_delegations"."scope" <> 'hod_approval' or "stores_delegations"."department_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "stores_department_budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"department_id" text NOT NULL,
	"month" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"note" text,
	"set_by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_department_budgets_month_ck" CHECK ("stores_department_budgets"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "stores_department_budgets_amount_ck" CHECK ("stores_department_budgets"."amount_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stores_over_budget_marks" (
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"department_id" text NOT NULL,
	"month" text NOT NULL,
	"pct" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_over_budget_marks_ref_type_ref_id_pk" PRIMARY KEY("ref_type","ref_id"),
	CONSTRAINT "stores_over_budget_marks_ref_ck" CHECK ("stores_over_budget_marks"."ref_type" in ('ticket'))
);
--> statement-breakpoint
CREATE TABLE "stores_pr_band_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"pr_id" text NOT NULL,
	"band" text NOT NULL,
	"reason" text NOT NULL,
	"set_by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_pr_band_settings_band_ck" CHECK ("stores_pr_band_settings"."band" in ('A', 'B', 'C'))
);
--> statement-breakpoint
CREATE TABLE "stores_purchase_request_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"pr_id" text NOT NULL,
	"line_idx" integer NOT NULL,
	"item_id" text NOT NULL,
	"category_id" text,
	"qty_base" integer NOT NULL,
	"unit_estimate_paise" bigint NOT NULL,
	"estimate_source" text NOT NULL,
	"on_contract" boolean DEFAULT false NOT NULL,
	"equipment" boolean DEFAULT false NOT NULL,
	"answers" jsonb,
	CONSTRAINT "stores_purchase_request_lines_qty_ck" CHECK ("stores_purchase_request_lines"."qty_base" > 0),
	CONSTRAINT "stores_purchase_request_lines_estimate_ck" CHECK ("stores_purchase_request_lines"."unit_estimate_paise" >= 0),
	CONSTRAINT "stores_purchase_request_lines_source_ck" CHECK ("stores_purchase_request_lines"."estimate_source" in ('contract', 'last', 'requester')),
	CONSTRAINT "stores_purchase_request_lines_answers_ck" CHECK (not "stores_purchase_request_lines"."equipment" or "stores_purchase_request_lines"."answers" is not null)
);
--> statement-breakpoint
CREATE TABLE "stores_purchase_request_stamps" (
	"id" text PRIMARY KEY NOT NULL,
	"pr_id" text NOT NULL,
	"kind" text NOT NULL,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"reason" text,
	"for_role" text,
	"on_behalf_of" text,
	"delegation_id" text,
	"over_budget" boolean DEFAULT false NOT NULL,
	"budget_pct" integer,
	CONSTRAINT "stores_purchase_request_stamps_kind_ck" CHECK ("stores_purchase_request_stamps"."kind" in ('approved', 'declined', 'cancelled')),
	CONSTRAINT "stores_purchase_request_stamps_role_ck" CHECK ("stores_purchase_request_stamps"."for_role" is null or "stores_purchase_request_stamps"."for_role" in ('hod', 'ms', 'delegate', 'materials')),
	CONSTRAINT "stores_purchase_request_stamps_reason_ck" CHECK ("stores_purchase_request_stamps"."kind" <> 'declined' or "stores_purchase_request_stamps"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "stores_purchase_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"pr_no" text NOT NULL,
	"source" text NOT NULL,
	"department_id" text,
	"shelf_id" text,
	"priority" text NOT NULL,
	"note" text,
	"raised_by" text NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_purchase_requests_source_ck" CHECK ("stores_purchase_requests"."source" in ('department', 'central', 'planner', 'copilot')),
	CONSTRAINT "stores_purchase_requests_priority_ck" CHECK ("stores_purchase_requests"."priority" in ('routine', 'urgent', 'emergency')),
	CONSTRAINT "stores_purchase_requests_dept_ck" CHECK ("stores_purchase_requests"."source" <> 'department' or "stores_purchase_requests"."department_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "stores_vendor_category_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor_id" text NOT NULL,
	"category_id" text NOT NULL,
	"approved_by" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vendor_documents" DROP CONSTRAINT "vendor_documents_type_ck";--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "msme_activity" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "einvoice_applicable" boolean;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "gst_unregistered_reason" text;--> statement-breakpoint
ALTER TABLE "stores_delegations" ADD CONSTRAINT "stores_delegations_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_department_budgets" ADD CONSTRAINT "stores_department_budgets_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_pr_band_settings" ADD CONSTRAINT "stores_pr_band_settings_pr_id_stores_purchase_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."stores_purchase_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_purchase_request_lines" ADD CONSTRAINT "stores_purchase_request_lines_pr_id_stores_purchase_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."stores_purchase_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_purchase_request_lines" ADD CONSTRAINT "stores_purchase_request_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_purchase_request_lines" ADD CONSTRAINT "stores_purchase_request_lines_category_id_item_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."item_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_purchase_request_stamps" ADD CONSTRAINT "stores_purchase_request_stamps_pr_id_stores_purchase_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."stores_purchase_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_purchase_requests" ADD CONSTRAINT "stores_purchase_requests_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_purchase_requests" ADD CONSTRAINT "stores_purchase_requests_shelf_id_resources_id_fk" FOREIGN KEY ("shelf_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_vendor_category_approvals" ADD CONSTRAINT "stores_vendor_category_approvals_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_vendor_category_approvals" ADD CONSTRAINT "stores_vendor_category_approvals_category_id_item_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."item_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stores_delegations_to_idx" ON "stores_delegations" USING btree ("to_user_id","to_at");--> statement-breakpoint
CREATE INDEX "stores_department_budgets_dept_month_idx" ON "stores_department_budgets" USING btree ("department_id","month","at");--> statement-breakpoint
CREATE INDEX "stores_pr_band_settings_pr_idx" ON "stores_pr_band_settings" USING btree ("pr_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_purchase_request_lines_ux" ON "stores_purchase_request_lines" USING btree ("pr_id","line_idx");--> statement-breakpoint
CREATE INDEX "stores_purchase_request_lines_item_idx" ON "stores_purchase_request_lines" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_purchase_request_stamps_pr_ux" ON "stores_purchase_request_stamps" USING btree ("pr_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_purchase_requests_no_ux" ON "stores_purchase_requests" USING btree ("pr_no");--> statement-breakpoint
CREATE INDEX "stores_purchase_requests_dept_idx" ON "stores_purchase_requests" USING btree ("department_id","raised_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_vendor_category_approvals_ux" ON "stores_vendor_category_approvals" USING btree ("vendor_id","category_id");--> statement-breakpoint
ALTER TABLE "vendor_documents" ADD CONSTRAINT "vendor_documents_type_ck" CHECK ("vendor_documents"."type" in ('drug_licence_20b', 'drug_licence_21b', 'gst_certificate', 'pan', 'cancelled_cheque', 'udyam', 'dpdp_processor_agreement', 'consignment_agreement', 'iso', 'aerb_type_approval', 'payment_terms_agreement'));--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_msme_activity_ck" CHECK ("vendors"."msme_activity" is null or "vendors"."msme_activity" in ('maker', 'service', 'trader'));--> statement-breakpoint
-- ═══ STORES S5a (#1115, "Audit by construction") — REQUESTS, LINES, STAMPS, BUDGETS, MARKS, DELEGATIONS ARE WRITTEN ONCE ═══
--
-- A purchase request and its lines are written once; its decision is ONE stamp row (unique per request: approved,
-- declined or cancelled) and a later decision is refused by the unique index, so the stamp is write-once. A band
-- lifted by the buyer, a budget change, an over-budget mark on a ticket, a delegation and a supplier's category
-- approval are each a new row. Nothing here is ever changed or deleted (the 0242 function). The vendor columns are
-- nullable and the document type CHECK only ADDS a value: no existing pharmacy row is touched. TRUNCATE (the test
-- helper) does not fire a row trigger.
CREATE TRIGGER stores_purchase_requests_append_only BEFORE UPDATE OR DELETE ON stores_purchase_requests
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_purchase_request_lines_append_only BEFORE UPDATE OR DELETE ON stores_purchase_request_lines
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_purchase_request_stamps_append_only BEFORE UPDATE OR DELETE ON stores_purchase_request_stamps
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_pr_band_settings_append_only BEFORE UPDATE OR DELETE ON stores_pr_band_settings
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_department_budgets_append_only BEFORE UPDATE OR DELETE ON stores_department_budgets
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_over_budget_marks_append_only BEFORE UPDATE OR DELETE ON stores_over_budget_marks
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_delegations_append_only BEFORE UPDATE OR DELETE ON stores_delegations
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_vendor_category_approvals_append_only BEFORE UPDATE OR DELETE ON stores_vendor_category_approvals
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();
