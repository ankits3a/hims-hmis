-- ═══ PHARMACY P20: PAPER DISPENSES ENTERED AFTER AN OUTAGE ═══
--
-- Phase doc: docs/superpowers/plans/2026-09-17-phase-pharmacy-p20-paper-dispenses.md.
-- A walk-in sale row (0102) also holds a dispense written on a downtime kit sheet: `channel`
-- (default 'walk_in', so every existing row keeps its meaning), who entered it, and the sheet,
-- entered once. `licence_id` becomes nullable because an OPD counter sheet sells under the
-- hospital's licence; a CHECK keeps it required for every walk-in sale. Additive otherwise.
ALTER TABLE "pharmacy_retail_sales" ALTER COLUMN "licence_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sales" ADD COLUMN "channel" text DEFAULT 'walk_in' NOT NULL;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sales" ADD COLUMN "entered_by" text;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sales" ADD COLUMN "downtime_kit_id" text;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sales" ADD COLUMN "downtime_serial" integer;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sales" ADD COLUMN "downtime_desk" text;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sales" ADD CONSTRAINT "pharmacy_retail_sales_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_retail_sales_sheet_ux" ON "pharmacy_retail_sales" USING btree ("downtime_kit_id","downtime_serial") WHERE "pharmacy_retail_sales"."downtime_kit_id" is not null;--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sales" ADD CONSTRAINT "pharmacy_retail_sales_channel_ck" CHECK ("pharmacy_retail_sales"."channel" in ('walk_in', 'downtime'));--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sales" ADD CONSTRAINT "pharmacy_retail_sales_licence_ck" CHECK ("pharmacy_retail_sales"."channel" <> 'walk_in' or "pharmacy_retail_sales"."licence_id" is not null);--> statement-breakpoint
ALTER TABLE "pharmacy_retail_sales" ADD CONSTRAINT "pharmacy_retail_sales_sheet_ck" CHECK (("pharmacy_retail_sales"."channel" = 'downtime') = ("pharmacy_retail_sales"."downtime_kit_id" is not null and "pharmacy_retail_sales"."downtime_serial" is not null and "pharmacy_retail_sales"."downtime_desk" is not null and "pharmacy_retail_sales"."entered_by" is not null));