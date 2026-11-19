CREATE TABLE "stores_asset_unit_events" (
	"seq" bigserial NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"unit_id" text NOT NULL,
	"kind" text NOT NULL,
	"store_id" text,
	"ref_type" text,
	"ref_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_asset_unit_events_kind_ck" CHECK ("stores_asset_unit_events"."kind" in ('tagged', 'placed', 'moved', 'installed', 'out_on_pass', 'back', 'fault_reported', 'repair_opened', 'repair_closed', 'warranty_set', 'contract_set', 'calibrated', 'device_linked', 'verified_seen', 'tag_voided', 'retagged', 'condemn_proposed', 'condemn_signed', 'condemn_objected', 'condemned', 'disposed', 'corrected', 'loss_proposed', 'written_off', 'found', 'seen_elsewhere', 'transfer_proposed', 'transferred', 'regulator_paper'))
);
--> statement-breakpoint
CREATE TABLE "stores_asset_units" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"tag_no" text NOT NULL,
	"serial" text,
	"make" text,
	"model" text,
	"origin" text NOT NULL,
	"grn_line_id" text,
	"batch_id" text NOT NULL,
	"unit_cost_paise" bigint,
	"supplier_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_asset_units_origin_ck" CHECK ("stores_asset_units"."origin" in ('grn', 'opening')),
	CONSTRAINT "stores_asset_units_origin_shape_ck" CHECK (("stores_asset_units"."origin" = 'grn') = ("stores_asset_units"."grn_line_id" is not null)),
	CONSTRAINT "stores_asset_units_cost_ck" CHECK ("stores_asset_units"."unit_cost_paise" is null or "stores_asset_units"."unit_cost_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stores_asset_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"round_id" text NOT NULL,
	"kind" text NOT NULL,
	"department_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"result" jsonb,
	CONSTRAINT "stores_asset_verifications_kind_ck" CHECK ("stores_asset_verifications"."kind" in ('start', 'close')),
	CONSTRAINT "stores_asset_verifications_start_ck" CHECK ("stores_asset_verifications"."kind" <> 'start' or "stores_asset_verifications"."round_id" = "stores_asset_verifications"."id")
);
--> statement-breakpoint
CREATE TABLE "stores_tag_decisions" (
	"grn_line_id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"item_id" text NOT NULL,
	"rule" text NOT NULL,
	"unit_cost_paise" bigint NOT NULL,
	"threshold_paise" bigint NOT NULL,
	"result" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_tag_decisions_rule_ck" CHECK ("stores_tag_decisions"."rule" in ('always', 'from_value')),
	CONSTRAINT "stores_tag_decisions_result_ck" CHECK ("stores_tag_decisions"."result" in ('tagged', 'counted'))
);
--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT "items_track_mode_ck";--> statement-breakpoint
ALTER TABLE "item_categories" ADD COLUMN "tag_rule" text DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE "item_categories" ADD COLUMN "needs_calibration" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "regulated_by" text;--> statement-breakpoint
ALTER TABLE "stores_gate_pass_lines" ADD COLUMN "unit_ids" text[];--> statement-breakpoint
ALTER TABLE "stores_asset_unit_events" ADD CONSTRAINT "stores_asset_unit_events_unit_id_stores_asset_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."stores_asset_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_asset_unit_events" ADD CONSTRAINT "stores_asset_unit_events_store_id_resources_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_asset_units" ADD CONSTRAINT "stores_asset_units_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_asset_units" ADD CONSTRAINT "stores_asset_units_grn_line_id_grn_lines_id_fk" FOREIGN KEY ("grn_line_id") REFERENCES "public"."grn_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_asset_units" ADD CONSTRAINT "stores_asset_units_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_asset_units" ADD CONSTRAINT "stores_asset_units_supplier_id_vendors_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_tag_decisions" ADD CONSTRAINT "stores_tag_decisions_grn_line_id_grn_lines_id_fk" FOREIGN KEY ("grn_line_id") REFERENCES "public"."grn_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_tag_decisions" ADD CONSTRAINT "stores_tag_decisions_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_tag_decisions" ADD CONSTRAINT "stores_tag_decisions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stores_asset_unit_events_unit_idx" ON "stores_asset_unit_events" USING btree ("unit_id","seq");--> statement-breakpoint
CREATE INDEX "stores_asset_unit_events_kind_idx" ON "stores_asset_unit_events" USING btree ("kind","occurred_at");--> statement-breakpoint
CREATE INDEX "stores_asset_unit_events_ref_idx" ON "stores_asset_unit_events" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_asset_unit_events_tag_ux" ON "stores_asset_unit_events" USING btree (("data"->>'tagNo')) WHERE "stores_asset_unit_events"."kind" in ('tagged', 'retagged');--> statement-breakpoint
CREATE UNIQUE INDEX "stores_asset_units_tag_ux" ON "stores_asset_units" USING btree ("tag_no");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_asset_units_serial_ux" ON "stores_asset_units" USING btree ("item_id",lower("serial")) WHERE "stores_asset_units"."serial" is not null;--> statement-breakpoint
CREATE INDEX "stores_asset_units_batch_idx" ON "stores_asset_units" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "stores_asset_units_item_idx" ON "stores_asset_units" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_asset_verifications_round_kind_ux" ON "stores_asset_verifications" USING btree ("round_id","kind");--> statement-breakpoint
CREATE INDEX "stores_asset_verifications_dept_idx" ON "stores_asset_verifications" USING btree ("department_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_tag_decisions_batch_ux" ON "stores_tag_decisions" USING btree ("batch_id");--> statement-breakpoint
ALTER TABLE "item_categories" ADD CONSTRAINT "item_categories_tag_rule_ck" CHECK ("item_categories"."tag_rule" in ('always', 'from_value', 'never'));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_regulated_by_ck" CHECK ("items"."regulated_by" is null or "items"."regulated_by" in ('radiation', 'ultrasound'));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_track_mode_ck" CHECK ("items"."track_mode" is null or "items"."track_mode" in ('expensed', 'shelf', 'durable', 'tagged'));--> statement-breakpoint
-- ═══ STORES S4a (#1114, ruling 0099 Q3) — THE TAG RULE OF THE TWO SEEDED FROM-VALUE CATEGORIES ═══
--
-- IT and furniture are tagged from ₹5,000 a unit; every other existing category stays `never` (the column default).
-- "Medical equipment" (`MEQ`, `always`) is a NEW top category, inserted by `seedStoresMasters` on the next deploy.
-- No item, ledger or pharmacy row is touched.
UPDATE "item_categories" SET "tag_rule" = 'from_value' WHERE lower("code") IN ('itp', 'fur') AND "parent_id" IS NULL;--> statement-breakpoint
-- ═══ STORES S4a (#1114, "Audit by construction") — UNITS, THEIR EVENTS, TAG DECISIONS AND ROUNDS ARE APPEND-ONLY ═══
--
-- A unit row is written once; every later fact (a move, a fault, a new tag, a correction) is a new unit event, and a
-- correction names the event it corrects. A tag decision freezes the threshold a GRN line was judged against. A
-- verification round is a start row and a close row. None of the four is ever changed or deleted. TRUNCATE (the test
-- helper) does not fire a row trigger.
CREATE OR REPLACE FUNCTION stores_assets_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stores_assets_append_only: % is written once; a correction is a new row', TG_TABLE_NAME;
END $$;--> statement-breakpoint
CREATE TRIGGER stores_asset_units_append_only BEFORE UPDATE OR DELETE ON stores_asset_units
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_asset_unit_events_append_only BEFORE UPDATE OR DELETE ON stores_asset_unit_events
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_tag_decisions_append_only BEFORE UPDATE OR DELETE ON stores_tag_decisions
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_asset_verifications_append_only BEFORE UPDATE OR DELETE ON stores_asset_verifications
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();
