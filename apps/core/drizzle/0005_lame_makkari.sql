CREATE TABLE "approval_types" (
	"type_key" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"def_key" text NOT NULL,
	"approver_role" text NOT NULL,
	"urgency_class" text DEFAULT 'routine' NOT NULL,
	"act_first_allowed" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"type_key" text NOT NULL,
	"instance_id" text NOT NULL,
	"requester_id" text NOT NULL,
	"approver_role" text NOT NULL,
	"urgency_class" text NOT NULL,
	"acted_first" boolean DEFAULT false NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"patient_id" text,
	"encounter_id" text,
	"payee_id" text,
	"amount_paise" bigint,
	"cumulative_patient_paise" bigint,
	"cumulative_payee_paise" bigint,
	"request_note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision_note" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_type_key_approval_types_type_key_fk" FOREIGN KEY ("type_key") REFERENCES "public"."approval_types"("type_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_instance_id_workflow_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."workflow_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_types_def_key_ux" ON "approval_types" USING btree ("def_key");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_instance_ux" ON "approvals" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "approvals_worklist_idx" ON "approvals" USING btree ("status","approver_role");--> statement-breakpoint
CREATE INDEX "approvals_type_idx" ON "approvals" USING btree ("type_key");--> statement-breakpoint
CREATE INDEX "approvals_patient_day_idx" ON "approvals" USING btree ("patient_id","requested_at");--> statement-breakpoint
CREATE INDEX "approvals_payee_day_idx" ON "approvals" USING btree ("payee_id","requested_at");