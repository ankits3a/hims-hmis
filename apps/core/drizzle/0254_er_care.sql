CREATE TABLE "er_charge_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"source" text NOT NULL,
	"department" text,
	"order_id" text,
	"order_item_id" text,
	"issue_id" text,
	"procedure_id" text,
	"service_id" text,
	"item_id" text,
	"qty" integer NOT NULL,
	"amount_paise" integer,
	"status" text NOT NULL,
	"posted_by" text NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"reversed_at" timestamp with time zone,
	"reverse_reason" text,
	CONSTRAINT "er_charge_lines_source_ck" CHECK ("er_charge_lines"."source" in ('er.order', 'er.issue', 'er.procedure')),
	CONSTRAINT "er_charge_lines_status_ck" CHECK ("er_charge_lines"."status" in ('posted', 'rate_missing', 'rate_pending', 'reversed')),
	CONSTRAINT "er_charge_lines_amount_ck" CHECK (("er_charge_lines"."status" = 'posted') = ("er_charge_lines"."amount_paise" is not null))
);
--> statement-breakpoint
CREATE TABLE "er_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"kind" text NOT NULL,
	"about" text NOT NULL,
	"signed_by" text NOT NULL,
	"signer_name" text,
	"relation" text,
	"method" text NOT NULL,
	"witness_name" text,
	"second_doctor_id" text,
	"language" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "er_consents_emergency_ck" CHECK (("er_consents"."signed_by" = 'emergency') = ("er_consents"."second_doctor_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "er_critical_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"call_id" text NOT NULL,
	"episode_id" text NOT NULL,
	"notified_at" timestamp with time zone NOT NULL,
	"notified_user_ids" jsonb NOT NULL,
	"climbed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "er_doses" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"second_check_by" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "er_doses_outcome_ck" CHECK ("er_doses"."outcome" in ('given', 'held', 'refused'))
);
--> statement-breakpoint
CREATE TABLE "er_med_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"item_id" text,
	"own_medicine" text,
	"name" text NOT NULL,
	"dose_words" text NOT NULL,
	"route" text NOT NULL,
	"units" integer NOT NULL,
	"high_alert" boolean NOT NULL,
	"store_id" text,
	"batches" jsonb NOT NULL,
	"ordered_by" text NOT NULL,
	"verbal" boolean NOT NULL,
	"verbal_signed_at" timestamp with time zone,
	"verbal_notice_at" timestamp with time zone,
	"allergy_override" text,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	CONSTRAINT "er_med_issues_source_ck" CHECK (("er_med_issues"."item_id" is null) <> ("er_med_issues"."own_medicine" is null))
);
--> statement-breakpoint
CREATE TABLE "er_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"author_id" text NOT NULL,
	"status" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"cosigned_by" text,
	"cosigned_at" timestamp with time zone,
	"addendum" text,
	"provenance" text NOT NULL,
	CONSTRAINT "er_notes_status_ck" CHECK ("er_notes"."status" in ('signed', 'draft')),
	CONSTRAINT "er_notes_cosign_ck" CHECK (("er_notes"."cosigned_by" is null) = ("er_notes"."cosigned_at" is null))
);
--> statement-breakpoint
CREATE TABLE "er_procedures" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"name" text NOT NULL,
	"service_id" text,
	"performed_by" text NOT NULL,
	"performed_at" timestamp with time zone NOT NULL,
	"consent_id" text,
	"notes" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "er_specialty_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"department_id" text NOT NULL,
	"department_code" text NOT NULL,
	"urgency" text NOT NULL,
	"reason" text NOT NULL,
	"take_team_id" text,
	"take_source" text NOT NULL,
	"callees" jsonb NOT NULL,
	"called_by" text NOT NULL,
	"called_at" timestamp with time zone NOT NULL,
	"answered_by" text,
	"answered_at" timestamp with time zone,
	"seen_by" text,
	"seen_at" timestamp with time zone,
	"climbed_at" timestamp with time zone,
	CONSTRAINT "er_specialty_calls_urgency_ck" CHECK ("er_specialty_calls"."urgency" in ('immediate', 'urgent', 'routine'))
);
--> statement-breakpoint
ALTER TABLE "roster_escalation_targets" DROP CONSTRAINT "roster_escalation_targets_kind_ck";--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "stabilised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "stabilised_by" text;--> statement-breakpoint
ALTER TABLE "er_charge_lines" ADD CONSTRAINT "er_charge_lines_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_consents" ADD CONSTRAINT "er_consents_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_critical_alerts" ADD CONSTRAINT "er_critical_alerts_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_doses" ADD CONSTRAINT "er_doses_issue_id_er_med_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."er_med_issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_med_issues" ADD CONSTRAINT "er_med_issues_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_med_issues" ADD CONSTRAINT "er_med_issues_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_notes" ADD CONSTRAINT "er_notes_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_procedures" ADD CONSTRAINT "er_procedures_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_specialty_calls" ADD CONSTRAINT "er_specialty_calls_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "er_charge_lines_order_item_ux" ON "er_charge_lines" USING btree ("order_item_id") WHERE "er_charge_lines"."order_item_id" is not null;--> statement-breakpoint
CREATE INDEX "er_charge_lines_episode_idx" ON "er_charge_lines" USING btree ("episode_id");--> statement-breakpoint
CREATE INDEX "er_consents_episode_idx" ON "er_consents" USING btree ("episode_id");--> statement-breakpoint
CREATE UNIQUE INDEX "er_critical_alerts_call_ux" ON "er_critical_alerts" USING btree ("call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "er_doses_issue_ux" ON "er_doses" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "er_med_issues_episode_idx" ON "er_med_issues" USING btree ("episode_id","issued_at");--> statement-breakpoint
CREATE INDEX "er_med_issues_verbal_idx" ON "er_med_issues" USING btree ("issued_at") WHERE "er_med_issues"."verbal" and "er_med_issues"."verbal_signed_at" is null;--> statement-breakpoint
CREATE INDEX "er_notes_episode_idx" ON "er_notes" USING btree ("episode_id","recorded_at");--> statement-breakpoint
CREATE INDEX "er_procedures_episode_idx" ON "er_procedures" USING btree ("episode_id","performed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "er_specialty_calls_open_ux" ON "er_specialty_calls" USING btree ("episode_id","department_id") WHERE "er_specialty_calls"."seen_at" is null;--> statement-breakpoint
CREATE INDEX "er_specialty_calls_unanswered_idx" ON "er_specialty_calls" USING btree ("called_at") WHERE "er_specialty_calls"."answered_at" is null and "er_specialty_calls"."climbed_at" is null;--> statement-breakpoint
ALTER TABLE "roster_escalation_targets" ADD CONSTRAINT "roster_escalation_targets_kind_ck" CHECK ("roster_escalation_targets"."alert_kind" in ('escalation.triggered', 'notification.failed', 'ops.mode_changed', 'imaging.critical_overdue', 'imaging.report_unread', 'workflow.timer_rung', 'er_retriage', 'er_call', 'er_critical', 'lab.critical_overdue'));--> statement-breakpoint
CREATE TABLE "er_med_returns" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"episode_id" text NOT NULL,
	"kind" text NOT NULL,
	"units" integer NOT NULL,
	"reason" text NOT NULL,
	"witnessed_by" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "er_med_returns_kind_ck" CHECK ("er_med_returns"."kind" in ('returned', 'wasted')),
	CONSTRAINT "er_med_returns_units_ck" CHECK ("er_med_returns"."units" > 0)
);
--> statement-breakpoint
ALTER TABLE "er_specialty_calls" ADD COLUMN "answer_note" text;--> statement-breakpoint
ALTER TABLE "er_med_returns" ADD CONSTRAINT "er_med_returns_issue_id_er_med_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."er_med_issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_med_returns" ADD CONSTRAINT "er_med_returns_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "er_med_returns_issue_ux" ON "er_med_returns" USING btree ("issue_id");