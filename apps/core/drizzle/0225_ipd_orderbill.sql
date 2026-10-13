ALTER TABLE "ipd_charge_exceptions" DROP CONSTRAINT "ipd_charge_exceptions_component_ck";--> statement-breakpoint
ALTER TABLE "ipd_charge_exceptions" DROP CONSTRAINT "ipd_charge_exceptions_reason_ck";--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" DROP CONSTRAINT "ipd_charge_lines_component_ck";--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" DROP CONSTRAINT "ipd_charge_lines_source_ck";--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD COLUMN "order_id" text;--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD COLUMN "order_item_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_charge_lines_order_ux" ON "ipd_charge_lines" USING btree ("order_item_id") WHERE "ipd_charge_lines"."source" = 'ipd.order';--> statement-breakpoint
ALTER TABLE "ipd_charge_exceptions" ADD CONSTRAINT "ipd_charge_exceptions_component_ck" CHECK ("ipd_charge_exceptions"."component" is null or "ipd_charge_exceptions"."component" in ('room', 'nursing', 'rmo', 'visit', 'cross_visit', 'lab', 'imaging'));--> statement-breakpoint
ALTER TABLE "ipd_charge_exceptions" ADD CONSTRAINT "ipd_charge_exceptions_reason_ck" CHECK ("ipd_charge_exceptions"."reason" in ('rate_missing', 'tariff_missing', 'posting_failed', 'visit_backdated', 'order_cancelled_after_bill', 'order_cancelled_after_work'));--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD CONSTRAINT "ipd_charge_lines_order_ck" CHECK ("ipd_charge_lines"."source" = 'ipd.reversal' or ("ipd_charge_lines"."source" = 'ipd.order') = ("ipd_charge_lines"."order_item_id" is not null and "ipd_charge_lines"."order_id" is not null));--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD CONSTRAINT "ipd_charge_lines_component_ck" CHECK ("ipd_charge_lines"."component" in ('room', 'nursing', 'rmo', 'visit', 'cross_visit', 'lab', 'imaging'));--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD CONSTRAINT "ipd_charge_lines_source_ck" CHECK ("ipd_charge_lines"."source" in ('ipd.nightly', 'ipd.visit', 'ipd.reversal', 'ipd.order'));