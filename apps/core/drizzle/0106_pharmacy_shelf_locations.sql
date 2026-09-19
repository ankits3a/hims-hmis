CREATE TABLE "pharmacy_shelf_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"store_resource_id" text NOT NULL,
	"item_id" text NOT NULL,
	"location" text NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pharmacy_shelf_locations_label_ck" CHECK (length(btrim("pharmacy_shelf_locations"."location")) between 1 and 24 and "pharmacy_shelf_locations"."location" = btrim("pharmacy_shelf_locations"."location"))
);
--> statement-breakpoint
ALTER TABLE "pharmacy_shelf_locations" ADD CONSTRAINT "pharmacy_shelf_locations_store_resource_id_resources_id_fk" FOREIGN KEY ("store_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_shelf_locations" ADD CONSTRAINT "pharmacy_shelf_locations_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_shelf_locations_store_item_ux" ON "pharmacy_shelf_locations" USING btree ("store_resource_id","item_id");