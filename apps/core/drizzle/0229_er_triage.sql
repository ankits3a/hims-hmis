CREATE TABLE "er_triage_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"kind" text NOT NULL,
	"level" integer,
	"algorithm_level" integer,
	"decision" jsonb,
	"reason" text,
	"vitals" jsonb,
	"ews_kind" text,
	"ews_value" integer,
	"ews_band" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"provenance" text NOT NULL,
	CONSTRAINT "er_triage_entries_kind_ck" CHECK ("er_triage_entries"."kind" in ('triage', 're_triage', 'vitals')),
	CONSTRAINT "er_triage_entries_level_ck" CHECK (("er_triage_entries"."kind" = 'vitals') = ("er_triage_entries"."level" is null))
);
--> statement-breakpoint
ALTER TABLE "roster_escalation_targets" DROP CONSTRAINT "roster_escalation_targets_kind_ck";--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "esi" integer;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "triaged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "last_triage_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "retriage_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "ews_kind" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "ews_value" integer;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "ews_band" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "bay_id" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "doctor_id" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "take_department_id" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "take_team_id" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "take_source" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "retriage_task_id" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "retriage_task_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "retriage_climbed_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "er_pre_alerts" ADD COLUMN "patient_id" text;--> statement-breakpoint
ALTER TABLE "er_pre_alerts" ADD COLUMN "red_flag_key" text;--> statement-breakpoint
ALTER TABLE "er_triage_entries" ADD CONSTRAINT "er_triage_entries_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "er_triage_entries_episode_idx" ON "er_triage_entries" USING btree ("episode_id","recorded_at");--> statement-breakpoint
ALTER TABLE "er_episodes" ADD CONSTRAINT "er_episodes_bay_id_resources_id_fk" FOREIGN KEY ("bay_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_pre_alerts" ADD CONSTRAINT "er_pre_alerts_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "er_episodes_open_bay_ux" ON "er_episodes" USING btree ("bay_id") WHERE "er_episodes"."bay_id" is not null and "er_episodes"."state" in ('arrived', 'triaged', 'in_treatment', 'disposition_decided');--> statement-breakpoint
CREATE INDEX "er_episodes_retriage_due_idx" ON "er_episodes" USING btree ("retriage_due_at") WHERE "er_episodes"."state" = 'triaged' and "er_episodes"."retriage_due_at" is not null;--> statement-breakpoint
ALTER TABLE "roster_escalation_targets" ADD CONSTRAINT "roster_escalation_targets_kind_ck" CHECK ("roster_escalation_targets"."alert_kind" in ('escalation.triggered', 'notification.failed', 'ops.mode_changed', 'imaging.critical_overdue', 'imaging.report_unread', 'workflow.timer_rung', 'er_retriage'));--> statement-breakpoint
ALTER TABLE "er_episodes" ADD CONSTRAINT "er_episodes_esi_ck" CHECK ("er_episodes"."esi" is null or "er_episodes"."esi" between 1 and 5);