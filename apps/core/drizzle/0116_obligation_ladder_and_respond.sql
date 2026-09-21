ALTER TABLE "workflow_instances" ADD COLUMN "budget_minutes" integer;--> statement-breakpoint
ALTER TABLE "workflow_timers" ADD COLUMN "percent" integer;--> statement-breakpoint
ALTER TABLE "workflow_timers" ADD COLUMN "superseded_by" text;--> statement-breakpoint
ALTER TABLE "workflow_timers" ADD CONSTRAINT "workflow_timers_superseded_by_workflow_timers_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."workflow_timers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_timers" ADD CONSTRAINT "workflow_timers_kind_ck" CHECK ("workflow_timers"."kind" in ('sla', 'escalation', 'respond'));