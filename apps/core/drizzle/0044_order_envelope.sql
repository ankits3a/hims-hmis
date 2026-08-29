-- PLAN 17 PHASE 0 T1 — the P2 order envelope: three tables, their CHECKs, and two triggers.
--
-- EVERYTHING ABOVE THE `HAND-CARRIED` LINE IS AS `drizzle-kit generate` EMITTED IT. Unlike `0043`
-- the generated form runs as-is — all three tables are new, so there is no rows-already-exist
-- problem and no three-step ALTER. What drizzle CANNOT emit is a trigger, so the immutability half
-- of DD12 is appended by hand below, exactly as `0043_patient_identity_spine.sql:79-81` appended
-- its own.

CREATE TABLE "order_item_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_item_transitions_from_ck" CHECK ("order_item_transitions"."from_status" in ('placed', 'in_progress', 'completed', 'cancelled')),
	CONSTRAINT "order_item_transitions_to_ck" CHECK ("order_item_transitions"."to_status" in ('placed', 'in_progress', 'completed', 'cancelled')),
	CONSTRAINT "order_item_transitions_actor_type_ck" CHECK ("order_item_transitions"."actor_type" in ('user', 'agent', 'system', 'patient'))
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"service_id" text NOT NULL,
	"status" text DEFAULT 'placed' NOT NULL,
	"origin" text DEFAULT 'direct' NOT NULL,
	"parent_item_id" text,
	"duplicate_of_item_id" text,
	"duplicate_reason" text,
	"restricted" boolean DEFAULT false NOT NULL,
	"cancelled_from" text,
	"cancel_reason" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_status_ck" CHECK ("order_items"."status" in ('placed', 'in_progress', 'completed', 'cancelled')),
	CONSTRAINT "order_items_origin_ck" CHECK ("order_items"."origin" in ('direct', 'addon', 'reflex', 'duplicate_confirmed')),
	CONSTRAINT "order_items_cancelled_from_ck" CHECK ("order_items"."cancelled_from" is null or "order_items"."cancelled_from" in ('placed', 'in_progress')),
	CONSTRAINT "order_items_cancel_reason_ck" CHECK ("order_items"."cancelled_from" is distinct from 'in_progress' or "order_items"."cancel_reason" is not null),
	CONSTRAINT "order_items_duplicate_ck" CHECK (("order_items"."duplicate_of_item_id" is null) = ("order_items"."duplicate_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"order_no" text NOT NULL,
	"order_group_id" text NOT NULL,
	"kind" text NOT NULL,
	"patient_id" text NOT NULL,
	"encounter_no" text NOT NULL,
	"service_date" date NOT NULL,
	"priority" text NOT NULL,
	"authority" text NOT NULL,
	"ordered_by_type" text NOT NULL,
	"ordered_by_id" text NOT NULL,
	"ordering_clinician_id" text,
	"external_referrer_id" text,
	"protocol_ref" text,
	"indication" text,
	"status" text DEFAULT 'open' NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "orders_order_no_unique" UNIQUE("order_no"),
	CONSTRAINT "orders_priority_ck" CHECK ("orders"."priority" in ('routine', 'urgent', 'stat')),
	CONSTRAINT "orders_authority_ck" CHECK ("orders"."authority" in ('clinician', 'external_prescription', 'self', 'protocol')),
	CONSTRAINT "orders_status_ck" CHECK ("orders"."status" in ('open', 'closed', 'cancelled')),
	CONSTRAINT "orders_ordered_by_type_ck" CHECK ("orders"."ordered_by_type" in ('user', 'agent', 'system', 'patient')),
	CONSTRAINT "orders_external_referrer_ck" CHECK (("orders"."authority" = 'external_prescription') = ("orders"."external_referrer_id" is not null)),
	CONSTRAINT "orders_protocol_ref_ck" CHECK (("orders"."authority" = 'protocol') = ("orders"."protocol_ref" is not null)),
	CONSTRAINT "orders_closed_at_ck" CHECK (("orders"."status" = 'open') = ("orders"."closed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "order_item_transitions" ADD CONSTRAINT "order_item_transitions_item_id_order_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_item_transitions_item_idx" ON "order_item_transitions" USING btree ("item_id","at");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_service_created_idx" ON "order_items" USING btree ("service_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_patient_placed_idx" ON "orders" USING btree ("patient_id","placed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_encounter_no_idx" ON "orders" USING btree ("encounter_no");--> statement-breakpoint
CREATE INDEX "orders_kind_status_idx" ON "orders" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "orders_group_idx" ON "orders" USING btree ("order_group_id");--> statement-breakpoint

-- ════════════════════════ HAND-CARRIED: DD12, IMMUTABILITY IN THE DATABASE ════════════════════════
--
-- The `0043` / `0012` pattern verbatim in shape. Enforcing append-only in application code leaves
-- the guarantee one forgotten code path away from being false, and this is the table a
-- medico-legal question is answered from: who started the test, who cancelled it, and when.

CREATE OR REPLACE FUNCTION order_envelope_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'order_envelope_immutable: % rows are append-only (% refused)', TG_TABLE_NAME, TG_OP; END $$;--> statement-breakpoint
CREATE TRIGGER order_item_transitions_immutable BEFORE UPDATE OR DELETE ON order_item_transitions FOR EACH ROW EXECUTE FUNCTION order_envelope_forbid_mutation();--> statement-breakpoint

-- THE HEADER'S IDENTITY COLUMNS NEVER CHANGE AFTER INSERT (DD12), and the list is SHORTER THAN THE
-- DD BY ONE COLUMN — deliberately, and the spike is the reason.
--
-- DD12 wanted `patient_id` frozen too, releasing it for a patient merge through a
-- `current_setting('hmis.merge', true) = 'on'` GUC, and told the executor to CONFIRM that the
-- patients merge already uses one. It does not: `grep -rn "set_config|current_setting"
-- apps/core/src --include=*.ts` returns ZERO hits at kickoff. So freezing `patient_id` here would
-- break the merge path (02 A4, E8) the day it re-links an order, and inventing a GUC this
-- repository does not otherwise use would put a second, undocumented authority on who may move a
-- patient row. **`patient_id` is therefore left MUTABLE and the close says so** — which is exactly
-- the branch DD12 named in advance.
--
-- What that costs is nothing E8 relies on: `order_no` is frozen, so a printed label keeps its
-- original number through any merge, which is the property the edge case actually asks for.
--
-- `status`, `closed_at` and the item columns are deliberately NOT here: the envelope's whole job is
-- to move them, under compare-and-set, from `advanceOrderItem`.
CREATE OR REPLACE FUNCTION orders_forbid_identity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."order_no" IS DISTINCT FROM OLD."order_no" THEN
    RAISE EXCEPTION 'order_identity_immutable: orders.order_no cannot change after insert';
  END IF;
  IF NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION 'order_identity_immutable: orders.kind cannot change after insert';
  END IF;
  IF NEW."encounter_no" IS DISTINCT FROM OLD."encounter_no" THEN
    RAISE EXCEPTION 'order_identity_immutable: orders.encounter_no cannot change after insert';
  END IF;
  IF NEW."ordered_by_type" IS DISTINCT FROM OLD."ordered_by_type"
     OR NEW."ordered_by_id" IS DISTINCT FROM OLD."ordered_by_id" THEN
    RAISE EXCEPTION 'order_identity_immutable: orders.ordered_by_* cannot change after insert';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER orders_identity_immutable BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION orders_forbid_identity_change();
