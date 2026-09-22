-- PHASE R (R6) — where an escalation goes, as a configuration row rather than a constant in a
-- kernel file. No hand-written object: this table needs no EXCLUDE, and its one unique index is over
-- `coalesce(department_id, '')` so that two hospital-wide rows for one alert kind — two answers at
-- 02:14 — are unrepresentable.
CREATE TABLE "roster_escalation_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"alert_kind" text NOT NULL,
	"position_key" text NOT NULL,
	"department_id" text,
	"fallback_role_key" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_escalation_targets_kind_ck" CHECK ("roster_escalation_targets"."alert_kind" in ('escalation.triggered', 'notification.failed', 'ops.mode_changed', 'imaging.critical_overdue', 'imaging.report_unread', 'workflow.timer_rung'))
);
--> statement-breakpoint
ALTER TABLE "roster_escalation_targets" ADD CONSTRAINT "roster_escalation_targets_position_key_roster_positions_key_fk" FOREIGN KEY ("position_key") REFERENCES "public"."roster_positions"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_escalation_targets" ADD CONSTRAINT "roster_escalation_targets_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_escalation_targets" ADD CONSTRAINT "roster_escalation_targets_fallback_role_key_roles_key_fk" FOREIGN KEY ("fallback_role_key") REFERENCES "public"."roles"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "roster_escalation_targets_kind_dept_ux" ON "roster_escalation_targets" USING btree ("site_id","alert_kind",coalesce("department_id", ''));