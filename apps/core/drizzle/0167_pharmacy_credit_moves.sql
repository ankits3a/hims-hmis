CREATE TABLE "pharmacy_credit_moves" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"receipt_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"credit_note_id" text,
	"dispense_id" text,
	"actor_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "pharmacy_credit_moves_kind_ck" CHECK ("pharmacy_credit_moves"."kind" in ('kept', 'used')),
	CONSTRAINT "pharmacy_credit_moves_amount_ck" CHECK ("pharmacy_credit_moves"."amount_paise" > 0),
	CONSTRAINT "pharmacy_credit_moves_kept_ck" CHECK ("pharmacy_credit_moves"."kind" <> 'kept' or "pharmacy_credit_moves"."credit_note_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "pharmacy_credit_moves" ADD CONSTRAINT "pharmacy_credit_moves_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_credit_moves" ADD CONSTRAINT "pharmacy_credit_moves_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_credit_moves" ADD CONSTRAINT "pharmacy_credit_moves_dispense_id_pharmacy_dispenses_id_fk" FOREIGN KEY ("dispense_id") REFERENCES "public"."pharmacy_dispenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pharmacy_credit_moves_patient_idx" ON "pharmacy_credit_moves" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "pharmacy_credit_moves_invoice_idx" ON "pharmacy_credit_moves" USING btree ("invoice_id");