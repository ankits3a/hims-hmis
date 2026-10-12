CREATE TABLE "bmw_bag_events" (
	"bag_id" text NOT NULL,
	"seq" integer NOT NULL,
	"act" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"source" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "bmw_bag_events_bag_id_seq_pk" PRIMARY KEY("bag_id","seq"),
	CONSTRAINT "bmw_bag_events_act_ck" CHECK ("bmw_bag_events"."act" in ('generated', 'dept_weighed', 'collected', 'stored', 'handed_over', 'cbwtf_weighed', 'treated', 'disputed', 'resolved')),
	CONSTRAINT "bmw_bag_events_source_ck" CHECK ("bmw_bag_events"."source" in ('person', 'device', 'copilot_draft', 'agent', 'import', 'system'))
);
--> statement-breakpoint
CREATE TABLE "bmw_bags" (
	"id" text PRIMARY KEY NOT NULL,
	"barcode" text NOT NULL,
	"category" text NOT NULL,
	"cytotoxic" boolean DEFAULT false NOT NULL,
	"place_resource_id" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"generated_by" text NOT NULL,
	"dept_weight_grams" integer,
	"dept_weighed_at" timestamp with time zone,
	"collected_at" timestamp with time zone,
	"collected_by" text,
	"central_weight_grams" integer,
	"storage_in_at" timestamp with time zone,
	"stored_by" text,
	"state" text DEFAULT 'generated' NOT NULL,
	"handed_over_at" timestamp with time zone,
	"manifest_id" text,
	"cbwtf_weight_grams" integer,
	"treated_at" timestamp with time zone,
	"source" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "bmw_bags_category_ck" CHECK ("bmw_bags"."category" in ('yellow', 'red', 'white_translucent', 'blue')),
	CONSTRAINT "bmw_bags_cytotoxic_ck" CHECK (not "bmw_bags"."cytotoxic" or "bmw_bags"."category" = 'yellow'),
	CONSTRAINT "bmw_bags_state_ck" CHECK ("bmw_bags"."state" in ('generated', 'collected', 'stored', 'handed_over', 'treated', 'disputed')),
	CONSTRAINT "bmw_bags_weights_ck" CHECK (coalesce("bmw_bags"."dept_weight_grams", 1) > 0 and coalesce("bmw_bags"."central_weight_grams", 1) > 0 and coalesce("bmw_bags"."cbwtf_weight_grams", 1) > 0),
	CONSTRAINT "bmw_bags_manifest_ck" CHECK (("bmw_bags"."state" in ('handed_over', 'treated', 'disputed')) = ("bmw_bags"."manifest_id" is not null)),
	CONSTRAINT "bmw_bags_source_ck" CHECK ("bmw_bags"."source" in ('person', 'device', 'copilot_draft', 'agent', 'import')),
	CONSTRAINT "bmw_bags_version_ck" CHECK ("bmw_bags"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "bmw_disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"manifest_id" text NOT NULL,
	"category" text NOT NULL,
	"dept_grams" integer NOT NULL,
	"cbwtf_grams" integer NOT NULL,
	"gap_basis_points" integer NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opened_by" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" text,
	CONSTRAINT "bmw_disputes_state_ck" CHECK ("bmw_disputes"."state" in ('open', 'resolved')),
	CONSTRAINT "bmw_disputes_category_ck" CHECK ("bmw_disputes"."category" in ('yellow', 'red', 'white_translucent', 'blue')),
	CONSTRAINT "bmw_disputes_resolved_ck" CHECK (("bmw_disputes"."state" = 'resolved') = ("bmw_disputes"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "bmw_manifests" (
	"id" text PRIMARY KEY NOT NULL,
	"manifest_no" text NOT NULL,
	"cbwtf_name" text NOT NULL,
	"vehicle_no" text NOT NULL,
	"operator_name" text,
	"handed_over_at" timestamp with time zone NOT NULL,
	"handed_over_by" text NOT NULL,
	"bag_count" integer NOT NULL,
	"totals" jsonb NOT NULL,
	"cbwtf_recorded_at" timestamp with time zone,
	"cbwtf_recorded_by" text,
	"cbwtf_totals" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bmw_manifests_counts_ck" CHECK ("bmw_manifests"."bag_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "bmw_bag_events" ADD CONSTRAINT "bmw_bag_events_bag_id_bmw_bags_id_fk" FOREIGN KEY ("bag_id") REFERENCES "public"."bmw_bags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bmw_bags" ADD CONSTRAINT "bmw_bags_place_resource_id_resources_id_fk" FOREIGN KEY ("place_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bmw_bags" ADD CONSTRAINT "bmw_bags_manifest_id_bmw_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."bmw_manifests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bmw_disputes" ADD CONSTRAINT "bmw_disputes_manifest_id_bmw_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."bmw_manifests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bmw_bag_events_at_idx" ON "bmw_bag_events" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "bmw_bags_barcode_uq" ON "bmw_bags" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "bmw_bags_on_site_idx" ON "bmw_bags" USING btree ("state","generated_at") WHERE "bmw_bags"."state" in ('generated', 'collected', 'stored');--> statement-breakpoint
CREATE INDEX "bmw_bags_generated_idx" ON "bmw_bags" USING btree ("generated_at");--> statement-breakpoint
CREATE INDEX "bmw_bags_place_idx" ON "bmw_bags" USING btree ("place_resource_id","generated_at");--> statement-breakpoint
CREATE INDEX "bmw_bags_manifest_idx" ON "bmw_bags" USING btree ("manifest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bmw_disputes_manifest_category_uq" ON "bmw_disputes" USING btree ("manifest_id","category");--> statement-breakpoint
CREATE INDEX "bmw_disputes_open_idx" ON "bmw_disputes" USING btree ("state") WHERE "bmw_disputes"."state" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "bmw_manifests_no_uq" ON "bmw_manifests" USING btree ("manifest_no");--> statement-breakpoint
CREATE INDEX "bmw_manifests_at_idx" ON "bmw_manifests" USING btree ("handed_over_at");--> statement-breakpoint
-- E1.7 BIO-MEDICAL WASTE — the serials behind a bag's bar code and a manifest's number. Standalone business
-- counters (the `uhid_seq` shape): never reset, so a bar code is never issued twice.
CREATE SEQUENCE IF NOT EXISTS bmw_bag_serial START 1;--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS bmw_manifest_serial START 1;--> statement-breakpoint
-- A bag's history is corrected by a further row, never by an edit: no UPDATE, no DELETE.
CREATE OR REPLACE FUNCTION bmw_bag_events_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_append_only: bmw_bag_events rows are append-only (% refused, bag %, seq %)', TG_OP, OLD.bag_id, OLD.seq;
END $$;--> statement-breakpoint
CREATE TRIGGER bmw_bag_events_append_only
  BEFORE UPDATE OR DELETE ON "bmw_bag_events"
  FOR EACH ROW EXECUTE FUNCTION bmw_bag_events_forbid_mutation();
