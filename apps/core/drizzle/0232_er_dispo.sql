CREATE TABLE "er_departure_records" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"kind" text NOT NULL,
	"document" jsonb NOT NULL,
	"signed_by" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "er_departure_records_kind_ck" CHECK ("er_departure_records"."kind" in ('discharge_summary', 'admission', 'referral', 'lama', 'lwbs', 'abscond', 'death'))
);
--> statement-breakpoint
ALTER TABLE "patients" DROP CONSTRAINT "patients_death_kind_ck";--> statement-breakpoint
ALTER TABLE "roster_escalation_targets" DROP CONSTRAINT "roster_escalation_targets_kind_ck";--> statement-breakpoint
ALTER TABLE "er_charge_lines" DROP CONSTRAINT "er_charge_lines_status_ck";--> statement-breakpoint
ALTER TABLE "er_charge_lines" DROP CONSTRAINT "er_charge_lines_amount_ck";--> statement-breakpoint
ALTER TABLE "ipd_admissions" ADD COLUMN "er_arrived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "er_charge_lines" ADD COLUMN "moved_to_admission_id" text;--> statement-breakpoint
ALTER TABLE "er_charge_lines" ADD COLUMN "moved_ipd_line_id" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "disposition" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "disposition_reason" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "disposition_by" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "disposition_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "admission_id" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "boarding_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "er_departure_records" ADD CONSTRAINT "er_departure_records_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "er_departure_records_episode_ux" ON "er_departure_records" USING btree ("episode_id");--> statement-breakpoint
CREATE INDEX "er_episodes_boarding_idx" ON "er_episodes" USING btree ("boarding_since") WHERE "er_episodes"."boarding_since" is not null and "er_episodes"."state" = 'disposition_decided';--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_death_kind_ck" CHECK ("patients"."death_kind" is null or ("patients"."death_kind" in ('brought_dead', 'medico_legal') and "patients"."deceased_at" is not null));--> statement-breakpoint
ALTER TABLE "roster_escalation_targets" ADD CONSTRAINT "roster_escalation_targets_kind_ck" CHECK ("roster_escalation_targets"."alert_kind" in ('escalation.triggered', 'notification.failed', 'ops.mode_changed', 'imaging.critical_overdue', 'imaging.report_unread', 'workflow.timer_rung', 'er_retriage', 'er_call', 'er_critical', 'mlc_intimation', 'mlc_countersign', 'er_abscond'));--> statement-breakpoint
ALTER TABLE "er_charge_lines" ADD CONSTRAINT "er_charge_lines_moved_ck" CHECK (("er_charge_lines"."status" = 'moved') = ("er_charge_lines"."moved_to_admission_id" is not null));--> statement-breakpoint
ALTER TABLE "er_charge_lines" ADD CONSTRAINT "er_charge_lines_status_ck" CHECK ("er_charge_lines"."status" in ('posted', 'rate_missing', 'rate_pending', 'reversed', 'moved'));--> statement-breakpoint
ALTER TABLE "er_charge_lines" ADD CONSTRAINT "er_charge_lines_amount_ck" CHECK (("er_charge_lines"."status" = 'posted') = ("er_charge_lines"."amount_paise" is not null) or "er_charge_lines"."status" = 'moved');--> statement-breakpoint
ALTER TABLE "er_episodes" ADD CONSTRAINT "er_episodes_disposition_ck" CHECK ("er_episodes"."disposition" is null or "er_episodes"."disposition" in ('discharge', 'admit', 'refer_out'));--> statement-breakpoint
ALTER TABLE "er_episodes" ADD CONSTRAINT "er_episodes_outcome_ck" CHECK ("er_episodes"."outcome" is null or "er_episodes"."outcome" in ('discharged', 'admitted', 'referred_out', 'lama', 'absconded', 'lwbs', 'died'));--> statement-breakpoint
CREATE FUNCTION er_departure_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'er_departure_append_only: % rows are never edited or deleted (% refused)', TG_TABLE_NAME, TG_OP; END $$;--> statement-breakpoint
CREATE TRIGGER er_departure_records_append_only BEFORE UPDATE OR DELETE ON er_departure_records FOR EACH ROW EXECUTE FUNCTION er_departure_forbid_mutation();
