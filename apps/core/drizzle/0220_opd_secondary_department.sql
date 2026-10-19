CREATE TABLE "opd_doctor_secondary_departments" (
	"id" text PRIMARY KEY NOT NULL,
	"doctor_id" text NOT NULL,
	"department_id" text NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_by" text,
	"ended_at" timestamp with time zone,
	CONSTRAINT "opd_doctor_secondary_departments_dates_ck" CHECK ("opd_doctor_secondary_departments"."to_date" is null or "opd_doctor_secondary_departments"."to_date" >= "opd_doctor_secondary_departments"."from_date" - 1)
);
--> statement-breakpoint
ALTER TABLE "opd_doctor_schedules" ADD COLUMN "department_id" text;--> statement-breakpoint
ALTER TABLE "opd_doctor_secondary_departments" ADD CONSTRAINT "opd_doctor_secondary_departments_doctor_id_opd_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."opd_doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_doctor_secondary_departments" ADD CONSTRAINT "opd_doctor_secondary_departments_department_id_opd_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."opd_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opd_doctor_secondary_departments_doctor_idx" ON "opd_doctor_secondary_departments" USING btree ("doctor_id");--> statement-breakpoint
CREATE INDEX "opd_doctor_secondary_departments_department_idx" ON "opd_doctor_secondary_departments" USING btree ("department_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opd_doctor_secondary_departments_open_ux" ON "opd_doctor_secondary_departments" USING btree ("doctor_id") WHERE to_date is null;--> statement-breakpoint
ALTER TABLE "opd_doctor_schedules" ADD CONSTRAINT "opd_doctor_schedules_department_id_opd_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."opd_departments"("id") ON DELETE no action ON UPDATE no action;