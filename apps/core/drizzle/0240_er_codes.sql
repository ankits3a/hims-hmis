CREATE TABLE "er_code_events" (
	"id" text PRIMARY KEY NOT NULL,
	"code_id" text NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"from_paper" boolean NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "er_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"episode_id" text,
	"patient_id" text,
	"bay_id" text,
	"place" text,
	"note" text,
	"called_by" text NOT NULL,
	"called_at" timestamp with time zone NOT NULL,
	"door_at" timestamp with time zone,
	"team" jsonb NOT NULL,
	"scribe_id" text,
	"leader_id" text,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"incident_draft" text,
	"debrief" jsonb,
	"debrief_by" text,
	"debrief_at" timestamp with time zone,
	CONSTRAINT "er_codes_kind_ck" CHECK ("er_codes"."kind" in ('code_blue', 'code_grey', 'stemi', 'stroke', 'trauma', 'sepsis', 'snakebite', 'obstetric')),
	CONSTRAINT "er_codes_outcome_ck" CHECK (("er_codes"."ended_at" is null) = ("er_codes"."outcome" is null))
);
--> statement-breakpoint
ALTER TABLE "roster_escalation_targets" DROP CONSTRAINT "roster_escalation_targets_kind_ck";--> statement-breakpoint
ALTER TABLE "er_code_events" ADD CONSTRAINT "er_code_events_code_id_er_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."er_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_codes" ADD CONSTRAINT "er_codes_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "er_code_events_code_idx" ON "er_code_events" USING btree ("code_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "er_codes_running_ux" ON "er_codes" USING btree ("episode_id","kind") WHERE "er_codes"."ended_at" is null and "er_codes"."episode_id" is not null;--> statement-breakpoint
CREATE INDEX "er_codes_running_idx" ON "er_codes" USING btree ("called_at") WHERE "er_codes"."ended_at" is null;--> statement-breakpoint
ALTER TABLE "roster_escalation_targets" ADD CONSTRAINT "roster_escalation_targets_kind_ck" CHECK ("roster_escalation_targets"."alert_kind" in ('escalation.triggered', 'notification.failed', 'ops.mode_changed', 'imaging.critical_overdue', 'imaging.report_unread', 'workflow.timer_rung', 'er_retriage', 'er_call', 'er_critical', 'mlc_intimation', 'mlc_countersign', 'er_abscond', 'er_boarding', 'er_abscond_mlc', 'code_blue', 'code_grey'));--> statement-breakpoint
CREATE FUNCTION er_code_event_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'er_code_events_append_only: % rows are never edited or deleted (% refused)', TG_TABLE_NAME, TG_OP; END $$;--> statement-breakpoint
CREATE TRIGGER er_code_events_append_only BEFORE UPDATE OR DELETE ON er_code_events FOR EACH ROW EXECUTE FUNCTION er_code_event_forbid_mutation();
