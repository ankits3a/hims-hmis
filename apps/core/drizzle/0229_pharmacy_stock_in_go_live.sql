-- #1047 pharmacy stock-in go-live (spec docs/specs/1047-pharmacy-stock-in-go-live.md). Additive only:
-- GRNs gain the supplier invoice date, a cancel (status 'cancelled' + who/when/why), the MRP-revision approval and the
-- 'opening_stock' source; GRN lines and stock batches gain the estimated-cost flag (ruling 0093) and lines the
-- mrp_revised hold; a supplier credit note may stand without a return (return_id nullable, kind, taxable, GST,
-- inter-state, note).
ALTER TABLE "grns" DROP CONSTRAINT "grns_source_ck";--> statement-breakpoint
ALTER TABLE "grns" DROP CONSTRAINT "grns_status_ck";--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ALTER COLUMN "return_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "grn_lines" ADD COLUMN "estimated_cost" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "grn_lines" ADD COLUMN "mrp_revised" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "grns" ADD COLUMN "invoice_date" date;--> statement-breakpoint
ALTER TABLE "grns" ADD COLUMN "mrp_approval_id" text;--> statement-breakpoint
ALTER TABLE "grns" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "grns" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grns" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD COLUMN "estimated_cost" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD COLUMN "kind" text DEFAULT 'return' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD COLUMN "taxable_paise" bigint;--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD COLUMN "gst_paise" bigint;--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD COLUMN "inter_state" boolean;--> statement-breakpoint
ALTER TABLE "grns" ADD CONSTRAINT "grns_cancelled_ck" CHECK (("grns"."status" = 'cancelled') = ("grns"."cancelled_at" is not null) and ("grns"."cancelled_at" is null) = ("grns"."cancel_reason" is null));--> statement-breakpoint
ALTER TABLE "grns" ADD CONSTRAINT "grns_source_ck" CHECK ("grns"."source" in ('challan', 'consignment_challan', 'donation', 'opening_stock'));--> statement-breakpoint
ALTER TABLE "grns" ADD CONSTRAINT "grns_status_ck" CHECK ("grns"."status" in ('draft', 'gate_qc', 'accepted', 'partially_accepted', 'rejected', 'posted', 'cancelled'));--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_kind_ck" CHECK ("supplier_credit_notes"."kind" in ('return', 'rate_difference', 'scheme', 'breakage', 'other') and ("supplier_credit_notes"."kind" = 'return') = ("supplier_credit_notes"."return_id" is not null));--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_parts_ck" CHECK (("supplier_credit_notes"."taxable_paise" is null) = ("supplier_credit_notes"."gst_paise" is null) and ("supplier_credit_notes"."taxable_paise" is null) = ("supplier_credit_notes"."inter_state" is null) and ("supplier_credit_notes"."taxable_paise" is null or ("supplier_credit_notes"."taxable_paise" >= 0 and "supplier_credit_notes"."gst_paise" >= 0 and "supplier_credit_notes"."amount_paise" = "supplier_credit_notes"."taxable_paise" + "supplier_credit_notes"."gst_paise")));