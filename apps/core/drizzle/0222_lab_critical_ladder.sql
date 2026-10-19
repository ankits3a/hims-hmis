ALTER TABLE "roster_escalation_targets" DROP CONSTRAINT "roster_escalation_targets_kind_ck";--> statement-breakpoint
ALTER TABLE "lab_critical_calls" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "lab_critical_calls" ADD COLUMN "ladder_rung" integer;--> statement-breakpoint
ALTER TABLE "lab_critical_calls" ADD COLUMN "last_chased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lab_critical_calls" ADD CONSTRAINT "lab_critical_calls_rung_ck" CHECK ("lab_critical_calls"."ladder_rung" is null or "lab_critical_calls"."ladder_rung" between 0 and 3);--> statement-breakpoint
ALTER TABLE "roster_escalation_targets" ADD CONSTRAINT "roster_escalation_targets_kind_ck" CHECK ("roster_escalation_targets"."alert_kind" in ('escalation.triggered', 'notification.failed', 'ops.mode_changed', 'imaging.critical_overdue', 'imaging.report_unread', 'workflow.timer_rung', 'lab.critical_overdue'));