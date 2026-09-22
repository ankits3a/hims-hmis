-- ═══ PLAN 14c, FIRST SLICE: BLIND STOCK COUNTS AND THE VARIANCE REGISTER ═══
--
-- Phase doc: docs/superpowers/plans/2026-09-17-phase-materials-counts.md (doc 09 s3.9).
-- `stock_counts` is one count of one store, assigned by the system to someone who neither scheduled
-- it nor keeps the store (the CHECK keeps the scheduler off it). `stock_count_lines` freezes each
-- batch's on-hand at scheduling; the submission records the physical count, the ledger's movement
-- during the count and the variance. One count is being counted per store at a time (partial unique
-- index). Additive: two new tables, no existing row touched, and no adjustment is ever posted from
-- here (writing a variance off needs two keys; runbook O1 is open).
CREATE TABLE "stock_count_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"count_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"item_id" text NOT NULL,
	"system_qty" integer NOT NULL,
	"counted_qty" integer,
	"moved_qty" integer,
	"variance_qty" integer,
	"variance_paise" bigint,
	"flag" text,
	CONSTRAINT "stock_count_lines_counted_ck" CHECK ("stock_count_lines"."counted_qty" is null or "stock_count_lines"."counted_qty" >= 0),
	CONSTRAINT "stock_count_lines_flag_ck" CHECK ("stock_count_lines"."flag" is null or "stock_count_lines"."flag" in ('match', 'variance', 'recount')),
	CONSTRAINT "stock_count_lines_settled_ck" CHECK (("stock_count_lines"."counted_qty" is null) = ("stock_count_lines"."flag" is null) and ("stock_count_lines"."flag" is null) = ("stock_count_lines"."variance_qty" is null))
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"status" text NOT NULL,
	"scheduled_by" text NOT NULL,
	"counter_user_id" text NOT NULL,
	"recount_of" text,
	"recount_id" text,
	"frozen_at" timestamp with time zone NOT NULL,
	"counted_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"close_note" text,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_counts_status_ck" CHECK ("stock_counts"."status" in ('counting', 'submitted', 'closed', 'cancelled')),
	CONSTRAINT "stock_counts_sod_ck" CHECK ("stock_counts"."counter_user_id" <> "stock_counts"."scheduled_by"),
	CONSTRAINT "stock_counts_counted_ck" CHECK (("stock_counts"."counted_at" is null) = ("stock_counts"."submitted_at" is null) and ("stock_counts"."counted_at" is null or "stock_counts"."counted_at" >= "stock_counts"."frozen_at")),
	CONSTRAINT "stock_counts_closed_ck" CHECK (("stock_counts"."status" = 'closed') = ("stock_counts"."closed_at" is not null) and ("stock_counts"."closed_at" is null) = ("stock_counts"."closed_by" is null)),
	CONSTRAINT "stock_counts_cancelled_ck" CHECK (("stock_counts"."status" = 'cancelled') = ("stock_counts"."cancelled_at" is not null) and ("stock_counts"."cancelled_at" is null) = ("stock_counts"."cancel_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_id_stock_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."stock_counts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_count_lines_batch_uq" ON "stock_count_lines" USING btree ("count_id","batch_id");--> statement-breakpoint
CREATE INDEX "stock_counts_resource_idx" ON "stock_counts" USING btree ("resource_id","frozen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_counts_one_counting_uq" ON "stock_counts" USING btree ("resource_id") WHERE "stock_counts"."status" = 'counting';