CREATE TABLE "stores_picking_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"indent_id" text NOT NULL,
	"claimed_by" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores_ticket_details" (
	"indent_id" text PRIMARY KEY NOT NULL,
	"department_id" text NOT NULL,
	"shelf_id" text NOT NULL,
	"priority" text NOT NULL,
	"channel" text DEFAULT 'web' NOT NULL,
	"needed_by" timestamp with time zone,
	"deliver_to" text,
	"emergency_reason" text,
	"night" boolean DEFAULT false NOT NULL,
	"origin_indent_id" text,
	"origin_kind" text,
	"clock_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stores_ticket_details_priority_ck" CHECK ("stores_ticket_details"."priority" in ('routine', 'urgent', 'emergency')),
	CONSTRAINT "stores_ticket_details_channel_ck" CHECK ("stores_ticket_details"."channel" in ('phone', 'web', 'copilot', 'agent')),
	CONSTRAINT "stores_ticket_details_emergency_ck" CHECK ("stores_ticket_details"."priority" <> 'emergency' or "stores_ticket_details"."emergency_reason" is not null),
	CONSTRAINT "stores_ticket_details_origin_ck" CHECK (("stores_ticket_details"."origin_indent_id" is null) = ("stores_ticket_details"."origin_kind" is null) and ("stores_ticket_details"."origin_kind" is null or "stores_ticket_details"."origin_kind" in ('re_raise', 're_ask')))
);
--> statement-breakpoint
ALTER TABLE "store_indent_lines" ADD COLUMN "qty_approved" integer;--> statement-breakpoint
ALTER TABLE "store_indents" ADD COLUMN "approval_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "store_indents" ADD COLUMN "issue_before_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "store_indents" ADD COLUMN "approval_decision" text;--> statement-breakpoint
ALTER TABLE "store_indents" ADD COLUMN "approval_by" text;--> statement-breakpoint
ALTER TABLE "store_indents" ADD COLUMN "approval_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "store_indents" ADD COLUMN "approval_reason" text;--> statement-breakpoint
ALTER TABLE "store_indents" ADD COLUMN "approval_for_hod" boolean;--> statement-breakpoint
ALTER TABLE "store_indents" ADD COLUMN "review_decision" text;--> statement-breakpoint
ALTER TABLE "store_indents" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "store_indents" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "store_indents" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "stores_picking_claims" ADD CONSTRAINT "stores_picking_claims_indent_id_store_indents_id_fk" FOREIGN KEY ("indent_id") REFERENCES "public"."store_indents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_ticket_details" ADD CONSTRAINT "stores_ticket_details_indent_id_store_indents_id_fk" FOREIGN KEY ("indent_id") REFERENCES "public"."store_indents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_ticket_details" ADD CONSTRAINT "stores_ticket_details_shelf_id_resources_id_fk" FOREIGN KEY ("shelf_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_ticket_details" ADD CONSTRAINT "stores_ticket_details_origin_indent_id_store_indents_id_fk" FOREIGN KEY ("origin_indent_id") REFERENCES "public"."store_indents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stores_picking_claims_indent_idx" ON "stores_picking_claims" USING btree ("indent_id","claimed_at");--> statement-breakpoint
CREATE INDEX "stores_ticket_details_dept_idx" ON "stores_ticket_details" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "stores_ticket_details_shelf_idx" ON "stores_ticket_details" USING btree ("shelf_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_ticket_details_reraise_ux" ON "stores_ticket_details" USING btree ("origin_indent_id") WHERE "stores_ticket_details"."origin_kind" = 're_raise';--> statement-breakpoint
ALTER TABLE "store_indent_lines" ADD CONSTRAINT "store_indent_lines_approved_ck" CHECK ("store_indent_lines"."qty_approved" is null or ("store_indent_lines"."qty_approved" >= 0 and "store_indent_lines"."qty_approved" <= "store_indent_lines"."qty_base"));--> statement-breakpoint
ALTER TABLE "store_indents" ADD CONSTRAINT "store_indents_approval_ck" CHECK (("store_indents"."approval_decision" is null or ("store_indents"."approval_required" and "store_indents"."approval_decision" in ('approved', 'declined')))
      and ("store_indents"."approval_decision" is null) = ("store_indents"."approval_by" is null) and ("store_indents"."approval_decision" is null) = ("store_indents"."approval_at" is null)
      and ("store_indents"."approval_decision" is null) = ("store_indents"."approval_for_hod" is null)
      and ("store_indents"."approval_decision" is distinct from 'declined' or "store_indents"."approval_reason" is not null)
      and (not "store_indents"."issue_before_approval" or "store_indents"."approval_required"));--> statement-breakpoint
ALTER TABLE "store_indents" ADD CONSTRAINT "store_indents_review_ck" CHECK (("store_indents"."review_decision" is null or ("store_indents"."issue_before_approval" and "store_indents"."review_decision" in ('agree', 'query')))
      and ("store_indents"."review_decision" is null) = ("store_indents"."reviewed_by" is null) and ("store_indents"."review_decision" is null) = ("store_indents"."reviewed_at" is null));--> statement-breakpoint
-- ═══ STORES S2a (#1112, decision 1) — THE APPROVAL STAMP IS WRITE-ONCE (drizzle-kit emits no triggers) ═══
--
-- 0155's guards let an indent take ONE change (its decision) and a line ONE change (its quantity issued).
-- They are REPLACED here, keeping every refusal they made, with exactly two new transitions, both on the
-- new columns only:
--   · the header takes its approval stamp (approval_decision/by/at/reason/for_hod) once, from null, while
--     the indent is still requested (an approval) or in the same update as its decision (a decline), and its
--     review stamp (an emergency issued first) once, from null, on an issued indent;
--   · a line takes its approved quantity once, from null, before anything is issued against it.
-- A stamp, once set, is never changed or cleared; approval_required / issue_before_approval are fixed at
-- raise; and an indent (stamped or not) is still never deleted. A pharmacy indent carries no stamp, so every
-- update it can make is one 0155 already allowed.
CREATE OR REPLACE FUNCTION store_indent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  decided boolean;
  approval_set boolean;
  review_set boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'store_indent_immutable: an indent may not be deleted — cancel it (id %)', OLD.id;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.indent_no IS DISTINCT FROM OLD.indent_no
     OR NEW.from_resource_id IS DISTINCT FROM OLD.from_resource_id OR NEW.to_resource_id IS DISTINCT FROM OLD.to_resource_id
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.approval_required IS DISTINCT FROM OLD.approval_required
     OR NEW.issue_before_approval IS DISTINCT FROM OLD.issue_before_approval THEN
    RAISE EXCEPTION 'store_indent_immutable: an indent takes one change, its decision, once (id %)', OLD.id;
  END IF;
  approval_set := (NEW.approval_decision, NEW.approval_by, NEW.approval_at, NEW.approval_reason, NEW.approval_for_hod)
    IS DISTINCT FROM (OLD.approval_decision, OLD.approval_by, OLD.approval_at, OLD.approval_reason, OLD.approval_for_hod);
  review_set := (NEW.review_decision, NEW.reviewed_by, NEW.reviewed_at, NEW.review_note)
    IS DISTINCT FROM (OLD.review_decision, OLD.reviewed_by, OLD.reviewed_at, OLD.review_note);
  IF (approval_set AND OLD.approval_decision IS NOT NULL) OR (review_set AND OLD.review_decision IS NOT NULL) THEN
    RAISE EXCEPTION 'store_indent_stamp_write_once: an approval or review stamp is set once and never changed or cleared (id %)', OLD.id;
  END IF;
  -- Pre-merge review S6: a stamp is written WHOLE, in the one update that carries its decision. A reason or a
  -- note on its own would be a stamp with no decision, which the write-once check above would then never see.
  IF (approval_set AND NEW.approval_decision IS NULL) OR (review_set AND NEW.review_decision IS NULL) THEN
    RAISE EXCEPTION 'store_indent_stamp_write_once: a stamp is written whole, with its decision (id %)', OLD.id;
  END IF;
  decided := (NEW.status, NEW.decided_by, NEW.decided_at, NEW.reject_reason, NEW.cancel_reason, NEW.transfer_id)
    IS DISTINCT FROM (OLD.status, OLD.decided_by, OLD.decided_at, OLD.reject_reason, OLD.cancel_reason, OLD.transfer_id);
  IF decided AND (OLD.status <> 'requested' OR NEW.status = 'requested') THEN
    RAISE EXCEPTION 'store_indent_immutable: an indent takes one change, its decision, once (id %)', OLD.id;
  END IF;
  IF approval_set AND OLD.status <> 'requested' THEN
    RAISE EXCEPTION 'store_indent_immutable: an approval is stamped while the indent is still requested (id %)', OLD.id;
  END IF;
  IF review_set AND (decided OR approval_set OR OLD.status <> 'issued') THEN
    RAISE EXCEPTION 'store_indent_immutable: a review is stamped alone, on an issued indent (id %)', OLD.id;
  END IF;
  IF NOT decided AND NOT approval_set AND NOT review_set THEN
    RAISE EXCEPTION 'store_indent_immutable: an indent takes one change, its decision, once (id %)', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION store_indent_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'store_indent_immutable: an indent line may not be deleted (id %)', OLD.id;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.indent_id IS DISTINCT FROM OLD.indent_id OR NEW.line_idx IS DISTINCT FROM OLD.line_idx
     OR NEW.item_id IS DISTINCT FROM OLD.item_id OR NEW.qty_base IS DISTINCT FROM OLD.qty_base THEN
    RAISE EXCEPTION 'store_indent_immutable: an indent line takes one change, the quantity issued, once (id %)', OLD.id;
  END IF;
  IF NEW.qty_approved IS DISTINCT FROM OLD.qty_approved THEN
    IF OLD.qty_approved IS NOT NULL OR NEW.qty_approved IS NULL THEN
      RAISE EXCEPTION 'store_indent_stamp_write_once: an approved quantity is set once and never changed or cleared (id %)', OLD.id;
    END IF;
    IF OLD.qty_issued IS NOT NULL OR NEW.qty_issued IS NOT NULL THEN
      RAISE EXCEPTION 'store_indent_immutable: a line is approved before anything is issued against it (id %)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.qty_issued IS NOT NULL OR NEW.qty_issued IS NULL THEN
    RAISE EXCEPTION 'store_indent_immutable: an indent line takes one change, the quantity issued, once (id %)', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
-- Pre-merge review S6: a ticket's details (priority, shelf, deliver-to, the clock it runs on) are written once at
-- raise and never changed or removed; nothing in the module updates them.
CREATE OR REPLACE FUNCTION stores_ticket_details_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stores_ticket_details_append_only: a ticket''s details are written once (indent %)', OLD.indent_id;
END $$;--> statement-breakpoint
CREATE TRIGGER stores_ticket_details_append_only BEFORE UPDATE OR DELETE ON "stores_ticket_details"
  FOR EACH ROW EXECUTE FUNCTION stores_ticket_details_guard();
