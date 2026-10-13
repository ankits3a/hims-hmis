CREATE TABLE "linen_condemn_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"ward_resource_id" text,
	"item_code" text NOT NULL,
	"qty" integer NOT NULL,
	"reason" text NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "linen_condemn_requests_state_ck" CHECK ("linen_condemn_requests"."state" in ('requested', 'approved', 'rejected')),
	CONSTRAINT "linen_condemn_requests_qty_ck" CHECK ("linen_condemn_requests"."qty" > 0),
	CONSTRAINT "linen_condemn_requests_decided_ck" CHECK (("linen_condemn_requests"."state" = 'requested') = ("linen_condemn_requests"."decided_at" is null)),
	CONSTRAINT "linen_condemn_requests_four_eyes_ck" CHECK ("linen_condemn_requests"."decided_by" is null or "linen_condemn_requests"."decided_by" <> "linen_condemn_requests"."requested_by")
);
--> statement-breakpoint
CREATE TABLE "linen_items" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"units_per_set" integer DEFAULT 1 NOT NULL,
	"sort" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linen_items_units_ck" CHECK ("linen_items"."units_per_set" >= 0)
);
--> statement-breakpoint
CREATE TABLE "linen_laundry_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_no" text NOT NULL,
	"infected" boolean NOT NULL,
	"vendor_name" text,
	"state" text DEFAULT 'sent' NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"sent_by" text NOT NULL,
	"pieces_sent" integer NOT NULL,
	"received_at" timestamp with time zone,
	"received_by" text,
	"pieces_received" integer,
	"idempotency_key" text,
	CONSTRAINT "linen_laundry_batches_state_ck" CHECK ("linen_laundry_batches"."state" in ('sent', 'received', 'short')),
	CONSTRAINT "linen_laundry_batches_pieces_ck" CHECK ("linen_laundry_batches"."pieces_sent" > 0 and coalesce("linen_laundry_batches"."pieces_received", 0) >= 0),
	CONSTRAINT "linen_laundry_batches_received_ck" CHECK (("linen_laundry_batches"."state" = 'sent') = ("linen_laundry_batches"."received_at" is null))
);
--> statement-breakpoint
CREATE TABLE "linen_movements" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"item_code" text NOT NULL,
	"qty" integer NOT NULL,
	"ward_resource_id" text,
	"to_ward_resource_id" text,
	"batch_id" text,
	"condemn_request_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"source" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linen_movements_kind_ck" CHECK ("linen_movements"."kind" in ('issue_to_ward', 'return_soiled', 'return_infected', 'laundry_out', 'laundry_in', 'condemn', 'transfer_between_wards')),
	CONSTRAINT "linen_movements_qty_ck" CHECK ("linen_movements"."qty" > 0),
	CONSTRAINT "linen_movements_ward_ck" CHECK (("linen_movements"."kind" in ('issue_to_ward', 'return_soiled', 'return_infected', 'transfer_between_wards')) <= ("linen_movements"."ward_resource_id" is not null)),
	CONSTRAINT "linen_movements_transfer_ck" CHECK (("linen_movements"."kind" = 'transfer_between_wards') = ("linen_movements"."to_ward_resource_id" is not null) and ("linen_movements"."to_ward_resource_id" is null or "linen_movements"."to_ward_resource_id" <> "linen_movements"."ward_resource_id")),
	CONSTRAINT "linen_movements_batch_ck" CHECK (("linen_movements"."kind" in ('laundry_out', 'laundry_in')) = ("linen_movements"."batch_id" is not null)),
	CONSTRAINT "linen_movements_condemn_ck" CHECK (("linen_movements"."kind" = 'condemn') = ("linen_movements"."condemn_request_id" is not null)),
	CONSTRAINT "linen_movements_source_ck" CHECK ("linen_movements"."source" in ('person', 'device', 'copilot_draft', 'agent', 'import', 'system'))
);
--> statement-breakpoint
CREATE TABLE "linen_par_levels" (
	"ward_resource_id" text NOT NULL,
	"item_code" text NOT NULL,
	"par" integer NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	CONSTRAINT "linen_par_levels_ward_resource_id_item_code_pk" PRIMARY KEY("ward_resource_id","item_code"),
	CONSTRAINT "linen_par_levels_par_ck" CHECK ("linen_par_levels"."par" >= 0)
);
--> statement-breakpoint
CREATE TABLE "linen_variances" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'laundry_short' NOT NULL,
	"batch_id" text NOT NULL,
	"item_code" text NOT NULL,
	"sent" integer NOT NULL,
	"received" integer NOT NULL,
	"short" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"recorded_by" text NOT NULL,
	CONSTRAINT "linen_variances_kind_ck" CHECK ("linen_variances"."kind" in ('laundry_short')),
	CONSTRAINT "linen_variances_short_ck" CHECK ("linen_variances"."short" > 0 and "linen_variances"."short" = "linen_variances"."sent" - "linen_variances"."received" and "linen_variances"."received" >= 0)
);
--> statement-breakpoint
CREATE TABLE "linen_ward_counts" (
	"id" text PRIMARY KEY NOT NULL,
	"ward_resource_id" text NOT NULL,
	"item_code" text NOT NULL,
	"on_hand" integer NOT NULL,
	"counted_at" timestamp with time zone NOT NULL,
	"counted_by" text NOT NULL,
	"source" text DEFAULT 'person' NOT NULL,
	"idempotency_key" text,
	CONSTRAINT "linen_ward_counts_on_hand_ck" CHECK ("linen_ward_counts"."on_hand" >= 0),
	CONSTRAINT "linen_ward_counts_source_ck" CHECK ("linen_ward_counts"."source" in ('person', 'device', 'copilot_draft', 'agent', 'import', 'system'))
);
--> statement-breakpoint
ALTER TABLE "linen_condemn_requests" ADD CONSTRAINT "linen_condemn_requests_ward_resource_id_resources_id_fk" FOREIGN KEY ("ward_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_condemn_requests" ADD CONSTRAINT "linen_condemn_requests_item_code_linen_items_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."linen_items"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_movements" ADD CONSTRAINT "linen_movements_item_code_linen_items_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."linen_items"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_movements" ADD CONSTRAINT "linen_movements_ward_resource_id_resources_id_fk" FOREIGN KEY ("ward_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_movements" ADD CONSTRAINT "linen_movements_to_ward_resource_id_resources_id_fk" FOREIGN KEY ("to_ward_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_movements" ADD CONSTRAINT "linen_movements_batch_id_linen_laundry_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."linen_laundry_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_movements" ADD CONSTRAINT "linen_movements_condemn_request_id_linen_condemn_requests_id_fk" FOREIGN KEY ("condemn_request_id") REFERENCES "public"."linen_condemn_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_par_levels" ADD CONSTRAINT "linen_par_levels_ward_resource_id_resources_id_fk" FOREIGN KEY ("ward_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_par_levels" ADD CONSTRAINT "linen_par_levels_item_code_linen_items_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."linen_items"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_variances" ADD CONSTRAINT "linen_variances_batch_id_linen_laundry_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."linen_laundry_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_variances" ADD CONSTRAINT "linen_variances_item_code_linen_items_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."linen_items"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_ward_counts" ADD CONSTRAINT "linen_ward_counts_ward_resource_id_resources_id_fk" FOREIGN KEY ("ward_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_ward_counts" ADD CONSTRAINT "linen_ward_counts_item_code_linen_items_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."linen_items"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "linen_condemn_requests_open_idx" ON "linen_condemn_requests" USING btree ("state") WHERE "linen_condemn_requests"."state" = 'requested';--> statement-breakpoint
CREATE UNIQUE INDEX "linen_laundry_batches_no_uq" ON "linen_laundry_batches" USING btree ("batch_no");--> statement-breakpoint
CREATE UNIQUE INDEX "linen_laundry_batches_idempotency_uq" ON "linen_laundry_batches" USING btree ("idempotency_key") WHERE "linen_laundry_batches"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "linen_laundry_batches_open_idx" ON "linen_laundry_batches" USING btree ("state") WHERE "linen_laundry_batches"."state" = 'sent';--> statement-breakpoint
CREATE INDEX "linen_laundry_batches_sent_idx" ON "linen_laundry_batches" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "linen_movements_ward_idx" ON "linen_movements" USING btree ("ward_resource_id","item_code","at");--> statement-breakpoint
CREATE INDEX "linen_movements_to_ward_idx" ON "linen_movements" USING btree ("to_ward_resource_id","item_code","at") WHERE "linen_movements"."to_ward_resource_id" is not null;--> statement-breakpoint
CREATE INDEX "linen_movements_batch_idx" ON "linen_movements" USING btree ("batch_id") WHERE "linen_movements"."batch_id" is not null;--> statement-breakpoint
CREATE INDEX "linen_movements_at_idx" ON "linen_movements" USING btree ("kind","at");--> statement-breakpoint
CREATE UNIQUE INDEX "linen_movements_idempotency_uq" ON "linen_movements" USING btree ("kind","ward_resource_id","item_code","idempotency_key") WHERE "linen_movements"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "linen_variances_batch_item_uq" ON "linen_variances" USING btree ("batch_id","item_code");--> statement-breakpoint
CREATE INDEX "linen_variances_at_idx" ON "linen_variances" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "linen_ward_counts_ward_idx" ON "linen_ward_counts" USING btree ("ward_resource_id","item_code","counted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "linen_ward_counts_idempotency_uq" ON "linen_ward_counts" USING btree ("ward_resource_id","item_code","idempotency_key") WHERE "linen_ward_counts"."idempotency_key" is not null;--> statement-breakpoint
-- E2.4 LINEN — the serial behind a laundry batch number. A standalone business counter (the `uhid_seq` shape): never
-- reset, so a batch number is never issued twice.
CREATE SEQUENCE IF NOT EXISTS linen_batch_serial START 1;--> statement-breakpoint
-- The ledger is corrected by a further row, never by an edit: no UPDATE, no DELETE.
CREATE OR REPLACE FUNCTION linen_movements_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_append_only: linen_movements rows are append-only (% refused, movement %)', TG_OP, OLD.id;
END $$;--> statement-breakpoint
CREATE TRIGGER linen_movements_append_only
  BEFORE UPDATE OR DELETE ON "linen_movements"
  FOR EACH ROW EXECUTE FUNCTION linen_movements_forbid_mutation();--> statement-breakpoint
-- The standard catalogue (DECIDED, editable): six bed-set items and two theatre items outside a ward bed's set.
-- Mirrors `LINEN_STANDARD_ITEMS` in packages/contracts/src/linen.ts.
INSERT INTO "linen_items" ("code", "name", "units_per_set", "sort") VALUES
  ('bedsheet', 'Bedsheet', 1, 1),
  ('draw_sheet', 'Draw sheet', 1, 2),
  ('pillow_cover', 'Pillow cover', 1, 3),
  ('blanket', 'Blanket', 1, 4),
  ('patient_gown', 'Patient gown', 1, 5),
  ('towel', 'Towel', 1, 6),
  ('ot_gown', 'OT gown', 0, 7),
  ('ot_drape', 'OT drape', 0, 8)
ON CONFLICT ("code") DO NOTHING;
