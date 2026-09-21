-- PHASE R (R7) — the calendar: shift definitions, cycles, the Sunday overlay, holidays, and the
-- materialised duty windows a department actually runs on.
--
-- ONE hand-written EXCLUDE below, invisible to the drizzle snapshot as in 0109-0111;
-- `schema/roster.test.ts` asks `pg_constraint` for it by name. It needs `btree_gist` (0108).
CREATE TABLE "roster_cycle_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"cycle_id" text NOT NULL,
	"day_index" integer NOT NULL,
	"team_id" text NOT NULL,
	"activity" text NOT NULL,
	"start_minute" integer NOT NULL,
	"duration_minutes" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_cycle_entries_day_ck" CHECK ("roster_cycle_entries"."day_index" >= 0),
	CONSTRAINT "roster_cycle_entries_activity_ck" CHECK ("roster_cycle_entries"."activity" in ('opd', 'elective_ot', 'ward_teaching', 'take', 'post_take', 'backup', 'minor_ot', 'special_clinic')),
	CONSTRAINT "roster_cycle_entries_start_ck" CHECK ("roster_cycle_entries"."start_minute" between 0 and 1439),
	CONSTRAINT "roster_cycle_entries_duration_ck" CHECK ("roster_cycle_entries"."duration_minutes" between 1 and 2880)
);
--> statement-breakpoint
CREATE TABLE "roster_cycle_overlays" (
	"id" text PRIMARY KEY NOT NULL,
	"department_id" text NOT NULL,
	"sequence_position" integer NOT NULL,
	"team_id" text NOT NULL,
	"activity" text NOT NULL,
	"start_minute" integer NOT NULL,
	"duration_minutes" integer NOT NULL,
	"anchor_ist_date" date NOT NULL,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_cycle_overlays_position_ck" CHECK ("roster_cycle_overlays"."sequence_position" >= 0),
	CONSTRAINT "roster_cycle_overlays_activity_ck" CHECK ("roster_cycle_overlays"."activity" in ('opd', 'elective_ot', 'ward_teaching', 'take', 'post_take', 'backup', 'minor_ot', 'special_clinic')),
	CONSTRAINT "roster_cycle_overlays_start_ck" CHECK ("roster_cycle_overlays"."start_minute" between 0 and 1439),
	CONSTRAINT "roster_cycle_overlays_duration_ck" CHECK ("roster_cycle_overlays"."duration_minutes" between 1 and 2880)
);
--> statement-breakpoint
CREATE TABLE "roster_cycles" (
	"id" text PRIMARY KEY NOT NULL,
	"department_id" text NOT NULL,
	"cycle_days" integer NOT NULL,
	"anchor_ist_date" date NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"effective_from" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_by" text,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_cycles_days_ck" CHECK ("roster_cycles"."cycle_days" between 1 and 28),
	CONSTRAINT "roster_cycles_status_ck" CHECK ("roster_cycles"."status" in ('draft', 'published', 'superseded')),
	CONSTRAINT "roster_cycles_version_ck" CHECK ("roster_cycles"."version" >= 1),
	CONSTRAINT "roster_cycles_published_ck" CHECK (("roster_cycles"."status" = 'draft') = ("roster_cycles"."published_at" is null)
          and ("roster_cycles"."published_at" is null) = ("roster_cycles"."published_by" is null)
          and ("roster_cycles"."published_at" is null) = ("roster_cycles"."effective_from" is null))
);
--> statement-breakpoint
CREATE TABLE "roster_duty_windows" (
	"id" text PRIMARY KEY NOT NULL,
	"department_id" text NOT NULL,
	"team_id" text NOT NULL,
	"activity" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"cycle_id" text,
	"overlay_index" integer,
	"source" text DEFAULT 'cycle' NOT NULL,
	"superseded_at" timestamp with time zone,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_duty_windows_activity_ck" CHECK ("roster_duty_windows"."activity" in ('opd', 'elective_ot', 'ward_teaching', 'take', 'post_take', 'backup', 'minor_ot', 'special_clinic')),
	CONSTRAINT "roster_duty_windows_window_ck" CHECK ("roster_duty_windows"."ends_at" > "roster_duty_windows"."starts_at"),
	CONSTRAINT "roster_duty_windows_source_ck" CHECK ("roster_duty_windows"."source" in ('cycle', 'overlay', 'amendment'))
);
--> statement-breakpoint
CREATE TABLE "roster_holidays" (
	"ist_date" date NOT NULL,
	"kind" text NOT NULL,
	"applies_to" text[] DEFAULT '{}'::text[] NOT NULL,
	"pattern" text DEFAULT 'as_sunday' NOT NULL,
	"declared_by" text NOT NULL,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmation_due_at" timestamp with time zone,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_holidays_site_id_ist_date_pk" PRIMARY KEY("site_id","ist_date"),
	CONSTRAINT "roster_holidays_kind_ck" CHECK ("roster_holidays"."kind" in ('gazetted', 'restricted', 'declared', 'local')),
	CONSTRAINT "roster_holidays_pattern_ck" CHECK ("roster_holidays"."pattern" in ('as_sunday', 'opd_short', 'opd_off_ot_proceeds'))
);
--> statement-breakpoint
CREATE TABLE "roster_shift_defs" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"department_id" text,
	"start_minute" integer NOT NULL,
	"duration_minutes" integer NOT NULL,
	"handover_minutes" integer DEFAULT 0 NOT NULL,
	"counts_as_night" boolean DEFAULT false NOT NULL,
	"default_mode" text DEFAULT 'presence' NOT NULL,
	"max_presence_hours" integer DEFAULT 12 NOT NULL,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_shift_defs_start_ck" CHECK ("roster_shift_defs"."start_minute" between 0 and 1439),
	CONSTRAINT "roster_shift_defs_duration_ck" CHECK ("roster_shift_defs"."duration_minutes" between 1 and 2160),
	CONSTRAINT "roster_shift_defs_handover_ck" CHECK ("roster_shift_defs"."handover_minutes" between 0 and 240),
	CONSTRAINT "roster_shift_defs_mode_ck" CHECK ("roster_shift_defs"."default_mode" in ('presence', 'call'))
);
--> statement-breakpoint
ALTER TABLE "roster_cycle_entries" ADD CONSTRAINT "roster_cycle_entries_cycle_id_roster_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."roster_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_cycle_entries" ADD CONSTRAINT "roster_cycle_entries_team_id_roster_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."roster_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_cycle_overlays" ADD CONSTRAINT "roster_cycle_overlays_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_cycle_overlays" ADD CONSTRAINT "roster_cycle_overlays_team_id_roster_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."roster_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_cycles" ADD CONSTRAINT "roster_cycles_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_duty_windows" ADD CONSTRAINT "roster_duty_windows_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_duty_windows" ADD CONSTRAINT "roster_duty_windows_team_id_roster_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."roster_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_duty_windows" ADD CONSTRAINT "roster_duty_windows_cycle_id_roster_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."roster_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_holidays" ADD CONSTRAINT "roster_holidays_declared_by_users_id_fk" FOREIGN KEY ("declared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_shift_defs" ADD CONSTRAINT "roster_shift_defs_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roster_cycle_entries_cycle_idx" ON "roster_cycle_entries" USING btree ("cycle_id","day_index");--> statement-breakpoint
CREATE UNIQUE INDEX "roster_cycle_overlays_position_ux" ON "roster_cycle_overlays" USING btree ("site_id","department_id","sequence_position","activity");--> statement-breakpoint
CREATE UNIQUE INDEX "roster_cycles_dept_version_ux" ON "roster_cycles" USING btree ("site_id","department_id","version");--> statement-breakpoint
CREATE INDEX "roster_duty_windows_dept_idx" ON "roster_duty_windows" USING btree ("department_id","starts_at");--> statement-breakpoint
CREATE INDEX "roster_duty_windows_live_idx" ON "roster_duty_windows" USING btree ("department_id","activity","starts_at") WHERE "roster_duty_windows"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "roster_shift_defs_code_ux" ON "roster_shift_defs" USING btree ("site_id",coalesce("department_id", ''),"code");--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_shift_def_id_roster_shift_defs_id_fk" FOREIGN KEY ("shift_def_id") REFERENCES "public"."roster_shift_defs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- V11, THE HALF A CONSTRAINT CAN HOLD: A DEPARTMENT'S TAKE WINDOWS NEVER OVERLAP.
--
-- Two units believing they are on take for the same hour is the failure that puts one patient in
-- front of two teams and the next in front of none. The other half of V11 — that they never GAP —
-- cannot be a constraint (absence is not a row), so it is `takeGaps()` plus a `standup:check` row.
--
-- Partial on live rows, because re-materialising a stretch supersedes the old windows and writes
-- the new ones in the same transaction: without the partial, every republish would collide with
-- what it is replacing.
ALTER TABLE "roster_duty_windows"
  ADD CONSTRAINT "roster_duty_windows_take_no_overlap_excl"
  EXCLUDE USING gist (
    "site_id" WITH =,
    "department_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("activity" = 'take' AND "superseded_at" IS NULL);
