-- STAGE ONLY (lane ipd-stage, 2026-10-23) — never merged to main. Main's 0222_lab_critical_ladder re-creates
-- roster_escalation_targets_kind_ck with main's kinds only, which drops the ER kinds 0235–0240 added. This puts
-- back the union the merged TypeScript schema declares (roster.ts). UAT holds no rows in this table (checked).
ALTER TABLE "roster_escalation_targets" DROP CONSTRAINT "roster_escalation_targets_kind_ck";--> statement-breakpoint
ALTER TABLE "roster_escalation_targets" ADD CONSTRAINT "roster_escalation_targets_kind_ck" CHECK ("roster_escalation_targets"."alert_kind" in ('escalation.triggered', 'notification.failed', 'ops.mode_changed', 'imaging.critical_overdue', 'imaging.report_unread', 'workflow.timer_rung', 'er_retriage', 'er_call', 'er_critical', 'mlc_intimation', 'mlc_countersign', 'er_abscond', 'er_boarding', 'er_abscond_mlc', 'code_blue', 'code_grey', 'lab.critical_overdue'));
