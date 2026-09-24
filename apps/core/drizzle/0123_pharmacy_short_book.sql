CREATE TABLE "pharmacy_short_book" (
	"id" text PRIMARY KEY NOT NULL,
	"store_resource_id" text NOT NULL,
	"item_id" text,
	"drug_name" text NOT NULL,
	"qty_wanted" integer,
	"source" text NOT NULL,
	"dispense_id" text,
	"noted_by" text NOT NULL,
	"noted_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution" text,
	CONSTRAINT "pharmacy_short_book_name_ck" CHECK (length(btrim("pharmacy_short_book"."drug_name")) between 2 and 120),
	CONSTRAINT "pharmacy_short_book_qty_ck" CHECK ("pharmacy_short_book"."qty_wanted" is null or "pharmacy_short_book"."qty_wanted" > 0),
	CONSTRAINT "pharmacy_short_book_source_ck" CHECK ("pharmacy_short_book"."source" in ('desk', 'agent', 'reorder')),
	CONSTRAINT "pharmacy_short_book_resolution_ck" CHECK ("pharmacy_short_book"."resolution" is null or "pharmacy_short_book"."resolution" in ('ordered', 'received', 'dismissed')),
	CONSTRAINT "pharmacy_short_book_resolved_ck" CHECK (("pharmacy_short_book"."resolved_at" is null) = ("pharmacy_short_book"."resolved_by" is null) and ("pharmacy_short_book"."resolved_at" is null) = ("pharmacy_short_book"."resolution" is null))
);
--> statement-breakpoint
ALTER TABLE "pharmacy_short_book" ADD CONSTRAINT "pharmacy_short_book_store_resource_id_resources_id_fk" FOREIGN KEY ("store_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_short_book" ADD CONSTRAINT "pharmacy_short_book_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_short_book" ADD CONSTRAINT "pharmacy_short_book_dispense_id_pharmacy_dispenses_id_fk" FOREIGN KEY ("dispense_id") REFERENCES "public"."pharmacy_dispenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pharmacy_short_book_open_idx" ON "pharmacy_short_book" USING btree ("store_resource_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_short_book_open_item_ux" ON "pharmacy_short_book" USING btree ("store_resource_id","item_id") WHERE "pharmacy_short_book"."resolved_at" is null and "pharmacy_short_book"."item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_short_book_open_name_ux" ON "pharmacy_short_book" USING btree ("store_resource_id",lower("drug_name")) WHERE "pharmacy_short_book"."resolved_at" is null and "pharmacy_short_book"."item_id" is null;