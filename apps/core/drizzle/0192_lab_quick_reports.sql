CREATE TABLE "lab_quick_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"lines" jsonb NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lab_quick_reports" ADD CONSTRAINT "lab_quick_reports_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_quick_reports_patient_idx" ON "lab_quick_reports" USING btree ("patient_id","created_at");