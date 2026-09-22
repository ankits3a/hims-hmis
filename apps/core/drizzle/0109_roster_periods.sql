-- PHASE R (R2) — periods, slots and amendments, and the THREE things drizzle-kit cannot model.
--
-- Everything below the generated block is hand-written and is invisible to the snapshot: a later
-- `generate` will neither recreate nor drop any of it. `schema/roster.test.ts` is what knows they
-- exist, and it asks `pg_constraint` and `pg_indexes` rather than trusting this file. They need
-- `btree_gist`, created by 0108.
CREATE TABLE "roster_amendments" (
	"id" text PRIMARY KEY NOT NULL,
	"period_id" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"after_the_fact" boolean DEFAULT false NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_count" integer DEFAULT 0 NOT NULL,
	"added_count" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_amendments_kind_ck" CHECK ("roster_amendments"."kind" in ('swap', 'cover', 'float', 'withdrawal', 'correction', 'hold_over')),
	CONSTRAINT "roster_amendments_reason_ck" CHECK (length(btrim("roster_amendments"."reason")) between 1 and 500),
	CONSTRAINT "roster_amendments_counts_ck" CHECK ("roster_amendments"."superseded_count" >= 0 and "roster_amendments"."added_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "roster_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"period_id" text NOT NULL,
	"user_id" text,
	"position_key" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"mode" text DEFAULT 'presence',
	"kind" text DEFAULT 'duty' NOT NULL,
	"off_kind" text,
	"department_id" text NOT NULL,
	"team_id" text,
	"cover_scope" text DEFAULT 'team' NOT NULL,
	"call_tier" smallint,
	"supernumerary" boolean DEFAULT false NOT NULL,
	"shift_def_id" text,
	"location_resource_id" text,
	"batch_ref" text,
	"topic" text,
	"swap_of_id" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"note" text,
	"effective" boolean DEFAULT false NOT NULL,
	"live_from" timestamp with time zone DEFAULT now() NOT NULL,
	"live_to" timestamp with time zone,
	"amendment_id" text,
	"lineage_id" text NOT NULL,
	"proposed_by_actor_type" text DEFAULT 'user' NOT NULL,
	"proposed_by_actor_id" text NOT NULL,
	"proposal_run_id" text,
	"confirmed_by_user_id" text,
	"confirmed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_assignments_window_ck" CHECK ("roster_assignments"."ends_at" > "roster_assignments"."starts_at"),
	CONSTRAINT "roster_assignments_mode_ck" CHECK ("roster_assignments"."mode" is null or "roster_assignments"."mode" in ('presence', 'call')),
	CONSTRAINT "roster_assignments_kind_ck" CHECK ("roster_assignments"."kind" in ('duty', 'teaching', 'off')),
	CONSTRAINT "roster_assignments_source_ck" CHECK ("roster_assignments"."source" in ('manual', 'import', 'proposer', 'academic')),
	CONSTRAINT "roster_assignments_cover_scope_ck" CHECK ("roster_assignments"."cover_scope" in ('team', 'department', 'location', 'hospital')),
	CONSTRAINT "roster_assignments_off_kind_ck" CHECK ("roster_assignments"."off_kind" is null or "roster_assignments"."off_kind" in ('WO', 'NO', 'DO', 'CO', 'PH', 'RH')),
	CONSTRAINT "roster_assignments_off_ck" CHECK (case when "roster_assignments"."kind" = 'off' then "roster_assignments"."mode" is null and "roster_assignments"."user_id" is not null and "roster_assignments"."off_kind" is not null
                else "roster_assignments"."mode" is not null and "roster_assignments"."off_kind" is null end),
	CONSTRAINT "roster_assignments_call_tier_ck" CHECK ("roster_assignments"."call_tier" is null or "roster_assignments"."call_tier" >= 1),
	CONSTRAINT "roster_assignments_presence_hours_ck" CHECK ("roster_assignments"."mode" is distinct from 'presence' or "roster_assignments"."ends_at" - "roster_assignments"."starts_at" <= interval '36 hours'),
	CONSTRAINT "roster_assignments_window_cap_ck" CHECK ("roster_assignments"."ends_at" - "roster_assignments"."starts_at" <= interval '35 days'),
	CONSTRAINT "roster_assignments_live_ck" CHECK ("roster_assignments"."live_to" is null or "roster_assignments"."live_to" > "roster_assignments"."live_from"),
	CONSTRAINT "roster_assignments_effective_ck" CHECK (not "roster_assignments"."effective" or "roster_assignments"."live_to" is null),
	CONSTRAINT "roster_assignments_confirmed_ck" CHECK (("roster_assignments"."confirmed_by_user_id" is null) = ("roster_assignments"."confirmed_at" is null)),
	CONSTRAINT "roster_assignments_actor_type_ck" CHECK ("roster_assignments"."proposed_by_actor_type" in ('user', 'agent', 'system', 'patient'))
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
	"department_id" text,
	"team_id" text,
	"covers_positions" text[] NOT NULL,
	"based_on_period_id" text,
	"content_hash" text,
	"origin" text DEFAULT 'human' NOT NULL,
	"drafted_by_actor_type" text DEFAULT 'user' NOT NULL,
	"human_touched_at" timestamp with time zone,
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
	CONSTRAINT "roster_periods_scope_type_ck" CHECK ("roster_periods"."scope_type" in ('hospital', 'department', 'team', 'location')),
	CONSTRAINT "roster_periods_scope_id_ck" CHECK (("roster_periods"."scope_type" = 'hospital') = ("roster_periods"."scope_id" is null)),
	CONSTRAINT "roster_periods_window_ck" CHECK ("roster_periods"."ends_at" > "roster_periods"."starts_at"),
	CONSTRAINT "roster_periods_version_ck" CHECK ("roster_periods"."version" >= 1),
	CONSTRAINT "roster_periods_origin_ck" CHECK ("roster_periods"."origin" in ('human', 'machine')),
	CONSTRAINT "roster_periods_actor_type_ck" CHECK ("roster_periods"."drafted_by_actor_type" in ('user', 'agent', 'system', 'patient')),
	CONSTRAINT "roster_periods_covers_ck" CHECK (coalesce(array_length("roster_periods"."covers_positions", 1), 0) >= 1),
	CONSTRAINT "roster_periods_published_ck" CHECK (("roster_periods"."status" = 'draft') = ("roster_periods"."published_at" is null) and ("roster_periods"."published_at" is null) = ("roster_periods"."published_by" is null)),
	CONSTRAINT "roster_periods_superseded_ck" CHECK (("roster_periods"."status" = 'superseded') = ("roster_periods"."superseded_at" is not null)),
	CONSTRAINT "roster_periods_supersede_order_ck" CHECK ("roster_periods"."superseded_at" is null or "roster_periods"."superseded_at" >= "roster_periods"."published_at"),
	CONSTRAINT "roster_periods_hash_ck" CHECK (("roster_periods"."status" = 'draft') = ("roster_periods"."content_hash" is null))
);
--> statement-breakpoint
ALTER TABLE "roster_amendments" ADD CONSTRAINT "roster_amendments_period_id_roster_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."roster_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_amendments" ADD CONSTRAINT "roster_amendments_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_amendments" ADD CONSTRAINT "roster_amendments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_period_id_roster_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."roster_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_position_key_roster_positions_key_fk" FOREIGN KEY ("position_key") REFERENCES "public"."roster_positions"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_location_resource_id_resources_id_fk" FOREIGN KEY ("location_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_swap_of_id_roster_assignments_id_fk" FOREIGN KEY ("swap_of_id") REFERENCES "public"."roster_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_amendment_id_roster_amendments_id_fk" FOREIGN KEY ("amendment_id") REFERENCES "public"."roster_amendments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_periods" ADD CONSTRAINT "roster_periods_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_periods" ADD CONSTRAINT "roster_periods_based_on_period_id_roster_periods_id_fk" FOREIGN KEY ("based_on_period_id") REFERENCES "public"."roster_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_periods" ADD CONSTRAINT "roster_periods_superseded_by_period_id_roster_periods_id_fk" FOREIGN KEY ("superseded_by_period_id") REFERENCES "public"."roster_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roster_amendments_period_idx" ON "roster_amendments" USING btree ("period_id","applied_at");--> statement-breakpoint
CREATE INDEX "roster_assignments_period_idx" ON "roster_assignments" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "roster_assignments_user_window_idx" ON "roster_assignments" USING btree ("user_id","starts_at");--> statement-breakpoint
CREATE INDEX "roster_assignments_lineage_idx" ON "roster_assignments" USING btree ("lineage_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roster_periods_scope_start_version_ux" ON "roster_periods" USING btree ("site_id","scope_type",coalesce("scope_id", ''),"starts_at","version");--> statement-breakpoint
CREATE INDEX "roster_periods_status_window_idx" ON "roster_periods" USING btree ("status","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "roster_periods_based_on_idx" ON "roster_periods" USING btree ("based_on_period_id");
--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- V2 — AT MOST ONE PUBLISHED ROSTER PER SCOPE, PER INSTANT.
--
-- Plan 20 T1 had a unique index on (site, scope, starts_at) WHERE published, which allows two
-- published rosters for one unit whose windows OVERLAP — a September roster running to 5 October
-- beside an October one. "Who is on at 02:00 on the 3rd?" then has two answers and no tie-break.
-- The range version cannot express that state at all.
ALTER TABLE "roster_periods"
  ADD CONSTRAINT "roster_periods_one_published_excl"
  EXCLUDE USING gist (
    "site_id" WITH =,
    "scope_type" WITH =,
    (coalesce("scope_id", '')) WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("status" = 'published');--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- V1 — ONE PERSON, ONE PLACE.
--
-- Among LIVE rows, no two PRESENCE windows of one person may overlap. `publishPeriod` refuses in a
-- sentence first, which means its own tests stay green with this constraint dropped — so
-- `schema/roster.test.ts` writes rows directly underneath the domain code and watches the database
-- say no. Partial on three conditions, each load-bearing:
--   · `effective`  — two DRAFTS may legitimately hold the same person in the same slot;
--   · `mode = 'presence'` — a consultant on call who also sits in OPD is not double-booked, that
--     is what on-call MEANS, and an OFF row has no mode at all;
--   · `user_id IS NOT NULL` — two VACANT slots are two holes, not one person in two rooms.
ALTER TABLE "roster_assignments"
  ADD CONSTRAINT "roster_assignments_no_double_presence_excl"
  EXCLUDE USING gist (
    "user_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("effective" AND "mode" = 'presence' AND "user_id" IS NOT NULL);--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The resolver's own read (R5): "who holds this POSITION at this instant", live rows only. A gist
-- index over (text, range) needs btree_gist for the text half — the same extension the two
-- constraints above need, which is why 0108 creates it whether or not anything used it yet.
CREATE INDEX "roster_assignments_position_window_idx"
  ON "roster_assignments" USING gist ("position_key", tstzrange("starts_at", "ends_at", '[)'))
  WHERE "effective";
