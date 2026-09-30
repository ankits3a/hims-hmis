CREATE TABLE "aerb_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_no" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"device_resource_id" text,
	"affected_type" text NOT NULL,
	"patient_id" text,
	"worker_user_id" text,
	"affected_name" text,
	"estimated_dose_msv" numeric(10, 3),
	"dose_note" text,
	"description" text NOT NULL,
	"immediate_action" text NOT NULL,
	"root_cause" text,
	"corrective_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"significantly_above_intended" boolean DEFAULT false NOT NULL,
	"notify_required" boolean NOT NULL,
	"notified_on" date,
	"notification_ref" text,
	"state" text DEFAULT 'open' NOT NULL,
	"investigated_at" timestamp with time zone,
	"investigated_by" text,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"closure_note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "aerb_incidents_kind_ck" CHECK ("aerb_incidents"."kind" in ('wrong_patient', 'wrong_study', 'pregnant_patient', 'repeat_over_threshold', 'equipment_malfunction', 'worker_over_limit', 'other')),
	CONSTRAINT "aerb_incidents_state_ck" CHECK ("aerb_incidents"."state" in ('open', 'investigated', 'closed')),
	CONSTRAINT "aerb_incidents_affected_ck" CHECK ("aerb_incidents"."affected_type" in ('patient', 'worker', 'other')),
	CONSTRAINT "aerb_incidents_who_ck" CHECK (("aerb_incidents"."affected_type" <> 'patient' or "aerb_incidents"."patient_id" is not null)
          and ("aerb_incidents"."affected_type" <> 'worker' or "aerb_incidents"."worker_user_id" is not null)
          and ("aerb_incidents"."affected_type" <> 'other' or "aerb_incidents"."affected_name" is not null)),
	CONSTRAINT "aerb_incidents_dose_ck" CHECK ("aerb_incidents"."estimated_dose_msv" is null or "aerb_incidents"."estimated_dose_msv" >= 0),
	CONSTRAINT "aerb_incidents_notified_ck" CHECK (("aerb_incidents"."notified_on" is null) = ("aerb_incidents"."notification_ref" is null)),
	CONSTRAINT "aerb_incidents_closed_ck" CHECK (("aerb_incidents"."state" = 'closed') = ("aerb_incidents"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "aerb_pregnancy_declarations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"declared_on" date NOT NULL,
	"expected_on" date NOT NULL,
	"ended_on" date,
	"end_reason" text,
	"remarks" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aerb_pregnancy_declarations_expected_ck" CHECK ("aerb_pregnancy_declarations"."expected_on" >= "aerb_pregnancy_declarations"."declared_on"),
	CONSTRAINT "aerb_pregnancy_declarations_ended_ck" CHECK ("aerb_pregnancy_declarations"."ended_on" is null or "aerb_pregnancy_declarations"."ended_on" >= "aerb_pregnancy_declarations"."declared_on")
);
--> statement-breakpoint
ALTER TABLE "aerb_incidents" ADD CONSTRAINT "aerb_incidents_device_resource_id_resources_id_fk" FOREIGN KEY ("device_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aerb_incidents" ADD CONSTRAINT "aerb_incidents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aerb_incidents" ADD CONSTRAINT "aerb_incidents_worker_user_id_users_id_fk" FOREIGN KEY ("worker_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aerb_pregnancy_declarations" ADD CONSTRAINT "aerb_pregnancy_declarations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aerb_incidents_no_ux" ON "aerb_incidents" USING btree ("incident_no");--> statement-breakpoint
CREATE INDEX "aerb_incidents_state_idx" ON "aerb_incidents" USING btree ("state","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "aerb_pregnancy_declarations_active_ux" ON "aerb_pregnancy_declarations" USING btree ("user_id") WHERE "aerb_pregnancy_declarations"."ended_on" is null;