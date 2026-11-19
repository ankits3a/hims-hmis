CREATE TABLE "item_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"name_hi" text,
	"parent_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_categories_not_own_parent_ck" CHECK ("item_categories"."parent_id" is null or "item_categories"."parent_id" <> "item_categories"."id")
);
--> statement-breakpoint
CREATE TABLE "stores_item_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"requested_by" text NOT NULL,
	"shelf_id" text,
	"department_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_item_id" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stores_item_requests_status_ck" CHECK ("stores_item_requests"."status" in ('open', 'created', 'use_existing')),
	CONSTRAINT "stores_item_requests_resolution_ck" CHECK (("stores_item_requests"."status" = 'open') = ("stores_item_requests"."resolved_item_id" is null and "stores_item_requests"."resolved_at" is null))
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "category_id" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "track_mode" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "search_aliases" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "patient_billable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "item_categories" ADD CONSTRAINT "item_categories_parent_id_item_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."item_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_item_requests" ADD CONSTRAINT "stores_item_requests_shelf_id_resources_id_fk" FOREIGN KEY ("shelf_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_item_requests" ADD CONSTRAINT "stores_item_requests_resolved_item_id_items_id_fk" FOREIGN KEY ("resolved_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "item_categories_code_lower_ux" ON "item_categories" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "item_categories_parent_idx" ON "item_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "stores_item_requests_status_idx" ON "stores_item_requests" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_category_id_item_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."item_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_category_idx" ON "items" USING btree ("category_id");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_track_mode_ck" CHECK ("items"."track_mode" is null or "items"."track_mode" in ('expensed', 'shelf', 'durable'));--> statement-breakpoint
-- STORES S1 (#1111) — THE ONE LEDGER IS APPEND-ONLY IN THE DATABASE, not only by the absence of code
-- (the `0012_billing_immutability.sql` pattern). A correction is a new reversing row naming the row it
-- corrects (`reverseShelfUse`). TRUNCATE fires no row trigger, so test helpers are unaffected. Any later
-- migration that must backfill ledger rows drops and re-creates this trigger in the same file.
CREATE FUNCTION stock_ledger_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'stock_ledger_append_only: % rows are append-only (% refused)', TG_TABLE_NAME, TG_OP; END $$;--> statement-breakpoint
CREATE TRIGGER stock_ledger_append_only BEFORE UPDATE OR DELETE ON stock_ledger FOR EACH ROW EXECUTE FUNCTION stock_ledger_forbid_mutation();
