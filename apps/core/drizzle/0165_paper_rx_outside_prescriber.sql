ALTER TABLE "opd_prescriptions" ALTER COLUMN "doctor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "opd_prescriptions" ADD COLUMN "outside_prescriber_name" text;--> statement-breakpoint
ALTER TABLE "opd_prescriptions" ADD COLUMN "outside_prescriber_reg_no" text;--> statement-breakpoint
ALTER TABLE "opd_prescriptions" ADD COLUMN "outside_prescriber_address" text;--> statement-breakpoint
ALTER TABLE "opd_prescriptions" ADD CONSTRAINT "opd_prescriptions_prescriber_ck" CHECK (("opd_prescriptions"."doctor_id" is not null) <> ("opd_prescriptions"."outside_prescriber_name" is not null));--> statement-breakpoint
ALTER TABLE "opd_prescriptions" ADD CONSTRAINT "opd_prescriptions_outside_transcribed_ck" CHECK ("opd_prescriptions"."outside_prescriber_name" is null or "opd_prescriptions"."transcribed_by" is not null);