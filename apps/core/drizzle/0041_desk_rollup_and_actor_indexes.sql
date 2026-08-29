CREATE TABLE "user_day_facts" (
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"facts" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_day_facts_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE INDEX "patients_created_by_at_idx" ON "patients" USING btree ("created_by","created_at");--> statement-breakpoint
CREATE INDEX "opd_appointments_booked_by_at_idx" ON "opd_appointments" USING btree ("booked_by","booked_at");--> statement-breakpoint
CREATE INDEX "opd_encounters_opened_by_date_idx" ON "opd_encounters" USING btree ("opened_by","service_date");--> statement-breakpoint
CREATE INDEX "opd_prescriptions_issued_by_at_idx" ON "opd_prescriptions" USING btree ("issued_by","issued_at");--> statement-breakpoint
CREATE INDEX "opd_vitals_recorded_by_at_idx" ON "opd_vitals" USING btree ("recorded_by","recorded_at");--> statement-breakpoint
CREATE INDEX "invoices_day_issuer_idx" ON "invoices" USING btree ("service_day","issued_by");--> statement-breakpoint
CREATE INDEX "receipt_tenders_receipt_idx" ON "receipt_tenders" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "receipts_day_cashier_idx" ON "receipts" USING btree ("service_day","received_by");