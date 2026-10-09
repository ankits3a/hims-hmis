ALTER TABLE "opd_appointments" ADD COLUMN "mode" text DEFAULT 'in_person' NOT NULL;--> statement-breakpoint
ALTER TABLE "opd_appointments" ADD COLUMN "tele_phone" text;--> statement-breakpoint
ALTER TABLE "opd_appointments" ADD CONSTRAINT "opd_appointments_mode_ck" CHECK ("opd_appointments"."mode" in ('in_person', 'tele'));--> statement-breakpoint
ALTER TABLE "opd_appointments" ADD CONSTRAINT "opd_appointments_tele_phone_ck" CHECK ("opd_appointments"."mode" <> 'tele' or "opd_appointments"."tele_phone" is not null);