CREATE TABLE "roster_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"period_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role_key" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"mode" text DEFAULT 'presence' NOT NULL,
	"kind" text DEFAULT 'duty' NOT NULL,
	"unit_id" text,
	"location_resource_id" text,
	"batch_ref" text,
	"topic" text,
	"swap_of_id" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"note" text,
	"effective" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_assignments_window_ck" CHECK ("roster_assignments"."ends_at" > "roster_assignments"."starts_at"),
	CONSTRAINT "roster_assignments_mode_ck" CHECK ("roster_assignments"."mode" in ('presence', 'call')),
	CONSTRAINT "roster_assignments_kind_ck" CHECK ("roster_assignments"."kind" in ('duty', 'teaching')),
	CONSTRAINT "roster_assignments_source_ck" CHECK ("roster_assignments"."source" in ('manual', 'import', 'proposer', 'academic'))
);
--> statement-breakpoint
CREATE TABLE "roster_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"superseded_at" timestamp with time zone,
	"superseded_by_period_id" text,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_periods_status_ck" CHECK ("roster_periods"."status" in ('draft', 'published', 'superseded')),
	CONSTRAINT "roster_periods_scope_type_ck" CHECK ("roster_periods"."scope_type" in ('hospital', 'department', 'unit', 'role_family')),
	CONSTRAINT "roster_periods_scope_id_ck" CHECK (("roster_periods"."scope_type" = 'hospital') = ("roster_periods"."scope_id" is null)),
	CONSTRAINT "roster_periods_window_ck" CHECK ("roster_periods"."ends_at" > "roster_periods"."starts_at"),
	CONSTRAINT "roster_periods_version_ck" CHECK ("roster_periods"."version" >= 1),
	CONSTRAINT "roster_periods_published_ck" CHECK (("roster_periods"."status" = 'draft') = ("roster_periods"."published_at" is null) and ("roster_periods"."published_at" is null) = ("roster_periods"."published_by" is null)),
	CONSTRAINT "roster_periods_superseded_ck" CHECK (("roster_periods"."status" = 'superseded') = ("roster_periods"."superseded_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_period_id_roster_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."roster_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_role_key_roles_key_fk" FOREIGN KEY ("role_key") REFERENCES "public"."roles"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_location_resource_id_resources_id_fk" FOREIGN KEY ("location_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_swap_of_id_roster_assignments_id_fk" FOREIGN KEY ("swap_of_id") REFERENCES "public"."roster_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_periods" ADD CONSTRAINT "roster_periods_superseded_by_period_id_roster_periods_id_fk" FOREIGN KEY ("superseded_by_period_id") REFERENCES "public"."roster_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roster_assignments_period_idx" ON "roster_assignments" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "roster_assignments_user_window_idx" ON "roster_assignments" USING btree ("user_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "roster_assignments_role_window_idx" ON "roster_assignments" USING btree ("role_key","starts_at","ends_at") WHERE "roster_assignments"."effective";--> statement-breakpoint
CREATE UNIQUE INDEX "roster_periods_scope_start_version_ux" ON "roster_periods" USING btree ("site_id","scope_type",coalesce("scope_id", ''),"starts_at","version");--> statement-breakpoint
CREATE UNIQUE INDEX "roster_periods_one_published_ux" ON "roster_periods" USING btree ("site_id","scope_type",coalesce("scope_id", ''),"starts_at") WHERE "roster_periods"."status" = 'published';--> statement-breakpoint
CREATE INDEX "roster_periods_status_window_idx" ON "roster_periods" USING btree ("status","starts_at","ends_at");--> statement-breakpoint
-- HAND-WRITTEN, and invisible to the drizzle snapshot (drizzle-kit does not model EXCLUDE) — see the
-- header of `src/kernel/db/schema/roster.ts`. ONE PERSON CANNOT BE PHYSICALLY IN TWO PLACES: among
-- LIVE rows (`effective`, i.e. the period is published) no two `presence` windows of one user may
-- overlap. `call` is exempt on purpose — a consultant on call who also sits in OPD is not
-- double-booked. `btree_gist` supplies text equality under gist; 0021 is the precedent for an
-- extension created by a migration.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_no_double_presence_excl" EXCLUDE USING gist ("user_id" WITH =, tstzrange("starts_at", "ends_at", '[)') WITH &&) WHERE ("effective" AND "mode" = 'presence');
