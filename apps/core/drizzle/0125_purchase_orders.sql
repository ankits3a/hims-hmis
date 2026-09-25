CREATE TABLE "item_stock_levels" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"store_resource_id" text NOT NULL,
	"min_base" integer NOT NULL,
	"reorder_base" integer NOT NULL,
	"max_base" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_stock_levels_order_ck" CHECK (0 <= "item_stock_levels"."min_base" and "item_stock_levels"."min_base" <= "item_stock_levels"."reorder_base" and "item_stock_levels"."reorder_base" < "item_stock_levels"."max_base")
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_order_id" text NOT NULL,
	"item_id" text NOT NULL,
	"uom" text NOT NULL,
	"multiplier" integer NOT NULL,
	"qty_packs" integer NOT NULL,
	"free_packs" integer DEFAULT 0 NOT NULL,
	"rate_paise" bigint NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	"mrp_paise" bigint,
	"line_total_paise" bigint NOT NULL,
	"received_base" integer DEFAULT 0 NOT NULL,
	"free_received_base" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "purchase_order_lines_qty_ck" CHECK ("purchase_order_lines"."qty_packs" > 0 and "purchase_order_lines"."free_packs" >= 0 and "purchase_order_lines"."multiplier" > 0),
	CONSTRAINT "purchase_order_lines_money_ck" CHECK ("purchase_order_lines"."rate_paise" >= 0 and "purchase_order_lines"."gst_rate_bps" >= 0 and "purchase_order_lines"."line_total_paise" = "purchase_order_lines"."qty_packs" * "purchase_order_lines"."rate_paise"),
	CONSTRAINT "purchase_order_lines_received_ck" CHECK ("purchase_order_lines"."received_base" >= 0 and "purchase_order_lines"."free_received_base" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"po_no" text NOT NULL,
	"vendor_id" text NOT NULL,
	"store_resource_id" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"expected_date" date,
	"terms" text,
	"note" text,
	"subtotal_paise" bigint DEFAULT 0 NOT NULL,
	"gst_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"approval_id" text,
	"approval_tier" text,
	"submitted_by" text,
	"submitted_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"rejection_note" text,
	"sent_by" text,
	"sent_at" timestamp with time zone,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_status_ck" CHECK ("purchase_orders"."status" in ('draft', 'pending_approval', 'approved', 'sent', 'part_received', 'received', 'cancelled')),
	CONSTRAINT "purchase_orders_source_ck" CHECK ("purchase_orders"."source" in ('manual', 'agent')),
	CONSTRAINT "purchase_orders_tier_ck" CHECK ("purchase_orders"."approval_tier" is null or "purchase_orders"."approval_tier" in ('head', 'owner')),
	CONSTRAINT "purchase_orders_totals_ck" CHECK ("purchase_orders"."subtotal_paise" >= 0 and "purchase_orders"."gst_paise" >= 0 and "purchase_orders"."total_paise" = "purchase_orders"."subtotal_paise" + "purchase_orders"."gst_paise"),
	CONSTRAINT "purchase_orders_approved_ck" CHECK (("purchase_orders"."approved_at" is null) = ("purchase_orders"."approved_by" is null) and ("purchase_orders"."status" not in ('approved', 'sent', 'part_received', 'received') or "purchase_orders"."approved_by" is not null)),
	CONSTRAINT "purchase_orders_cancelled_ck" CHECK (("purchase_orders"."status" = 'cancelled') = ("purchase_orders"."cancelled_at" is not null) and ("purchase_orders"."cancelled_at" is null) = ("purchase_orders"."cancel_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "grns" ADD COLUMN "purchase_order_id" text;--> statement-breakpoint
ALTER TABLE "item_stock_levels" ADD CONSTRAINT "item_stock_levels_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_stock_levels" ADD CONSTRAINT "item_stock_levels_store_resource_id_resources_id_fk" FOREIGN KEY ("store_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_store_resource_id_resources_id_fk" FOREIGN KEY ("store_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "item_stock_levels_item_store_ux" ON "item_stock_levels" USING btree ("item_id","store_resource_id");--> statement-breakpoint
CREATE INDEX "item_stock_levels_store_idx" ON "item_stock_levels" USING btree ("store_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_item_ux" ON "purchase_order_lines" USING btree ("purchase_order_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_po_no_ux" ON "purchase_orders" USING btree ("po_no");--> statement-breakpoint
CREATE INDEX "purchase_orders_vendor_idx" ON "purchase_orders" USING btree ("vendor_id","status");--> statement-breakpoint
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders" USING btree ("status","expected_date");--> statement-breakpoint
ALTER TABLE "grns" ADD CONSTRAINT "grns_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grns_purchase_order_idx" ON "grns" USING btree ("purchase_order_id");