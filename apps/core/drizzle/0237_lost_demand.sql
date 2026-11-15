CREATE TABLE "pharmacy_demand" (
	"id" text PRIMARY KEY NOT NULL,
	"store_resource_id" text NOT NULL,
	"item_id" text,
	"medicine_id" text,
	"typed_name" text,
	"qty_asked_base" integer NOT NULL,
	"source" text NOT NULL,
	"dispense_id" text,
	"short_book_entry_id" text,
	"noted_by" text NOT NULL,
	"noted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pharmacy_demand_source_ck" CHECK ("pharmacy_demand"."source" in ('desk_decline', 'counter_search', 'counter_short', 'balance_owed')),
	CONSTRAINT "pharmacy_demand_qty_ck" CHECK ("pharmacy_demand"."qty_asked_base" > 0),
	CONSTRAINT "pharmacy_demand_named_ck" CHECK ("pharmacy_demand"."item_id" is not null or "pharmacy_demand"."typed_name" is not null),
	CONSTRAINT "pharmacy_demand_typed_ck" CHECK ("pharmacy_demand"."typed_name" is null or length(btrim("pharmacy_demand"."typed_name")) between 2 and 120)
);
--> statement-breakpoint
ALTER TABLE "pharmacy_short_book" DROP CONSTRAINT "pharmacy_short_book_source_ck";--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD COLUMN "declined_reason_code" text;--> statement-breakpoint
ALTER TABLE "pharmacy_short_book" ADD COLUMN "asked_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pharmacy_short_book" ADD COLUMN "asked_qty_base" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pharmacy_demand" ADD CONSTRAINT "pharmacy_demand_store_resource_id_resources_id_fk" FOREIGN KEY ("store_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_demand" ADD CONSTRAINT "pharmacy_demand_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_demand" ADD CONSTRAINT "pharmacy_demand_medicine_id_formulary_medicines_id_fk" FOREIGN KEY ("medicine_id") REFERENCES "public"."formulary_medicines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_demand" ADD CONSTRAINT "pharmacy_demand_dispense_id_pharmacy_dispenses_id_fk" FOREIGN KEY ("dispense_id") REFERENCES "public"."pharmacy_dispenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_demand" ADD CONSTRAINT "pharmacy_demand_short_book_entry_id_pharmacy_short_book_id_fk" FOREIGN KEY ("short_book_entry_id") REFERENCES "public"."pharmacy_short_book"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pharmacy_demand_noted_idx" ON "pharmacy_demand" USING btree ("noted_at");--> statement-breakpoint
CREATE INDEX "pharmacy_demand_item_idx" ON "pharmacy_demand" USING btree ("item_id","noted_at");--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD CONSTRAINT "pharmacy_dispense_lines_declined_code_ck" CHECK ("pharmacy_dispense_lines"."declined_reason_code" is null or ("pharmacy_dispense_lines"."status" = 'declined' and "pharmacy_dispense_lines"."declined_reason_code" in ('not_in_stock', 'patient_declined', 'cost', 'other')));--> statement-breakpoint
ALTER TABLE "pharmacy_short_book" ADD CONSTRAINT "pharmacy_short_book_asked_ck" CHECK ("pharmacy_short_book"."asked_count" >= 0 and "pharmacy_short_book"."asked_qty_base" >= 0);--> statement-breakpoint
ALTER TABLE "pharmacy_short_book" ADD CONSTRAINT "pharmacy_short_book_source_ck" CHECK ("pharmacy_short_book"."source" in ('desk', 'agent', 'reorder', 'counter'));