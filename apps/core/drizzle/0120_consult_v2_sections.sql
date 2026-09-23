CREATE TABLE "opd_patient_reminders" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"text" text NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_by" text,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "examination" jsonb;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "treatment" jsonb;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "doctor_note" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "internal_comment" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "diagnosis_kind" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "rx_stock_choices" jsonb;--> statement-breakpoint
ALTER TABLE "opd_patient_reminders" ADD CONSTRAINT "opd_patient_reminders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opd_patient_reminders_active_ux" ON "opd_patient_reminders" USING btree ("patient_id") WHERE cleared_at is null;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD CONSTRAINT "opd_encounters_diagnosis_kind_ck" CHECK ("opd_encounters"."diagnosis_kind" is null or "opd_encounters"."diagnosis_kind" in ('provisional', 'final'));