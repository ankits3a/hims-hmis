CREATE TABLE "store_indent_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"indent_id" text NOT NULL,
	"line_idx" integer NOT NULL,
	"item_id" text NOT NULL,
	"qty_base" integer NOT NULL,
	"qty_issued" integer,
	CONSTRAINT "store_indent_lines_qty_ck" CHECK ("store_indent_lines"."qty_base" > 0 and ("store_indent_lines"."qty_issued" is null or "store_indent_lines"."qty_issued" >= 0))
);
--> statement-breakpoint
CREATE TABLE "store_indents" (
	"id" text PRIMARY KEY NOT NULL,
	"indent_no" text NOT NULL,
	"from_resource_id" text NOT NULL,
	"to_resource_id" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"note" text,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	"cancel_reason" text,
	"transfer_id" text,
	CONSTRAINT "store_indents_status_ck" CHECK ("store_indents"."status" in ('requested', 'issued', 'rejected', 'cancelled')),
	CONSTRAINT "store_indents_stores_ck" CHECK ("store_indents"."from_resource_id" <> "store_indents"."to_resource_id"),
	CONSTRAINT "store_indents_issued_ck" CHECK (("store_indents"."status" = 'issued') = ("store_indents"."transfer_id" is not null)),
	CONSTRAINT "store_indents_rejected_ck" CHECK ("store_indents"."status" <> 'rejected' or "store_indents"."reject_reason" is not null),
	CONSTRAINT "store_indents_cancelled_ck" CHECK ("store_indents"."status" <> 'cancelled' or "store_indents"."cancel_reason" is not null),
	CONSTRAINT "store_indents_decided_ck" CHECK (("store_indents"."status" = 'requested') = ("store_indents"."decided_at" is null) and ("store_indents"."decided_at" is null) = ("store_indents"."decided_by" is null))
);
--> statement-breakpoint
ALTER TABLE "store_indent_lines" ADD CONSTRAINT "store_indent_lines_indent_id_store_indents_id_fk" FOREIGN KEY ("indent_id") REFERENCES "public"."store_indents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_indent_lines" ADD CONSTRAINT "store_indent_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_indents" ADD CONSTRAINT "store_indents_from_resource_id_resources_id_fk" FOREIGN KEY ("from_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_indents" ADD CONSTRAINT "store_indents_to_resource_id_resources_id_fk" FOREIGN KEY ("to_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_indents" ADD CONSTRAINT "store_indents_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_indent_lines_idx_ux" ON "store_indent_lines" USING btree ("indent_id","line_idx");--> statement-breakpoint
CREATE UNIQUE INDEX "store_indent_lines_item_ux" ON "store_indent_lines" USING btree ("indent_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_indents_indent_no_ux" ON "store_indents" USING btree ("indent_no");--> statement-breakpoint
CREATE INDEX "store_indents_to_idx" ON "store_indents" USING btree ("to_resource_id","status");--> statement-breakpoint
CREATE INDEX "store_indents_from_idx" ON "store_indents" USING btree ("from_resource_id","status");--> statement-breakpoint-- ═══ PHARMACY GAP A6b — AN INDENT IS A RECORD, HAND-CARRIED (drizzle-kit emits no triggers) ═══
--
-- An indent is never deleted and takes ONE change: requested → issued | rejected | cancelled, with who, when, the
-- transfer or the reason. What was asked, by whom, of whom, is what it was when it was raised. The 0151 shape.
CREATE OR REPLACE FUNCTION store_indent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'store_indent_immutable: an indent may not be deleted — cancel it (id %)', OLD.id;
  END IF;
  IF OLD.status <> 'requested' OR NEW.status = 'requested'
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.indent_no IS DISTINCT FROM OLD.indent_no
     OR NEW.from_resource_id IS DISTINCT FROM OLD.from_resource_id OR NEW.to_resource_id IS DISTINCT FROM OLD.to_resource_id
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'store_indent_immutable: an indent takes one change, its decision, once (id %)', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER store_indents_guard
  BEFORE UPDATE OR DELETE ON store_indents
  FOR EACH ROW EXECUTE FUNCTION store_indent_guard();--> statement-breakpoint
-- A line is never deleted, and the ONLY change it takes is the quantity issued against it, once, from null.
CREATE OR REPLACE FUNCTION store_indent_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'store_indent_immutable: an indent line may not be deleted (id %)', OLD.id;
  END IF;
  IF OLD.qty_issued IS NOT NULL OR NEW.qty_issued IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.indent_id IS DISTINCT FROM OLD.indent_id OR NEW.line_idx IS DISTINCT FROM OLD.line_idx
     OR NEW.item_id IS DISTINCT FROM OLD.item_id OR NEW.qty_base IS DISTINCT FROM OLD.qty_base THEN
    RAISE EXCEPTION 'store_indent_immutable: an indent line takes one change, the quantity issued, once (id %)', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER store_indent_lines_guard
  BEFORE UPDATE OR DELETE ON store_indent_lines
  FOR EACH ROW EXECUTE FUNCTION store_indent_line_guard();
