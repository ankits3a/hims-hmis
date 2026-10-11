ALTER TABLE "staff_absences" ADD COLUMN "department_id" text;--> statement-breakpoint
ALTER TABLE "staff_absences" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "staff_absences" ADD CONSTRAINT "staff_absences_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_absences_department_status_idx" ON "staff_absences" USING btree ("department_id","status");--> statement-breakpoint
ALTER TABLE "staff_absences" ADD CONSTRAINT "staff_absences_decision_note_ck" CHECK ("staff_absences"."decision_note" is null or length("staff_absences"."decision_note") between 1 and 280);