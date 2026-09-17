-- ═══ PLAN 14c, SECOND SLICE: A COUNT'S VARIANCE, BOOKED WITH A SECOND KEY ═══
--
-- Phase doc: docs/superpowers/plans/2026-09-17-phase-materials-adjustments.md.
-- `stock_adjustments` holds one row per count line whose variance is to be written off (or found
-- stock booked on), sharing the approval that must be granted before anything posts. The ledger
-- gains a sixth reason, `adjust`: the constraint is dropped and re-added with it, and every existing
-- row carries one of the five reasons it already allowed. Additive otherwise.
CREATE TABLE "stock_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"count_id" text NOT NULL,
	"count_line_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"item_id" text NOT NULL,
	"qty_delta" integer NOT NULL,
	"value_paise" bigint NOT NULL,
	"reason_code" text NOT NULL,
	"note" text,
	"approval_id" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"posted_by" text,
	"posted_at" timestamp with time zone,
	"ledger_entry_id" text,
	CONSTRAINT "stock_adjustments_qty_ck" CHECK ("stock_adjustments"."qty_delta" <> 0),
	CONSTRAINT "stock_adjustments_status_ck" CHECK ("stock_adjustments"."status" in ('requested', 'posted', 'refused')),
	CONSTRAINT "stock_adjustments_reason_ck" CHECK ("stock_adjustments"."reason_code" in ('shrinkage', 'damage', 'expiry', 'entry_error', 'found')),
	CONSTRAINT "stock_adjustments_posted_ck" CHECK (("stock_adjustments"."status" = 'posted') = ("stock_adjustments"."ledger_entry_id" is not null) and ("stock_adjustments"."posted_at" is null) = ("stock_adjustments"."posted_by" is null) and ("stock_adjustments"."status" = 'posted') = ("stock_adjustments"."posted_at" is not null)),
	CONSTRAINT "stock_adjustments_found_ck" CHECK (("stock_adjustments"."reason_code" = 'found') = ("stock_adjustments"."qty_delta" > 0) or "stock_adjustments"."reason_code" = 'entry_error')
);
--> statement-breakpoint
ALTER TABLE "stock_ledger" DROP CONSTRAINT "stock_ledger_reason_ck";--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_count_id_stock_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."stock_counts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_count_line_id_stock_count_lines_id_fk" FOREIGN KEY ("count_line_id") REFERENCES "public"."stock_count_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_adjustments_line_live_uq" ON "stock_adjustments" USING btree ("count_line_id") WHERE "stock_adjustments"."status" <> 'refused';--> statement-breakpoint
CREATE INDEX "stock_adjustments_approval_idx" ON "stock_adjustments" USING btree ("approval_id");--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_reason_ck" CHECK ("stock_ledger"."reason" in ('grn', 'issue', 'receive', 'consume', 'return', 'adjust'));