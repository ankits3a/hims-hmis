ALTER TABLE "ipd_payer_claims" DROP CONSTRAINT "ipd_payer_claims_status_ck";--> statement-breakpoint
DROP INDEX "ipd_final_bills_admission_ux";--> statement-breakpoint
DROP INDEX "ipd_payer_claims_admission_ux";--> statement-breakpoint
ALTER TABLE "ipd_final_bills" ADD COLUMN "kind" text DEFAULT 'final' NOT NULL;--> statement-breakpoint
ALTER TABLE "ipd_final_bills" ADD COLUMN "seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ipd_final_bills" ADD COLUMN "line_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ipd_final_bills" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ipd_final_bills" ADD COLUMN "voided_by" text;--> statement-breakpoint
ALTER TABLE "ipd_final_bills" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "ipd_final_bills" ADD COLUMN "void_approval_id" text;--> statement-breakpoint
ALTER TABLE "ipd_final_bills" ADD COLUMN "credit_note_id" text;--> statement-breakpoint
ALTER TABLE "ipd_final_bills" ADD COLUMN "credit_note_no" text;--> statement-breakpoint
ALTER TABLE "ipd_final_bills" ADD COLUMN "refund_cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ipd_payer_claims" ADD COLUMN "withdrawn_by" text;--> statement-breakpoint
ALTER TABLE "ipd_payer_claims" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_final_bills_live_ux" ON "ipd_final_bills" USING btree ("admission_id","seq") WHERE "ipd_final_bills"."voided_at" is null;--> statement-breakpoint
CREATE INDEX "ipd_final_bills_admission_idx" ON "ipd_final_bills" USING btree ("admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_payer_claims_bill_ux" ON "ipd_payer_claims" USING btree ("final_bill_id");--> statement-breakpoint
CREATE INDEX "ipd_payer_claims_admission_idx" ON "ipd_payer_claims" USING btree ("admission_id");--> statement-breakpoint
ALTER TABLE "ipd_final_bills" ADD CONSTRAINT "ipd_final_bills_kind_ck" CHECK (("ipd_final_bills"."kind" = 'final' and "ipd_final_bills"."seq" = 0) or ("ipd_final_bills"."kind" = 'supplementary' and "ipd_final_bills"."seq" > 0));--> statement-breakpoint
ALTER TABLE "ipd_final_bills" ADD CONSTRAINT "ipd_final_bills_void_ck" CHECK (("ipd_final_bills"."voided_at" is null) = ("ipd_final_bills"."voided_by" is null) and ("ipd_final_bills"."voided_at" is null or (coalesce(btrim("ipd_final_bills"."void_reason"), '') <> '' and "ipd_final_bills"."void_approval_id" is not null)));--> statement-breakpoint
ALTER TABLE "ipd_payer_claims" ADD CONSTRAINT "ipd_payer_claims_withdrawn_ck" CHECK (("ipd_payer_claims"."status" = 'withdrawn') = ("ipd_payer_claims"."withdrawn_at" is not null));--> statement-breakpoint
ALTER TABLE "ipd_payer_claims" ADD CONSTRAINT "ipd_payer_claims_status_ck" CHECK ("ipd_payer_claims"."status" in ('pending', 'filed', 'settled', 'rejected', 'withdrawn'));