CREATE TABLE "ipd_consults" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"consultant_id" text NOT NULL,
	"question" text NOT NULL,
	"urgency" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"close_note" text,
	CONSTRAINT "ipd_consults_urgency_ck" CHECK ("ipd_consults"."urgency" in ('routine', 'urgent')),
	CONSTRAINT "ipd_consults_status_ck" CHECK ("ipd_consults"."status" in ('open', 'closed')),
	CONSTRAINT "ipd_consults_closed_ck" CHECK (("ipd_consults"."status" = 'closed') = ("ipd_consults"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "ipd_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"verification" text,
	"medicine_id" text,
	"medicine_name" text,
	"dose_value" double precision,
	"dose_unit" text,
	"route" text,
	"frequency" text,
	"start_at" timestamp with time zone,
	"stop_at" timestamp with time zone,
	"duration_days" integer,
	"antibiotic" boolean DEFAULT false NOT NULL,
	"prn" jsonb,
	"weight_based_per_kg" boolean DEFAULT false NOT NULL,
	"service_ids" jsonb,
	"department" text,
	"department_order_id" text,
	"indication" text,
	"note" text,
	"ordered_by" text NOT NULL,
	"ordered_by_kind" text NOT NULL,
	"ordered_at" timestamp with time zone NOT NULL,
	"round_id" text,
	"provenance" text NOT NULL,
	"issued_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"stopped_by" text,
	"stop_reason" text,
	"return_owed" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	CONSTRAINT "ipd_orders_kind_ck" CHECK ("ipd_orders"."kind" in ('drug', 'lab', 'imaging')),
	CONSTRAINT "ipd_orders_status_ck" CHECK ("ipd_orders"."status" in ('active', 'stopped', 'cancelled')),
	CONSTRAINT "ipd_orders_verification_ck" CHECK ("ipd_orders"."verification" is null or "ipd_orders"."verification" in ('pending', 'verified', 'rejected', 'query')),
	CONSTRAINT "ipd_orders_by_kind_ck" CHECK ("ipd_orders"."ordered_by_kind" in ('consultant', 'resident')),
	CONSTRAINT "ipd_orders_drug_ck" CHECK ("ipd_orders"."kind" <> 'drug' or ("ipd_orders"."medicine_id" is not null and "ipd_orders"."route" is not null and "ipd_orders"."frequency" is not null and "ipd_orders"."start_at" is not null and "ipd_orders"."verification" is not null)),
	CONSTRAINT "ipd_orders_duration_ck" CHECK ("ipd_orders"."kind" <> 'drug' or "ipd_orders"."stop_at" is not null or "ipd_orders"."duration_days" is not null),
	CONSTRAINT "ipd_orders_antibiotic_stop_ck" CHECK (not "ipd_orders"."antibiotic" or "ipd_orders"."stop_at" is not null),
	CONSTRAINT "ipd_orders_tests_ck" CHECK ("ipd_orders"."kind" = 'drug' or ("ipd_orders"."service_ids" is not null and "ipd_orders"."department" = "ipd_orders"."kind")),
	CONSTRAINT "ipd_orders_stopped_ck" CHECK (("ipd_orders"."status" = 'stopped') = ("ipd_orders"."stopped_at" is not null and "ipd_orders"."stop_reason" is not null)),
	CONSTRAINT "ipd_orders_cancelled_ck" CHECK (("ipd_orders"."status" = 'cancelled') = ("ipd_orders"."cancelled_at" is not null and "ipd_orders"."cancel_reason" is not null)),
	CONSTRAINT "ipd_orders_cancel_before_issue_ck" CHECK ("ipd_orders"."status" <> 'cancelled' or "ipd_orders"."issued_at" is null)
);
--> statement-breakpoint
CREATE TABLE "ipd_rounds" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"author_id" text NOT NULL,
	"author_kind" text NOT NULL,
	"mode" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"soap" jsonb NOT NULL,
	"source" text NOT NULL,
	"provenance" text NOT NULL,
	"status" text NOT NULL,
	"visit_outcome" text NOT NULL,
	"cosigned_by" text,
	"cosigned_at" timestamp with time zone,
	"cosign_note" text,
	"discharge_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_rounds_author_kind_ck" CHECK ("ipd_rounds"."author_kind" in ('consultant', 'resident')),
	CONSTRAINT "ipd_rounds_mode_ck" CHECK ("ipd_rounds"."mode" in ('bedside', 'remote_review')),
	CONSTRAINT "ipd_rounds_source_ck" CHECK ("ipd_rounds"."source" in ('typed', 'voice', 'copilot_draft')),
	CONSTRAINT "ipd_rounds_status_ck" CHECK ("ipd_rounds"."status" in ('signed', 'awaiting_cosign')),
	CONSTRAINT "ipd_rounds_visit_ck" CHECK ("ipd_rounds"."visit_outcome" in ('charged', 'repeat', 'not_chargeable', 'rate_missing', 'remote', 'draft')),
	CONSTRAINT "ipd_rounds_draft_ck" CHECK (("ipd_rounds"."author_kind" = 'consultant' and "ipd_rounds"."status" = 'signed' and "ipd_rounds"."cosigned_by" is null) or ("ipd_rounds"."author_kind" = 'resident' and (("ipd_rounds"."status" = 'awaiting_cosign' and "ipd_rounds"."cosigned_by" is null) or ("ipd_rounds"."status" = 'signed' and "ipd_rounds"."cosigned_by" is not null)))),
	CONSTRAINT "ipd_rounds_cosign_ck" CHECK (("ipd_rounds"."cosigned_by" is null) = ("ipd_rounds"."cosigned_at" is null))
);
--> statement-breakpoint
ALTER TABLE "ipd_consults" ADD CONSTRAINT "ipd_consults_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_consults" ADD CONSTRAINT "ipd_consults_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_orders" ADD CONSTRAINT "ipd_orders_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_orders" ADD CONSTRAINT "ipd_orders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_orders" ADD CONSTRAINT "ipd_orders_round_id_ipd_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."ipd_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_rounds" ADD CONSTRAINT "ipd_rounds_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_rounds" ADD CONSTRAINT "ipd_rounds_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_consults_open_ux" ON "ipd_consults" USING btree ("admission_id","consultant_id") WHERE "ipd_consults"."status" = 'open';--> statement-breakpoint
CREATE INDEX "ipd_consults_consultant_idx" ON "ipd_consults" USING btree ("consultant_id") WHERE "ipd_consults"."status" = 'open';--> statement-breakpoint
CREATE INDEX "ipd_orders_admission_idx" ON "ipd_orders" USING btree ("admission_id","status");--> statement-breakpoint
CREATE INDEX "ipd_orders_verification_idx" ON "ipd_orders" USING btree ("verification") WHERE "ipd_orders"."status" = 'active';--> statement-breakpoint
CREATE INDEX "ipd_rounds_admission_seen_idx" ON "ipd_rounds" USING btree ("admission_id","seen_at");--> statement-breakpoint
CREATE INDEX "ipd_rounds_awaiting_idx" ON "ipd_rounds" USING btree ("admission_id") WHERE "ipd_rounds"."status" = 'awaiting_cosign';