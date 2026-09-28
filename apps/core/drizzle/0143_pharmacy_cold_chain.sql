CREATE TABLE "pharmacy_cold_excursion_batches" (
	"excursion_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"item_id" text NOT NULL,
	"qty_on_hand" integer NOT NULL,
	CONSTRAINT "pharmacy_cold_excursion_batches_pk" PRIMARY KEY("excursion_id","batch_id"),
	CONSTRAINT "pharmacy_cold_excursion_batches_qty_ck" CHECK ("pharmacy_cold_excursion_batches"."qty_on_hand" > 0)
);
--> statement-breakpoint
CREATE TABLE "pharmacy_cold_excursion_closes" (
	"excursion_id" text PRIMARY KEY NOT NULL,
	"note" text,
	"closed_by" text NOT NULL,
	"closed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pharmacy_cold_excursion_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"excursion_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"write_off_id" text,
	"decided_by" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pharmacy_cold_excursion_decisions_decision_ck" CHECK (decision in ('release', 'write_off')),
	CONSTRAINT "pharmacy_cold_excursion_decisions_shape_ck" CHECK ((decision = 'release') = (reason is not null and btrim(reason) <> '') and (decision = 'write_off') = (write_off_id is not null))
);
--> statement-breakpoint
CREATE TABLE "pharmacy_cold_excursions" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"unit_id" text NOT NULL,
	"store_resource_id" text NOT NULL,
	"reading_id" text NOT NULL,
	"low_c" numeric(4, 1) NOT NULL,
	"high_c" numeric(4, 1) NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pharmacy_cold_readings" (
	"id" text PRIMARY KEY NOT NULL,
	"unit_id" text NOT NULL,
	"current_c" numeric(4, 1) NOT NULL,
	"min_c" numeric(4, 1) NOT NULL,
	"max_c" numeric(4, 1) NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"taken_by" text NOT NULL,
	"note" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pharmacy_cold_readings_order_ck" CHECK (min_c <= current_c and current_c <= max_c),
	CONSTRAINT "pharmacy_cold_readings_bounds_ck" CHECK (min_c between -50 and 60 and max_c between -50 and 60)
);
--> statement-breakpoint
CREATE TABLE "pharmacy_cold_units" (
	"id" text PRIMARY KEY NOT NULL,
	"store_resource_id" text NOT NULL,
	"label" text NOT NULL,
	"low_c" numeric(4, 1) DEFAULT '2.0' NOT NULL,
	"high_c" numeric(4, 1) DEFAULT '8.0' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone,
	CONSTRAINT "pharmacy_cold_units_label_ck" CHECK (btrim("pharmacy_cold_units"."label") <> ''),
	CONSTRAINT "pharmacy_cold_units_range_ck" CHECK (low_c < high_c and low_c between -50 and 60 and high_c between -50 and 60)
);
--> statement-breakpoint
ALTER TABLE "pharmacy_cold_excursion_batches" ADD CONSTRAINT "pharmacy_cold_excursion_batches_excursion_id_pharmacy_cold_excursions_id_fk" FOREIGN KEY ("excursion_id") REFERENCES "public"."pharmacy_cold_excursions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_cold_excursion_batches" ADD CONSTRAINT "pharmacy_cold_excursion_batches_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_cold_excursion_batches" ADD CONSTRAINT "pharmacy_cold_excursion_batches_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_cold_excursion_closes" ADD CONSTRAINT "pharmacy_cold_excursion_closes_excursion_id_pharmacy_cold_excursions_id_fk" FOREIGN KEY ("excursion_id") REFERENCES "public"."pharmacy_cold_excursions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_cold_excursion_closes" ADD CONSTRAINT "pharmacy_cold_excursion_closes_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_cold_excursion_decisions" ADD CONSTRAINT "pharmacy_cold_excursion_decisions_write_off_id_stock_write_offs_id_fk" FOREIGN KEY ("write_off_id") REFERENCES "public"."stock_write_offs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_cold_excursion_decisions" ADD CONSTRAINT "pharmacy_cold_excursion_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_cold_excursion_decisions" ADD CONSTRAINT "pharmacy_cold_excursion_decisions_batch_fk" FOREIGN KEY ("excursion_id","batch_id") REFERENCES "public"."pharmacy_cold_excursion_batches"("excursion_id","batch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_cold_excursions" ADD CONSTRAINT "pharmacy_cold_excursions_unit_id_pharmacy_cold_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."pharmacy_cold_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_cold_excursions" ADD CONSTRAINT "pharmacy_cold_excursions_store_resource_id_resources_id_fk" FOREIGN KEY ("store_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_cold_excursions" ADD CONSTRAINT "pharmacy_cold_excursions_reading_id_pharmacy_cold_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."pharmacy_cold_readings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_cold_readings" ADD CONSTRAINT "pharmacy_cold_readings_unit_id_pharmacy_cold_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."pharmacy_cold_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_cold_readings" ADD CONSTRAINT "pharmacy_cold_readings_taken_by_users_id_fk" FOREIGN KEY ("taken_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_cold_units" ADD CONSTRAINT "pharmacy_cold_units_store_resource_id_resources_id_fk" FOREIGN KEY ("store_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_cold_units" ADD CONSTRAINT "pharmacy_cold_units_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_cold_units" ADD CONSTRAINT "pharmacy_cold_units_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pharmacy_cold_excursion_batches_batch_idx" ON "pharmacy_cold_excursion_batches" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_cold_excursion_decisions_batch_ux" ON "pharmacy_cold_excursion_decisions" USING btree ("excursion_id","batch_id");--> statement-breakpoint
CREATE INDEX "pharmacy_cold_excursion_decisions_held_idx" ON "pharmacy_cold_excursion_decisions" USING btree ("batch_id") WHERE decision = 'write_off';--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_cold_excursions_seq_ux" ON "pharmacy_cold_excursions" USING btree ("seq");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_cold_excursions_reading_ux" ON "pharmacy_cold_excursions" USING btree ("reading_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_cold_excursions_open_ux" ON "pharmacy_cold_excursions" USING btree ("unit_id") WHERE closed_at is null;--> statement-breakpoint
CREATE INDEX "pharmacy_cold_excursions_store_idx" ON "pharmacy_cold_excursions" USING btree ("store_resource_id");--> statement-breakpoint
CREATE INDEX "pharmacy_cold_readings_unit_taken_idx" ON "pharmacy_cold_readings" USING btree ("unit_id","taken_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_cold_units_store_label_ux" ON "pharmacy_cold_units" USING btree ("store_resource_id",lower("label"));--> statement-breakpoint
-- ═══ PHARMACY STAGE D3 — THE FRIDGE LOG IS APPEND-ONLY, HAND-CARRIED (drizzle-kit emits no triggers) ═══
--
-- D&C Rules 1945 / NABH MOM: a temperature once read is a record. A wrong reading is answered by a
-- further reading with a note, never by an edit. The frozen list of held batches, the close and each
-- batch's decision are records too. The D1/D2 shape: one function refuses UPDATE and DELETE on all four.
CREATE OR REPLACE FUNCTION pharmacy_cold_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy_cold_chain_immutable: a % row may not be deleted', TG_TABLE_NAME;
  END IF;
  RAISE EXCEPTION 'pharmacy_cold_chain_immutable: a % row may not be edited — a later reading or act is a new row, never an edit', TG_TABLE_NAME;
END $$;--> statement-breakpoint
CREATE TRIGGER pharmacy_cold_readings_immutable
  BEFORE UPDATE OR DELETE ON pharmacy_cold_readings
  FOR EACH ROW EXECUTE FUNCTION pharmacy_cold_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER pharmacy_cold_excursion_batches_immutable
  BEFORE UPDATE OR DELETE ON pharmacy_cold_excursion_batches
  FOR EACH ROW EXECUTE FUNCTION pharmacy_cold_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER pharmacy_cold_excursion_closes_immutable
  BEFORE UPDATE OR DELETE ON pharmacy_cold_excursion_closes
  FOR EACH ROW EXECUTE FUNCTION pharmacy_cold_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER pharmacy_cold_excursion_decisions_immutable
  BEFORE UPDATE OR DELETE ON pharmacy_cold_excursion_decisions
  FOR EACH ROW EXECUTE FUNCTION pharmacy_cold_forbid_mutation();--> statement-breakpoint
-- An excursion is never deleted, and the ONLY change it takes is `closed_at`, once, from null: the
-- status-column exception of stage D's shared rules. Everything else about it is what was true when it opened.
CREATE OR REPLACE FUNCTION pharmacy_cold_excursion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy_cold_chain_immutable: an excursion may not be deleted (id %)', OLD.id;
  END IF;
  IF OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.unit_id IS DISTINCT FROM OLD.unit_id
     OR NEW.store_resource_id IS DISTINCT FROM OLD.store_resource_id OR NEW.reading_id IS DISTINCT FROM OLD.reading_id
     OR NEW.low_c IS DISTINCT FROM OLD.low_c OR NEW.high_c IS DISTINCT FROM OLD.high_c OR NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
    RAISE EXCEPTION 'pharmacy_cold_chain_immutable: an excursion takes one change, its close, once (id %)', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER pharmacy_cold_excursions_guard
  BEFORE UPDATE OR DELETE ON pharmacy_cold_excursions
  FOR EACH ROW EXECUTE FUNCTION pharmacy_cold_excursion_guard();--> statement-breakpoint
-- A unit is a master row the in-charge edits (label, range, active) with an audit event per edit; it is
-- never deleted (its readings point at it), and its store and creator never change.
CREATE OR REPLACE FUNCTION pharmacy_cold_unit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy_cold_chain_immutable: a fridge may not be deleted — set it inactive (id %)', OLD.id;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.store_resource_id IS DISTINCT FROM OLD.store_resource_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pharmacy_cold_chain_immutable: a fridge keeps its store and its creator (id %)', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER pharmacy_cold_units_guard
  BEFORE UPDATE OR DELETE ON pharmacy_cold_units
  FOR EACH ROW EXECUTE FUNCTION pharmacy_cold_unit_guard();
