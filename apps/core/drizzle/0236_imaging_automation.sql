CREATE TABLE "imaging_automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"day" date NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ran_at" timestamp with time zone NOT NULL,
	CONSTRAINT "imaging_automation_runs_kind_ck" CHECK ("imaging_automation_runs"."kind" in ('no_show_sweep', 'patient_reminders', 'hod_digest', 'register_completeness'))
);
--> statement-breakpoint
CREATE TABLE "imaging_automation_settings" (
	"kind" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"reason" text NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "imaging_automation_settings_kind_ck" CHECK ("imaging_automation_settings"."kind" in ('no_show_sweep', 'patient_reminders', 'hod_digest', 'register_completeness')),
	CONSTRAINT "imaging_automation_settings_reason_ck" CHECK (char_length(btrim("imaging_automation_settings"."reason")) >= 3)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_automation_runs_kind_day_ux" ON "imaging_automation_runs" USING btree ("kind","day");