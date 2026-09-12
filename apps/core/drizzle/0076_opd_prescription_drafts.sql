CREATE TABLE "opd_prescription_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"encounter_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"lines" jsonb NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"drafted_by" text NOT NULL,
	"drafted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"issued_prescription_id" text
);
--> statement-breakpoint
ALTER TABLE "opd_prescription_drafts" ADD CONSTRAINT "opd_prescription_drafts_encounter_id_opd_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."opd_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_prescription_drafts" ADD CONSTRAINT "opd_prescription_drafts_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opd_rx_drafts_pending_ux" ON "opd_prescription_drafts" USING btree ("encounter_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "opd_rx_drafts_patient_idx" ON "opd_prescription_drafts" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "opd_rx_drafts_drafted_by_at_idx" ON "opd_prescription_drafts" USING btree ("drafted_by","drafted_at");