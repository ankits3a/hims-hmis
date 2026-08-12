CREATE TABLE "workflow_definition_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"definition_id" text NOT NULL,
	"approver_id" text NOT NULL,
	"role_key" text NOT NULL,
	"emergency" boolean DEFAULT false NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"def_key" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"change_class" text NOT NULL,
	"definition" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"drafted_by" text NOT NULL,
	"activated_by" text,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"definition_id" text NOT NULL,
	"def_key" text NOT NULL,
	"current_state" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"patient_id" text,
	"encounter_id" text,
	"state_entered_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_timers" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"state" text NOT NULL,
	"kind" text NOT NULL,
	"rung" integer,
	"due_at" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_definition_approvals" ADD CONSTRAINT "workflow_definition_approvals_definition_id_workflow_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_definition_id_workflow_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_timers" ADD CONSTRAINT "workflow_timers_instance_id_workflow_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."workflow_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_instance_id_workflow_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."workflow_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_def_approvals_ux" ON "workflow_definition_approvals" USING btree ("definition_id","approver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definitions_key_version_ux" ON "workflow_definitions" USING btree ("def_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definitions_one_active_ux" ON "workflow_definitions" USING btree ("def_key") WHERE "workflow_definitions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "workflow_definitions_key_idx" ON "workflow_definitions" USING btree ("def_key");--> statement-breakpoint
CREATE INDEX "workflow_instances_key_idx" ON "workflow_instances" USING btree ("def_key");--> statement-breakpoint
CREATE INDEX "workflow_instances_patient_idx" ON "workflow_instances" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "workflow_instances_status_idx" ON "workflow_instances" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflow_timers_due_idx" ON "workflow_timers" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "workflow_timers_instance_idx" ON "workflow_timers" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "workflow_transitions_instance_idx" ON "workflow_transitions" USING btree ("instance_id");