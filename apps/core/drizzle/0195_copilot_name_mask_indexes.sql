CREATE INDEX "patients_created_at_idx" ON "patients" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "opd_appointments_service_date_idx" ON "opd_appointments" USING btree ("service_date");--> statement-breakpoint
CREATE INDEX "opd_encounters_service_date_idx" ON "opd_encounters" USING btree ("service_date");