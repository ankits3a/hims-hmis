ALTER TABLE "opd_appointments" ADD COLUMN "mode" text DEFAULT 'in_person' NOT NULL;--> statement-breakpoint
ALTER TABLE "opd_appointments" ADD COLUMN "tele_phone" text;--> statement-breakpoint
ALTER TABLE "opd_appointments" ADD COLUMN "advance_receipt_id" text;--> statement-breakpoint
ALTER TABLE "opd_appointments" ADD COLUMN "advance_quote_paise" integer;--> statement-breakpoint
ALTER TABLE "opd_appointments" ADD COLUMN "advance_quoted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opd_appointments" ADD CONSTRAINT "opd_appointments_advance_receipt_id_receipts_id_fk" FOREIGN KEY ("advance_receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_appointments" ADD CONSTRAINT "opd_appointments_mode_ck" CHECK ("opd_appointments"."mode" in ('in_person', 'tele'));--> statement-breakpoint
ALTER TABLE "opd_appointments" ADD CONSTRAINT "opd_appointments_tele_phone_ck" CHECK ("opd_appointments"."mode" <> 'tele' or "opd_appointments"."tele_phone" is not null);