CREATE TABLE "item_merges" (
	"id" text PRIMARY KEY NOT NULL,
	"survivor_item_id" text NOT NULL,
	"merged_item_id" text NOT NULL,
	"reason" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"approval_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"merged_by" text,
	"merged_at" timestamp with time zone,
	"refused_at" timestamp with time zone,
	"moved" jsonb,
	CONSTRAINT "item_merges_distinct_ck" CHECK ("item_merges"."survivor_item_id" <> "item_merges"."merged_item_id"),
	CONSTRAINT "item_merges_status_ck" CHECK ("item_merges"."status" in ('requested', 'merged', 'refused')),
	CONSTRAINT "item_merges_source_ck" CHECK ("item_merges"."source" in ('agent', 'manual')),
	CONSTRAINT "item_merges_reason_ck" CHECK (length(btrim("item_merges"."reason")) between 3 and 500),
	CONSTRAINT "item_merges_merged_ck" CHECK (("item_merges"."status" = 'merged') = ("item_merges"."merged_at" is not null) and ("item_merges"."merged_at" is null) = ("item_merges"."merged_by" is null) and ("item_merges"."status" <> 'merged' or "item_merges"."moved" is not null)),
	CONSTRAINT "item_merges_refused_ck" CHECK (("item_merges"."status" = 'refused') = ("item_merges"."refused_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "merged_into_item_id" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "item_merges" ADD CONSTRAINT "item_merges_survivor_item_id_items_id_fk" FOREIGN KEY ("survivor_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_merges" ADD CONSTRAINT "item_merges_merged_item_id_items_id_fk" FOREIGN KEY ("merged_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "item_merges_live_ux" ON "item_merges" USING btree ("merged_item_id") WHERE "item_merges"."status" in ('requested', 'merged');--> statement-breakpoint
CREATE INDEX "item_merges_survivor_idx" ON "item_merges" USING btree ("survivor_item_id");--> statement-breakpoint
CREATE INDEX "item_merges_status_idx" ON "item_merges" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "item_merges_approval_idx" ON "item_merges" USING btree ("approval_id");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_merged_into_item_id_items_id_fk" FOREIGN KEY ("merged_into_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_merged_into_idx" ON "items" USING btree ("merged_into_item_id");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_merged_ck" CHECK (("items"."merged_into_item_id" is null) = ("items"."merged_at" is null) and ("items"."merged_into_item_id" is null or ("items"."merged_into_item_id" <> "items"."id" and not "items"."active")));