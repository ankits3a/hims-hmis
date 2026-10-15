CREATE TABLE "vendor_item_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor_id" text NOT NULL,
	"item_id" text NOT NULL,
	"uom" text NOT NULL,
	"multiplier" integer NOT NULL,
	"rate_paise" bigint NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	"mrp_paise" bigint,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"source" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_by" text,
	"ended_at" timestamp with time zone,
	CONSTRAINT "vendor_item_rates_money_ck" CHECK ("vendor_item_rates"."rate_paise" >= 0 and "vendor_item_rates"."gst_rate_bps" >= 0 and "vendor_item_rates"."multiplier" > 0 and ("vendor_item_rates"."mrp_paise" is null or "vendor_item_rates"."mrp_paise" > 0)),
	CONSTRAINT "vendor_item_rates_period_ck" CHECK ("vendor_item_rates"."valid_to" is null or "vendor_item_rates"."valid_to" >= "vendor_item_rates"."valid_from"),
	CONSTRAINT "vendor_item_rates_ended_ck" CHECK (("vendor_item_rates"."ended_at" is null) = ("vendor_item_rates"."ended_by" is null))
);
--> statement-breakpoint
ALTER TABLE "vendor_item_rates" ADD CONSTRAINT "vendor_item_rates_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_item_rates" ADD CONSTRAINT "vendor_item_rates_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_item_rates_open_ux" ON "vendor_item_rates" USING btree ("vendor_id","item_id") WHERE "vendor_item_rates"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "vendor_item_rates_item_idx" ON "vendor_item_rates" USING btree ("item_id");