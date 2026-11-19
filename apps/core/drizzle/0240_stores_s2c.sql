CREATE TABLE "stores_gate_pass_lines" (
	"pass_id" text NOT NULL,
	"line_idx" integer NOT NULL,
	"item_id" text NOT NULL,
	"qty" integer NOT NULL,
	CONSTRAINT "stores_gate_pass_lines_pass_id_line_idx_pk" PRIMARY KEY("pass_id","line_idx"),
	CONSTRAINT "stores_gate_pass_lines_qty_ck" CHECK ("stores_gate_pass_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "stores_gate_pass_scans" (
	"id" text PRIMARY KEY NOT NULL,
	"pass_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"method" text,
	"client_key" text,
	"lines" jsonb NOT NULL,
	"reason" text,
	"phone_at" timestamp with time zone,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"flag" text,
	CONSTRAINT "stores_gate_pass_scans_kind_ck" CHECK ("stores_gate_pass_scans"."kind" in ('exit', 'entry', 'close')),
	CONSTRAINT "stores_gate_pass_scans_method_ck" CHECK ("stores_gate_pass_scans"."method" is null or "stores_gate_pass_scans"."method" in ('scan', 'typed')),
	CONSTRAINT "stores_gate_pass_scans_flag_ck" CHECK ("stores_gate_pass_scans"."flag" is null or "stores_gate_pass_scans"."flag" in ('late', 'future')),
	CONSTRAINT "stores_gate_pass_scans_close_ck" CHECK ("stores_gate_pass_scans"."kind" <> 'close' or "stores_gate_pass_scans"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "stores_gate_passes" (
	"id" text PRIMARY KEY NOT NULL,
	"pass_no" text NOT NULL,
	"kind" text NOT NULL,
	"purpose" text,
	"source_store_id" text NOT NULL,
	"party" text NOT NULL,
	"due_back" date,
	"ref_type" text,
	"ref_id" text,
	"note" text,
	"raised_by" text NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_gate_passes_kind_ck" CHECK ("stores_gate_passes"."kind" in ('returnable', 'non_returnable')),
	CONSTRAINT "stores_gate_passes_purpose_ck" CHECK ("stores_gate_passes"."purpose" is null or "stores_gate_passes"."purpose" in ('repair', 'calibration', 'refill', 'loan')),
	CONSTRAINT "stores_gate_passes_ref_type_ck" CHECK ("stores_gate_passes"."ref_type" is null or "stores_gate_passes"."ref_type" in ('supplier_return', 'write_off')),
	CONSTRAINT "stores_gate_passes_shape_ck" CHECK (("stores_gate_passes"."kind" = 'returnable' and "stores_gate_passes"."purpose" is not null and "stores_gate_passes"."due_back" is not null and "stores_gate_passes"."ref_type" is null and "stores_gate_passes"."ref_id" is null)
        or ("stores_gate_passes"."kind" = 'non_returnable' and "stores_gate_passes"."purpose" is null and "stores_gate_passes"."due_back" is null and "stores_gate_passes"."ref_type" is not null and "stores_gate_passes"."ref_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "stores_gate_pass_lines" ADD CONSTRAINT "stores_gate_pass_lines_pass_id_stores_gate_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."stores_gate_passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_gate_pass_lines" ADD CONSTRAINT "stores_gate_pass_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_gate_pass_scans" ADD CONSTRAINT "stores_gate_pass_scans_pass_id_stores_gate_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."stores_gate_passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_gate_passes" ADD CONSTRAINT "stores_gate_passes_source_store_id_resources_id_fk" FOREIGN KEY ("source_store_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stores_gate_pass_lines_item_ux" ON "stores_gate_pass_lines" USING btree ("pass_id","item_id");--> statement-breakpoint
CREATE INDEX "stores_gate_pass_scans_pass_idx" ON "stores_gate_pass_scans" USING btree ("pass_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_gate_pass_scans_key_ux" ON "stores_gate_pass_scans" USING btree ("actor_id","client_key") WHERE "stores_gate_pass_scans"."client_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "stores_gate_pass_scans_exit_ux" ON "stores_gate_pass_scans" USING btree ("pass_id") WHERE "stores_gate_pass_scans"."kind" = 'exit';--> statement-breakpoint
CREATE UNIQUE INDEX "stores_gate_pass_scans_close_ux" ON "stores_gate_pass_scans" USING btree ("pass_id") WHERE "stores_gate_pass_scans"."kind" = 'close';--> statement-breakpoint
CREATE UNIQUE INDEX "stores_gate_passes_pass_no_ux" ON "stores_gate_passes" USING btree ("pass_no");--> statement-breakpoint
CREATE INDEX "stores_gate_passes_ref_idx" ON "stores_gate_passes" USING btree ("ref_type","ref_id");--> statement-breakpoint
-- ═══ STORES S2c (#1119, decision 5) — THE GATE LOG IS APPEND-ONLY, AND SO IS THE PASS (drizzle-kit emits no triggers) ═══
--
-- A scan at the gate, once written, is the record of what crossed it and when. It is never changed and never
-- deleted: a pass that should not go is closed by a new row (kind `close`, with a reason). The pass and its
-- lines are written once at raise; nothing on them is ever edited either. TRUNCATE (the test helper) does not
-- fire a row trigger.
CREATE OR REPLACE FUNCTION stores_gate_pass_scans_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stores_gate_pass_scans_append_only: a gate scan is never changed or deleted (id %)', OLD.id;
END $$;--> statement-breakpoint
CREATE TRIGGER stores_gate_pass_scans_append_only BEFORE UPDATE OR DELETE ON stores_gate_pass_scans
  FOR EACH ROW EXECUTE FUNCTION stores_gate_pass_scans_append_only();--> statement-breakpoint
CREATE OR REPLACE FUNCTION stores_gate_passes_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stores_gate_passes_append_only: a gate pass and its lines are written once (%)', TG_TABLE_NAME;
END $$;--> statement-breakpoint
CREATE TRIGGER stores_gate_passes_append_only BEFORE UPDATE OR DELETE ON stores_gate_passes
  FOR EACH ROW EXECUTE FUNCTION stores_gate_passes_append_only();--> statement-breakpoint
CREATE TRIGGER stores_gate_pass_lines_append_only BEFORE UPDATE OR DELETE ON stores_gate_pass_lines
  FOR EACH ROW EXECUTE FUNCTION stores_gate_passes_append_only();
