CREATE TABLE "imaging_critical_call_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"critical_id" text NOT NULL,
	"rung" smallint NOT NULL,
	"called_user_id" text,
	"called_name" text,
	"outcome" text NOT NULL,
	"recorded_by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_critical_call_attempts_rung_ck" CHECK ("imaging_critical_call_attempts"."rung" between 0 and 3),
	CONSTRAINT "imaging_critical_call_attempts_outcome_ck" CHECK ("imaging_critical_call_attempts"."outcome" in ('no_answer', 'answered', 'read_back_ok')),
	CONSTRAINT "imaging_critical_call_attempts_callee_ck" CHECK ("imaging_critical_call_attempts"."called_user_id" is not null or "imaging_critical_call_attempts"."called_name" is not null)
);
--> statement-breakpoint
ALTER TABLE "imaging_reports" DROP CONSTRAINT "imaging_reports_status_ck";--> statement-breakpoint
ALTER TABLE "imaging_critical_findings" ADD COLUMN "ladder_rung" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imaging_critical_findings" ADD COLUMN "chase_windows" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imaging_critical_call_attempts" ADD CONSTRAINT "imaging_critical_call_attempts_critical_id_imaging_critical_findings_id_fk" FOREIGN KEY ("critical_id") REFERENCES "public"."imaging_critical_findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imaging_critical_call_attempts_critical_idx" ON "imaging_critical_call_attempts" USING btree ("critical_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_reports_one_awaiting_ux" ON "imaging_reports" USING btree ("study_id") WHERE "imaging_reports"."status" = 'awaiting_cosign';--> statement-breakpoint
ALTER TABLE "imaging_critical_findings" ADD CONSTRAINT "imaging_critical_findings_rung_ck" CHECK ("imaging_critical_findings"."ladder_rung" between 0 and 3 and "imaging_critical_findings"."chase_windows" between 0 and 3);--> statement-breakpoint
ALTER TABLE "imaging_reports" ADD CONSTRAINT "imaging_reports_status_ck" CHECK ("imaging_reports"."status" in ('prelim', 'draft', 'signed', 'amended', 'superseded', 'awaiting_cosign', 'cosigned'));