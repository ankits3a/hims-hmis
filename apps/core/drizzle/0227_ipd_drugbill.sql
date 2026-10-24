ALTER TABLE "ipd_charge_exceptions" DROP CONSTRAINT "ipd_charge_exceptions_component_ck";--> statement-breakpoint
ALTER TABLE "ipd_charge_exceptions" DROP CONSTRAINT "ipd_charge_exceptions_reason_ck";--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" DROP CONSTRAINT "ipd_charge_lines_component_ck";--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" DROP CONSTRAINT "ipd_charge_lines_source_ck";--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD COLUMN "issue_id" text;--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD COLUMN "batch_id" text;--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD COLUMN "drug_seq" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_charge_lines_pharmacy_ux" ON "ipd_charge_lines" USING btree ("issue_id","batch_id","drug_seq") WHERE "ipd_charge_lines"."source" = 'ipd.pharmacy';--> statement-breakpoint
ALTER TABLE "ipd_charge_exceptions" ADD CONSTRAINT "ipd_charge_exceptions_component_ck" CHECK ("ipd_charge_exceptions"."component" is null or "ipd_charge_exceptions"."component" in ('room', 'nursing', 'rmo', 'visit', 'cross_visit', 'lab', 'imaging', 'pharmacy', 'er'));--> statement-breakpoint
ALTER TABLE "ipd_charge_exceptions" ADD CONSTRAINT "ipd_charge_exceptions_reason_ck" CHECK ("ipd_charge_exceptions"."reason" in ('rate_missing', 'tariff_missing', 'posting_failed', 'visit_backdated', 'order_cancelled_after_bill', 'order_cancelled_after_work', 'return_after_bill', 'reissue_lost_damaged'));--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD CONSTRAINT "ipd_charge_lines_pharmacy_ck" CHECK ("ipd_charge_lines"."source" = 'ipd.reversal' or ("ipd_charge_lines"."source" = 'ipd.pharmacy') = ("ipd_charge_lines"."issue_id" is not null and "ipd_charge_lines"."batch_id" is not null and "ipd_charge_lines"."drug_seq" is not null and "ipd_charge_lines"."order_id" is not null));--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD CONSTRAINT "ipd_charge_lines_component_ck" CHECK ("ipd_charge_lines"."component" in ('room', 'nursing', 'rmo', 'visit', 'cross_visit', 'lab', 'imaging', 'pharmacy', 'er'));--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD CONSTRAINT "ipd_charge_lines_source_ck" CHECK ("ipd_charge_lines"."source" in ('ipd.nightly', 'ipd.visit', 'ipd.reversal', 'ipd.order', 'ipd.pharmacy', 'ipd.er'));