CREATE TABLE "roster_cover_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'asked' NOT NULL,
	"assignment_id" text NOT NULL,
	"period_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"counterpart_id" text NOT NULL,
	"counterpart_assignment_id" text,
	"department_id" text NOT NULL,
	"team_id" text,
	"counterpart_team_id" text,
	"cross_unit" boolean DEFAULT false NOT NULL,
	"note" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"refused_rule" text,
	"decision_note" text,
	"amendment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_cover_requests_kind_ck" CHECK ("roster_cover_requests"."kind" in ('cover', 'swap')),
	CONSTRAINT "roster_cover_requests_status_ck" CHECK ("roster_cover_requests"."status" in ('asked', 'accepted', 'declined', 'approved', 'refused', 'withdrawn')),
	CONSTRAINT "roster_cover_requests_swap_ck" CHECK (("roster_cover_requests"."kind" = 'swap') = ("roster_cover_requests"."counterpart_assignment_id" is not null)),
	CONSTRAINT "roster_cover_requests_distinct_ck" CHECK ("roster_cover_requests"."counterpart_id" <> "roster_cover_requests"."owner_id"),
	CONSTRAINT "roster_cover_requests_note_ck" CHECK ("roster_cover_requests"."note" is null or length("roster_cover_requests"."note") <= 280),
	CONSTRAINT "roster_cover_requests_decided_ck" CHECK (("roster_cover_requests"."decided_at" is null) = ("roster_cover_requests"."decided_by" is null))
);
--> statement-breakpoint
CREATE TABLE "roster_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"department_id" text,
	"user_id" text,
	"at" timestamp with time zone NOT NULL,
	"note" text NOT NULL,
	"raised_by" text NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_flags_note_ck" CHECK (length(btrim("roster_flags"."note")) between 1 and 200),
	CONSTRAINT "roster_flags_resolved_ck" CHECK (("roster_flags"."resolved_at" is null) = ("roster_flags"."resolved_by" is null))
);
--> statement-breakpoint
ALTER TABLE "roster_cover_requests" ADD CONSTRAINT "roster_cover_requests_assignment_id_roster_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."roster_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_cover_requests" ADD CONSTRAINT "roster_cover_requests_period_id_roster_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."roster_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_cover_requests" ADD CONSTRAINT "roster_cover_requests_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_cover_requests" ADD CONSTRAINT "roster_cover_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_cover_requests" ADD CONSTRAINT "roster_cover_requests_counterpart_id_users_id_fk" FOREIGN KEY ("counterpart_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_cover_requests" ADD CONSTRAINT "roster_cover_requests_counterpart_assignment_id_roster_assignments_id_fk" FOREIGN KEY ("counterpart_assignment_id") REFERENCES "public"."roster_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_cover_requests" ADD CONSTRAINT "roster_cover_requests_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_cover_requests" ADD CONSTRAINT "roster_cover_requests_team_id_roster_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."roster_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_cover_requests" ADD CONSTRAINT "roster_cover_requests_counterpart_team_id_roster_teams_id_fk" FOREIGN KEY ("counterpart_team_id") REFERENCES "public"."roster_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_cover_requests" ADD CONSTRAINT "roster_cover_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_flags" ADD CONSTRAINT "roster_flags_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_flags" ADD CONSTRAINT "roster_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_flags" ADD CONSTRAINT "roster_flags_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_flags" ADD CONSTRAINT "roster_flags_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "roster_cover_requests_open_uq" ON "roster_cover_requests" USING btree ("assignment_id") WHERE "roster_cover_requests"."status" in ('asked', 'accepted');--> statement-breakpoint
CREATE INDEX "roster_cover_requests_counterpart_idx" ON "roster_cover_requests" USING btree ("counterpart_id","status");--> statement-breakpoint
CREATE INDEX "roster_cover_requests_dept_idx" ON "roster_cover_requests" USING btree ("department_id","status");--> statement-breakpoint
CREATE INDEX "roster_flags_open_idx" ON "roster_flags" USING btree ("raised_at") WHERE "roster_flags"."resolved_at" is null;