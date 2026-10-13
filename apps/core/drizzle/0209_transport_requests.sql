CREATE TABLE "transport_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"admission_id" text,
	"from_resource_id" text,
	"to_resource_id" text,
	"to_note" text,
	"mode" text,
	"oxygen" boolean DEFAULT false NOT NULL,
	"monitor" boolean DEFAULT false NOT NULL,
	"isolation" text DEFAULT 'none' NOT NULL,
	"reason" text,
	"escort_required" boolean DEFAULT false NOT NULL,
	"escort_reason" text,
	"escort_user_id" text,
	"escort_added_by" text,
	"escort_added_at" timestamp with time zone,
	"oxygen_checked_by" text,
	"oxygen_checked_at" timestamp with time zone,
	"handover_band_serial" text,
	"handover_at" timestamp with time zone,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "transport_requests_kind_ck" CHECK ("transport_requests"."kind" in ('patient_move', 'sample_run', 'document_run')),
	CONSTRAINT "transport_requests_mode_ck" CHECK ("transport_requests"."mode" is null or "transport_requests"."mode" in ('wheelchair', 'stretcher', 'bed', 'walking')),
	CONSTRAINT "transport_requests_isolation_ck" CHECK ("transport_requests"."isolation" in ('none', 'contact', 'droplet', 'airborne')),
	CONSTRAINT "transport_requests_reason_ck" CHECK ("transport_requests"."reason" is null or "transport_requests"."reason" in ('admit', 'transfer', 'imaging', 'ot', 'discharge', 'other')),
	CONSTRAINT "transport_requests_escort_reason_ck" CHECK ("transport_requests"."escort_reason" is null or "transport_requests"."escort_reason" in ('critical_care_bed', 'high_risk_flag', 'requested')),
	CONSTRAINT "transport_requests_move_admission_ck" CHECK ("transport_requests"."kind" <> 'patient_move' or "transport_requests"."admission_id" is not null),
	CONSTRAINT "transport_requests_to_ck" CHECK ("transport_requests"."to_resource_id" is not null or char_length("transport_requests"."to_note") > 0),
	CONSTRAINT "transport_requests_to_note_ck" CHECK ("transport_requests"."to_note" is null or char_length("transport_requests"."to_note") <= 120)
);
--> statement-breakpoint
ALTER TABLE "transport_requests" ADD CONSTRAINT "transport_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_requests" ADD CONSTRAINT "transport_requests_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_requests" ADD CONSTRAINT "transport_requests_from_resource_id_resources_id_fk" FOREIGN KEY ("from_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_requests" ADD CONSTRAINT "transport_requests_to_resource_id_resources_id_fk" FOREIGN KEY ("to_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transport_requests_task_ux" ON "transport_requests" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "transport_requests_admission_idx" ON "transport_requests" USING btree ("admission_id");