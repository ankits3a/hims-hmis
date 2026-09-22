-- PHASE R (R3) — teams, the people in them, who stands in, and who may act for whom.
--
-- Three EXCLUDE constraints are hand-written below and are invisible to the drizzle snapshot, as in
-- 0109: `schema/roster.test.ts` asks `pg_constraint` for them by name. All three need `btree_gist`
-- (0108) for equality over text under gist.
CREATE TABLE "roster_bed_allotments" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_bed_allotments_window_ck" CHECK ("roster_bed_allotments"."ends_at" is null or "roster_bed_allotments"."ends_at" > "roster_bed_allotments"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "roster_delegations" (
	"id" text PRIMARY KEY NOT NULL,
	"delegator_user_id" text NOT NULL,
	"delegate_user_id" text NOT NULL,
	"authority" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_delegations_authority_ck" CHECK ("roster_delegations"."authority" in ('publish', 'approve_swap', 'override_rule', 'approve_leave', 'declare_holiday', 'declare_mode')),
	CONSTRAINT "roster_delegations_scope_ck" CHECK ("roster_delegations"."scope_type" in ('hospital', 'department', 'team', 'location')),
	CONSTRAINT "roster_delegations_scope_id_ck" CHECK (("roster_delegations"."scope_type" = 'hospital') = ("roster_delegations"."scope_id" is null)),
	CONSTRAINT "roster_delegations_window_ck" CHECK ("roster_delegations"."ends_at" > "roster_delegations"."starts_at"),
	CONSTRAINT "roster_delegations_reason_ck" CHECK (length(btrim("roster_delegations"."reason")) between 1 and 500),
	CONSTRAINT "roster_delegations_distinct_ck" CHECK ("roster_delegations"."delegate_user_id" <> "roster_delegations"."delegator_user_id")
);
--> statement-breakpoint
CREATE TABLE "roster_officiating" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"reason" text NOT NULL,
	"approved_by" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_officiating_role_ck" CHECK ("roster_officiating"."role" in ('head', 'hod', 'lead')),
	CONSTRAINT "roster_officiating_window_ck" CHECK ("roster_officiating"."ends_at" is null or "roster_officiating"."ends_at" > "roster_officiating"."starts_at"),
	CONSTRAINT "roster_officiating_reason_ck" CHECK (length(btrim("roster_officiating"."reason")) between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "roster_team_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"position_key" text NOT NULL,
	"grade" text NOT NULL,
	"role_in_team" text NOT NULL,
	"kind" text DEFAULT 'parent' NOT NULL,
	"retains_parent_nights" boolean DEFAULT false NOT NULL,
	"supernumerary_until" timestamp with time zone,
	"pattern_offset" integer,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_team_memberships_kind_ck" CHECK ("roster_team_memberships"."kind" in ('parent', 'rotation', 'float')),
	CONSTRAINT "roster_team_memberships_role_ck" CHECK ("roster_team_memberships"."role_in_team" in ('head', 'faculty', 'senior_resident', 'junior_resident', 'intern', 'member', 'lead')),
	CONSTRAINT "roster_team_memberships_grade_ck" CHECK ("roster_team_memberships"."grade" in ('professor', 'associate_professor', 'assistant_professor', 'senior_resident', 'jr1', 'jr2', 'jr3', 'intern', 'medical_officer', 'nursing_superintendent', 'ward_sister', 'staff_nurse', 'technician', 'pharmacist', 'admin', 'support')),
	CONSTRAINT "roster_team_memberships_window_ck" CHECK ("roster_team_memberships"."ends_at" is null or "roster_team_memberships"."ends_at" > "roster_team_memberships"."starts_at"),
	CONSTRAINT "roster_team_memberships_source_ck" CHECK ("roster_team_memberships"."source" in ('manual', 'import', 'academic')),
	CONSTRAINT "roster_team_memberships_retains_ck" CHECK (not "roster_team_memberships"."retains_parent_nights" or "roster_team_memberships"."kind" = 'rotation')
);
--> statement-breakpoint
CREATE TABLE "roster_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"department_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"home_location_resource_id" text,
	"lead_user_id" text,
	"unit_number" integer,
	"sanctioned_beds" integer,
	"active" boolean DEFAULT false NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_teams_kind_ck" CHECK ("roster_teams"."kind" in ('clinical_unit', 'ward_team', 'service', 'pool')),
	CONSTRAINT "roster_teams_validity_ck" CHECK ("roster_teams"."valid_to" is null or "roster_teams"."valid_to" > "roster_teams"."valid_from"),
	CONSTRAINT "roster_teams_unit_number_ck" CHECK ("roster_teams"."unit_number" is null or "roster_teams"."unit_number" >= 1),
	CONSTRAINT "roster_teams_beds_ck" CHECK ("roster_teams"."sanctioned_beds" is null or "roster_teams"."sanctioned_beds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "roster_bed_allotments" ADD CONSTRAINT "roster_bed_allotments_team_id_roster_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."roster_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_bed_allotments" ADD CONSTRAINT "roster_bed_allotments_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_delegations" ADD CONSTRAINT "roster_delegations_delegator_user_id_users_id_fk" FOREIGN KEY ("delegator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_delegations" ADD CONSTRAINT "roster_delegations_delegate_user_id_users_id_fk" FOREIGN KEY ("delegate_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_officiating" ADD CONSTRAINT "roster_officiating_team_id_roster_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."roster_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_officiating" ADD CONSTRAINT "roster_officiating_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_officiating" ADD CONSTRAINT "roster_officiating_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_team_memberships" ADD CONSTRAINT "roster_team_memberships_team_id_roster_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."roster_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_team_memberships" ADD CONSTRAINT "roster_team_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_team_memberships" ADD CONSTRAINT "roster_team_memberships_position_key_roster_positions_key_fk" FOREIGN KEY ("position_key") REFERENCES "public"."roster_positions"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_teams" ADD CONSTRAINT "roster_teams_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_teams" ADD CONSTRAINT "roster_teams_home_location_resource_id_resources_id_fk" FOREIGN KEY ("home_location_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_teams" ADD CONSTRAINT "roster_teams_lead_user_id_users_id_fk" FOREIGN KEY ("lead_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roster_bed_allotments_team_idx" ON "roster_bed_allotments" USING btree ("team_id","starts_at");--> statement-breakpoint
CREATE INDEX "roster_delegations_delegate_idx" ON "roster_delegations" USING btree ("delegate_user_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "roster_officiating_team_idx" ON "roster_officiating" USING btree ("team_id","role","starts_at");--> statement-breakpoint
CREATE INDEX "roster_team_memberships_team_idx" ON "roster_team_memberships" USING btree ("team_id","starts_at");--> statement-breakpoint
CREATE INDEX "roster_team_memberships_user_idx" ON "roster_team_memberships" USING btree ("user_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "roster_teams_code_ux" ON "roster_teams" USING btree ("site_id","code");--> statement-breakpoint
CREATE INDEX "roster_teams_department_idx" ON "roster_teams" USING btree ("department_id","active");--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_team_id_roster_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."roster_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_periods" ADD CONSTRAINT "roster_periods_team_id_roster_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."roster_teams"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- A PERSON BELONGS TO ONE UNIT AT A TIME.
--
-- Partial on `kind = 'parent'`, which is the whole point: a rotation and a float are ADDITIONAL
-- places, and a resident posted to ICU for three months is still Medicine's. Without the partial
-- this constraint would refuse every rotation in the hospital; without the constraint, a transfer
-- typed as an insert leaves somebody in two units and every requirement count is wrong in two
-- departments at once.
ALTER TABLE "roster_team_memberships"
  ADD CONSTRAINT "roster_team_memberships_one_parent_excl"
  EXCLUDE USING gist (
    "user_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("kind" = 'parent');--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- A TEAM HAS ONE SUBSTANTIVE HEAD AT A TIME.
--
-- `roster_officiating` is how somebody stands in while the head is away, and it is a different
-- table precisely so that this constraint can stay absolute: two rows each claiming to be the
-- substantive head is an establishment nobody can file a return from.
ALTER TABLE "roster_team_memberships"
  ADD CONSTRAINT "roster_team_memberships_one_head_excl"
  EXCLUDE USING gist (
    "team_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("kind" = 'parent' AND "role_in_team" = 'head');--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- ONE PERSON STANDS IN FOR ONE ROLE AT A TIME.
--
-- Two people each believing they are acting head is the failure this exists for, and it is the one
-- that happens: a head goes on leave twice in a term and the second row is entered without the
-- first being closed.
ALTER TABLE "roster_officiating"
  ADD CONSTRAINT "roster_officiating_one_per_role_excl"
  EXCLUDE USING gist (
    "team_id" WITH =,
    "role" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  );
