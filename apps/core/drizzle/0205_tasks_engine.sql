CREATE TABLE "task_events" (
	"task_id" text NOT NULL,
	"seq" integer NOT NULL,
	"act" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"source" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "task_events_task_id_seq_pk" PRIMARY KEY("task_id","seq"),
	CONSTRAINT "task_events_act_ck" CHECK ("task_events"."act" in ('raised', 'merged', 'assigned', 'redispatched', 'accepted', 'started', 'done', 'verified', 'cancelled', 'returned', 'escalated')),
	CONSTRAINT "task_events_source_ck" CHECK ("task_events"."source" in ('person', 'device', 'copilot_draft', 'agent', 'import', 'system'))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"place_resource_id" text,
	"patient_id" text,
	"priority" text DEFAULT 'routine' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"skill" text NOT NULL,
	"assignee_kind" text,
	"assignee_id" text,
	"assigned_at" timestamp with time zone,
	"shift_ends_at" timestamp with time zone,
	"proof_needed" text DEFAULT 'none' NOT NULL,
	"proof" jsonb,
	"verify_required" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'created' NOT NULL,
	"cancel_reason" text,
	"note" text,
	"merged_count" integer DEFAULT 0 NOT NULL,
	"escalated_rung" integer DEFAULT 0 NOT NULL,
	"done_by" text,
	"done_at" timestamp with time zone,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"requested_by" text NOT NULL,
	"source" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tasks_state_ck" CHECK ("tasks"."state" in ('created', 'assigned', 'accepted', 'in_progress', 'done', 'verified', 'cancelled')),
	CONSTRAINT "tasks_priority_ck" CHECK ("tasks"."priority" in ('routine', 'urgent', 'stat')),
	CONSTRAINT "tasks_proof_needed_ck" CHECK ("tasks"."proof_needed" in ('none', 'tap', 'photo', 'scan', 'weight')),
	CONSTRAINT "tasks_source_ck" CHECK ("tasks"."source" in ('person', 'device', 'copilot_draft', 'agent', 'import')),
	CONSTRAINT "tasks_assignee_kind_ck" CHECK ("tasks"."assignee_kind" is null or "tasks"."assignee_kind" in ('person', 'team', 'machine')),
	CONSTRAINT "tasks_assignee_pair_ck" CHECK (("tasks"."assignee_kind" is null) = ("tasks"."assignee_id" is null)),
	CONSTRAINT "tasks_assignee_state_ck" CHECK ("tasks"."state" not in ('assigned', 'accepted', 'in_progress') or "tasks"."assignee_id" is not null),
	CONSTRAINT "tasks_pool_unassigned_ck" CHECK ("tasks"."state" <> 'created' or "tasks"."assignee_id" is null),
	CONSTRAINT "tasks_cancel_reason_ck" CHECK ("tasks"."state" <> 'cancelled' or char_length("tasks"."cancel_reason") > 0),
	CONSTRAINT "tasks_note_ck" CHECK ("tasks"."note" is null or char_length("tasks"."note") <= 280),
	CONSTRAINT "tasks_counts_ck" CHECK ("tasks"."merged_count" >= 0 and "tasks"."escalated_rung" >= 0 and "tasks"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_place_resource_id_resources_id_fk" FOREIGN KEY ("place_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_events_at_idx" ON "task_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "tasks_open_idx" ON "tasks" USING btree ("state","due_at") WHERE "tasks"."state" in ('created', 'assigned', 'accepted', 'in_progress');--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_id") WHERE "tasks"."state" in ('assigned', 'accepted', 'in_progress');--> statement-breakpoint
CREATE INDEX "tasks_place_idx" ON "tasks" USING btree ("kind","place_resource_id","created_at");--> statement-breakpoint
-- E0.1 TASK ENGINE — a task's history is corrected by a further row, never by an edit: no UPDATE, no DELETE.
CREATE OR REPLACE FUNCTION task_events_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_append_only: task_events rows are append-only (% refused, task %, seq %)', TG_OP, OLD.task_id, OLD.seq;
END $$;--> statement-breakpoint
CREATE TRIGGER task_events_append_only
  BEFORE UPDATE OR DELETE ON "task_events"
  FOR EACH ROW EXECUTE FUNCTION task_events_forbid_mutation();
