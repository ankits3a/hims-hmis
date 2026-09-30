CREATE TABLE "pharmacy_tray_check_lines" (
	"check_id" text NOT NULL,
	"item_id" text NOT NULL,
	"par_qty" integer NOT NULL,
	"qty_present" integer NOT NULL,
	"earliest_expiry" date,
	"batch_id" text,
	"qty_expiring" integer DEFAULT 0 NOT NULL,
	"qty_used" integer DEFAULT 0 NOT NULL,
	"qty_restock" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pharmacy_tray_check_lines_pk" PRIMARY KEY("check_id","item_id"),
	CONSTRAINT "pharmacy_tray_check_lines_qty_ck" CHECK (par_qty > 0 and qty_present >= 0 and qty_expiring >= 0 and qty_expiring <= qty_present and qty_used >= 0 and qty_restock >= 0)
);
--> statement-breakpoint
CREATE TABLE "pharmacy_tray_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"tray_resource_id" text NOT NULL,
	"kind" text NOT NULL,
	"seal_seen" text,
	"seal_new" text,
	"result" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"patient_id" text,
	"event" text,
	"note" text,
	"checked_by" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restock_transfer_id" text,
	"restocked_by" text,
	"restocked_at" timestamp with time zone,
	CONSTRAINT "pharmacy_tray_checks_kind_ck" CHECK (kind in ('daily_seal', 'monthly_full', 'after_use')),
	CONSTRAINT "pharmacy_tray_checks_result_ck" CHECK (result in ('ok', 'deficient')),
	CONSTRAINT "pharmacy_tray_checks_after_use_ck" CHECK (kind = 'after_use' or (patient_id is null and event is null)),
	CONSTRAINT "pharmacy_tray_checks_restock_ck" CHECK ((restock_transfer_id is null) = (restocked_by is null) and (restock_transfer_id is null) = (restocked_at is null) and (restock_transfer_id is null or result = 'deficient'))
);
--> statement-breakpoint
CREATE TABLE "pharmacy_tray_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"tray_resource_id" text NOT NULL,
	"item_id" text NOT NULL,
	"par_qty" integer NOT NULL,
	"min_expiry_days" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone,
	CONSTRAINT "pharmacy_tray_templates_par_ck" CHECK ("pharmacy_tray_templates"."par_qty" > 0 and "pharmacy_tray_templates"."par_qty" <= 10000),
	CONSTRAINT "pharmacy_tray_templates_margin_ck" CHECK ("pharmacy_tray_templates"."min_expiry_days" is null or ("pharmacy_tray_templates"."min_expiry_days" between 0 and 365))
);
--> statement-breakpoint
ALTER TABLE "pharmacy_tray_check_lines" ADD CONSTRAINT "pharmacy_tray_check_lines_check_id_pharmacy_tray_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."pharmacy_tray_checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_tray_check_lines" ADD CONSTRAINT "pharmacy_tray_check_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_tray_check_lines" ADD CONSTRAINT "pharmacy_tray_check_lines_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_tray_checks" ADD CONSTRAINT "pharmacy_tray_checks_tray_resource_id_resources_id_fk" FOREIGN KEY ("tray_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_tray_checks" ADD CONSTRAINT "pharmacy_tray_checks_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_tray_checks" ADD CONSTRAINT "pharmacy_tray_checks_checked_by_users_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_tray_checks" ADD CONSTRAINT "pharmacy_tray_checks_restock_transfer_id_transfers_id_fk" FOREIGN KEY ("restock_transfer_id") REFERENCES "public"."transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_tray_checks" ADD CONSTRAINT "pharmacy_tray_checks_restocked_by_users_id_fk" FOREIGN KEY ("restocked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_tray_templates" ADD CONSTRAINT "pharmacy_tray_templates_tray_resource_id_resources_id_fk" FOREIGN KEY ("tray_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_tray_templates" ADD CONSTRAINT "pharmacy_tray_templates_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_tray_templates" ADD CONSTRAINT "pharmacy_tray_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_tray_templates" ADD CONSTRAINT "pharmacy_tray_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_tray_checks_seq_ux" ON "pharmacy_tray_checks" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "pharmacy_tray_checks_tray_at_idx" ON "pharmacy_tray_checks" USING btree ("tray_resource_id","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_tray_templates_tray_item_ux" ON "pharmacy_tray_templates" USING btree ("tray_resource_id","item_id");--> statement-breakpoint
-- ═══ PHARMACY STAGE D4 — THE TRAY CHECK REGISTER IS APPEND-ONLY, HAND-CARRIED (drizzle-kit emits no triggers) ═══
--
-- NABH MOM: emergency medications are checked and replenished promptly after use. A check once signed is a
-- record: a wrong count is answered by a further check with a note, never by an edit. The D1–D3 shape.
CREATE OR REPLACE FUNCTION pharmacy_tray_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy_tray_immutable: a % row may not be deleted', TG_TABLE_NAME;
  END IF;
  RAISE EXCEPTION 'pharmacy_tray_immutable: a % row may not be edited — a later check is a new row, never an edit', TG_TABLE_NAME;
END $$;--> statement-breakpoint
CREATE TRIGGER pharmacy_tray_check_lines_immutable
  BEFORE UPDATE OR DELETE ON pharmacy_tray_check_lines
  FOR EACH ROW EXECUTE FUNCTION pharmacy_tray_forbid_mutation();--> statement-breakpoint
-- A check is never deleted, and the ONLY change it takes is its restock (the transfer, who, when), once, from
-- null: the status-column exception of stage D's shared rules. Everything else is what was found when it was made.
CREATE OR REPLACE FUNCTION pharmacy_tray_check_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy_tray_immutable: a tray check may not be deleted (id %)', OLD.id;
  END IF;
  IF OLD.restock_transfer_id IS NOT NULL OR NEW.restock_transfer_id IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.tray_resource_id IS DISTINCT FROM OLD.tray_resource_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.seal_seen IS DISTINCT FROM OLD.seal_seen OR NEW.seal_new IS DISTINCT FROM OLD.seal_new
     OR NEW.result IS DISTINCT FROM OLD.result OR NEW.findings IS DISTINCT FROM OLD.findings
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.event IS DISTINCT FROM OLD.event OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.checked_by IS DISTINCT FROM OLD.checked_by OR NEW.checked_at IS DISTINCT FROM OLD.checked_at
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'pharmacy_tray_immutable: a tray check takes one change, its restock, once (id %)', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER pharmacy_tray_checks_guard
  BEFORE UPDATE OR DELETE ON pharmacy_tray_checks
  FOR EACH ROW EXECUTE FUNCTION pharmacy_tray_check_guard();--> statement-breakpoint
-- A template line is a master row the in-charge edits (par, margin, active) with an audit event per save; it is
-- never deleted (checks copied its par), and its tray, item and creator never change.
CREATE OR REPLACE FUNCTION pharmacy_tray_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy_tray_immutable: a tray template line may not be deleted — set it inactive (id %)', OLD.id;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tray_resource_id IS DISTINCT FROM OLD.tray_resource_id OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pharmacy_tray_immutable: a tray template line keeps its tray, its item and its creator (id %)', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER pharmacy_tray_templates_guard
  BEFORE UPDATE OR DELETE ON pharmacy_tray_templates
  FOR EACH ROW EXECUTE FUNCTION pharmacy_tray_template_guard();
