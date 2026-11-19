CREATE TABLE "stores_condemnation_signatures" (
	"id" text PRIMARY KEY NOT NULL,
	"condemnation_id" text NOT NULL,
	"seat" text NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_condemnation_signatures_seat_ck" CHECK ("stores_condemnation_signatures"."seat" in ('hod', 'accounts', 'materials', 'biomedical')),
	CONSTRAINT "stores_condemnation_signatures_kind_ck" CHECK ("stores_condemnation_signatures"."kind" in ('sign', 'object')),
	CONSTRAINT "stores_condemnation_signatures_reason_ck" CHECK ("stores_condemnation_signatures"."kind" <> 'object' or "stores_condemnation_signatures"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "stores_condemnation_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"condemnation_id" text NOT NULL,
	"kind" text NOT NULL,
	"write_off_id" text,
	"owner_approval_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_condemnation_steps_kind_ck" CHECK ("stores_condemnation_steps"."kind" in ('raised', 'approved', 'rejected', 'posted'))
);
--> statement-breakpoint
CREATE TABLE "stores_condemnations" (
	"id" text PRIMARY KEY NOT NULL,
	"cond_no" text NOT NULL,
	"unit_id" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"department_id" text,
	"seats" text[] NOT NULL,
	"holds_data" boolean DEFAULT false NOT NULL,
	"cost_paise" bigint,
	"needs_owner" boolean NOT NULL,
	"replaces_id" text,
	"round_id" text,
	"proposed_by" text NOT NULL,
	"proposed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_condemnations_kind_ck" CHECK ("stores_condemnations"."kind" in ('condemn', 'loss')),
	CONSTRAINT "stores_condemnations_reason_ck" CHECK ("stores_condemnations"."reason" in ('beyond_repair', 'obsolete', 'damaged', 'lost')),
	CONSTRAINT "stores_condemnations_loss_ck" CHECK ("stores_condemnations"."kind" <> 'loss' or "stores_condemnations"."reason" = 'lost')
);
--> statement-breakpoint
CREATE TABLE "stores_scrap_sales" (
	"id" text PRIMARY KEY NOT NULL,
	"condemnation_id" text NOT NULL,
	"unit_id" text NOT NULL,
	"method" text NOT NULL,
	"buyer_id" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"invoice_no" text NOT NULL,
	"receipt_ref" text,
	"bids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"po_ref" text,
	"certificate_no" text,
	"wipe_certificate_no" text,
	"write_off_id" text NOT NULL,
	"recorded_by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_scrap_sales_method_ck" CHECK ("stores_scrap_sales"."method" in ('scrap_sale', 'buy_back', 'e_waste')),
	CONSTRAINT "stores_scrap_sales_amount_ck" CHECK ("stores_scrap_sales"."amount_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "stock_write_offs" DROP CONSTRAINT "stock_write_offs_reason_ck";--> statement-breakpoint
ALTER TABLE "stores_gate_passes" DROP CONSTRAINT "stores_gate_passes_ref_type_ck";--> statement-breakpoint
ALTER TABLE "stores_condemnation_signatures" ADD CONSTRAINT "stores_condemnation_signatures_condemnation_id_stores_condemnations_id_fk" FOREIGN KEY ("condemnation_id") REFERENCES "public"."stores_condemnations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_condemnation_steps" ADD CONSTRAINT "stores_condemnation_steps_condemnation_id_stores_condemnations_id_fk" FOREIGN KEY ("condemnation_id") REFERENCES "public"."stores_condemnations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_condemnations" ADD CONSTRAINT "stores_condemnations_unit_id_stores_asset_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."stores_asset_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_scrap_sales" ADD CONSTRAINT "stores_scrap_sales_condemnation_id_stores_condemnations_id_fk" FOREIGN KEY ("condemnation_id") REFERENCES "public"."stores_condemnations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_scrap_sales" ADD CONSTRAINT "stores_scrap_sales_unit_id_stores_asset_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."stores_asset_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_scrap_sales" ADD CONSTRAINT "stores_scrap_sales_buyer_id_vendors_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stores_condemnation_signatures_seat_ux" ON "stores_condemnation_signatures" USING btree ("condemnation_id","seat");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_condemnation_signatures_actor_ux" ON "stores_condemnation_signatures" USING btree ("condemnation_id","actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_condemnation_steps_kind_ux" ON "stores_condemnation_steps" USING btree ("condemnation_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_condemnations_no_ux" ON "stores_condemnations" USING btree ("cond_no");--> statement-breakpoint
CREATE INDEX "stores_condemnations_unit_idx" ON "stores_condemnations" USING btree ("unit_id","proposed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_scrap_sales_condemnation_ux" ON "stores_scrap_sales" USING btree ("condemnation_id");--> statement-breakpoint
CREATE INDEX "stores_scrap_sales_unit_idx" ON "stores_scrap_sales" USING btree ("unit_id");--> statement-breakpoint
ALTER TABLE "stock_write_offs" ADD CONSTRAINT "stock_write_offs_reason_ck" CHECK ("stock_write_offs"."reason" in ('expiry', 'damage', 'recall', 'condemned'));--> statement-breakpoint
ALTER TABLE "stores_gate_passes" ADD CONSTRAINT "stores_gate_passes_ref_type_ck" CHECK ("stores_gate_passes"."ref_type" is null or "stores_gate_passes"."ref_type" in ('supplier_return', 'write_off', 'scrap_sale'));--> statement-breakpoint
-- ═══ STORES S4b (#1114, "Audit by construction") — PROPOSALS, SIGNATURES, STEPS AND DISPOSALS ARE APPEND-ONLY ═══
--
-- A condemnation or loss proposal is written once; each seat's signature or objection, each step after the seats
-- (raised, approved, rejected, posted) and each disposal is a new row. Nothing is ever changed or deleted: a fresh
-- proposal names the one it follows. The two CHECK changes above only ADD a value (`condemned` on the write-off
-- reason, `scrap_sale` on a gate pass's record); no existing row is touched, and pharmacy never sends `condemned`
-- (materials refuses it off a Stores place). TRUNCATE (the test helper) does not fire a row trigger.
CREATE TRIGGER stores_condemnations_append_only BEFORE UPDATE OR DELETE ON stores_condemnations
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_condemnation_signatures_append_only BEFORE UPDATE OR DELETE ON stores_condemnation_signatures
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_condemnation_steps_append_only BEFORE UPDATE OR DELETE ON stores_condemnation_steps
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_scrap_sales_append_only BEFORE UPDATE OR DELETE ON stores_scrap_sales
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();
