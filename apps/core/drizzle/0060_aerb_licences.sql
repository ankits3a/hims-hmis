-- PLAN 18c T1 — THE AERB REGISTERS: the equipment licence, and the people AERB approves.
--
-- Two tables and no change to any existing one. `aerb_licences` is what makes "was this machine
-- licensed on the day of that scan" a join rather than a filing cabinet, and its partial unique
-- index is the load-bearing line: ONE ACTIVE LICENCE PER DEVICE, so a renewal is a status change
-- plus a new row and never two live ones a reader picks between (the
-- `pcpndt_registered_machines_device_active_ux` shape, one statute over).
--
-- `aerb_licences_decommission_ck` is the other one worth reading: a `surrendered` licence carries
-- its decommissioning date and a non-surrendered one carries none, both directions. AERB requires
-- the decommissioning itself to be documented, and a status somebody set on a Tuesday with nothing
-- to show is not a record.
--
-- ═══ WHY THIS FILE WAS EDITED AFTER `drizzle-kit generate` WROTE IT ═══
--
-- The generator emitted two statements that are NOT this phase's: `ALTER SEQUENCE uhid_seq`
-- (already applied by 0057) and `entitlement_counters.unit` (already applied by 0058). Both of
-- those migrations were hand-written by other lanes without regenerating the drizzle snapshot, so
-- the generator's baseline was 0056 and it re-derived their deltas. They are removed here: this
-- migration is additive and its own. `0060_snapshot.json` is kept as generated — it is the correct
-- new baseline, because the schema files it was read from do carry those two changes.

CREATE TABLE "aerb_licences" (
	"id" text PRIMARY KEY NOT NULL,
	"device_resource_id" text NOT NULL,
	"licence_type" text NOT NULL,
	"licence_no" text NOT NULL,
	"elora_ref" text,
	"type_approval_ref" text,
	"layout_approval_ref" text,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"rso_user_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"decommissioned_at" timestamp with time zone,
	"decommission_ref" text,
	"remarks" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone,
	CONSTRAINT "aerb_licences_licence_no_unique" UNIQUE("licence_no"),
	CONSTRAINT "aerb_licences_type_ck" CHECK ("aerb_licences"."licence_type" in ('licence', 'registration')),
	CONSTRAINT "aerb_licences_status_ck" CHECK ("aerb_licences"."status" in ('active', 'suspended', 'surrendered')),
	CONSTRAINT "aerb_licences_validity_ck" CHECK ("aerb_licences"."valid_to" >= "aerb_licences"."valid_from"),
	CONSTRAINT "aerb_licences_decommission_ck" CHECK (("aerb_licences"."status" = 'surrendered') = ("aerb_licences"."decommissioned_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "aerb_persons" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"person_role" text NOT NULL,
	"approval_ref" text,
	"qualification" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aerb_persons_role_ck" CHECK ("aerb_persons"."person_role" in ('rso', 'physicist')),
	CONSTRAINT "aerb_persons_validity_ck" CHECK ("aerb_persons"."valid_to" is null or "aerb_persons"."valid_to" >= "aerb_persons"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "aerb_licences" ADD CONSTRAINT "aerb_licences_device_resource_id_resources_id_fk" FOREIGN KEY ("device_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aerb_persons" ADD CONSTRAINT "aerb_persons_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aerb_licences_device_active_ux" ON "aerb_licences" USING btree ("device_resource_id") WHERE "aerb_licences"."status" = 'active';--> statement-breakpoint
CREATE INDEX "aerb_licences_status_validity_idx" ON "aerb_licences" USING btree ("status","valid_to");--> statement-breakpoint
CREATE UNIQUE INDEX "aerb_persons_user_role_active_ux" ON "aerb_persons" USING btree ("user_id","person_role") WHERE "aerb_persons"."active" = true;--> statement-breakpoint
CREATE INDEX "aerb_persons_role_idx" ON "aerb_persons" USING btree ("person_role","active");
