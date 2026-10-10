CREATE TABLE "lab_quick_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"encounter_no" text,
	"tests" jsonb NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"collected_by" text NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"reported_at" timestamp with time zone,
	"reported_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_quick_reports_status_ck" CHECK ("lab_quick_reports"."status" in ('waiting', 'reported')),
	CONSTRAINT "lab_quick_reports_reported_ck" CHECK (("lab_quick_reports"."status" = 'reported') = ("lab_quick_reports"."reported_at" is not null and "lab_quick_reports"."reported_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "lab_quick_reports" ADD CONSTRAINT "lab_quick_reports_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_quick_reports_status_idx" ON "lab_quick_reports" USING btree ("status","collected_at");--> statement-breakpoint
CREATE INDEX "lab_quick_reports_patient_idx" ON "lab_quick_reports" USING btree ("patient_id","collected_at");