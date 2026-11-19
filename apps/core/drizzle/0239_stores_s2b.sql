CREATE TABLE "stores_client_keys" (
	"actor_id" text NOT NULL,
	"client_key" text NOT NULL,
	"act" text NOT NULL,
	"indent_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_client_keys_pk" PRIMARY KEY("actor_id","client_key")
);
--> statement-breakpoint
CREATE TABLE "stores_custody_handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"indent_id" text NOT NULL,
	"transfer_id" text NOT NULL,
	"kind" text NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text NOT NULL,
	"method" text NOT NULL,
	"reason" text,
	"phone_at" timestamp with time zone,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"flag" text,
	CONSTRAINT "stores_custody_handoffs_kind_ck" CHECK ("stores_custody_handoffs"."kind" in ('take', 'hand_over', 'take_over', 'return_accepted')),
	CONSTRAINT "stores_custody_handoffs_method_ck" CHECK ("stores_custody_handoffs"."method" in ('scan', 'typed', 'forced', 'counter')),
	CONSTRAINT "stores_custody_handoffs_flag_ck" CHECK ("stores_custody_handoffs"."flag" is null or "stores_custody_handoffs"."flag" in ('late', 'future')),
	CONSTRAINT "stores_custody_handoffs_forced_ck" CHECK ("stores_custody_handoffs"."kind" <> 'take_over' or "stores_custody_handoffs"."reason" is not null),
	CONSTRAINT "stores_custody_handoffs_two_people_ck" CHECK ("stores_custody_handoffs"."from_user_id" <> "stores_custody_handoffs"."to_user_id")
);
--> statement-breakpoint
CREATE TABLE "stores_delivery_lines" (
	"transfer_line_id" text PRIMARY KEY NOT NULL,
	"transfer_id" text NOT NULL,
	"indent_id" text NOT NULL,
	"line_idx" integer NOT NULL,
	"item_id" text NOT NULL,
	"accepted" integer NOT NULL,
	"short" integer NOT NULL,
	"wrong" integer NOT NULL,
	"damaged" integer NOT NULL,
	"received_by" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"at_counter" boolean NOT NULL,
	CONSTRAINT "stores_delivery_lines_qty_ck" CHECK ("stores_delivery_lines"."accepted" >= 0 and "stores_delivery_lines"."short" >= 0 and "stores_delivery_lines"."wrong" >= 0 and "stores_delivery_lines"."damaged" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stores_scan_confirmations" (
	"handoff_id" text PRIMARY KEY NOT NULL,
	"confirmed_by" text NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores_transit_resolutions" (
	"id" text PRIMARY KEY NOT NULL,
	"indent_id" text NOT NULL,
	"transfer_id" text NOT NULL,
	"transfer_line_id" text NOT NULL,
	"kind" text NOT NULL,
	"qty" integer NOT NULL,
	"to_resource_id" text,
	"approval_id" text,
	"status" text NOT NULL,
	"note" text,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"posted_by" text,
	"posted_at" timestamp with time zone,
	CONSTRAINT "stores_transit_resolutions_kind_ck" CHECK ("stores_transit_resolutions"."kind" in ('sent_back', 'undelivered', 'found', 'returned', 'lost')),
	CONSTRAINT "stores_transit_resolutions_status_ck" CHECK ("stores_transit_resolutions"."status" in ('pending', 'posted', 'refused')),
	CONSTRAINT "stores_transit_resolutions_qty_ck" CHECK ("stores_transit_resolutions"."qty" > 0),
	CONSTRAINT "stores_transit_resolutions_lost_ck" CHECK (("stores_transit_resolutions"."kind" = 'lost') = ("stores_transit_resolutions"."approval_id" is not null)),
	CONSTRAINT "stores_transit_resolutions_posted_ck" CHECK (("stores_transit_resolutions"."status" = 'posted') = ("stores_transit_resolutions"."posted_at" is not null) and ("stores_transit_resolutions"."posted_at" is null) = ("stores_transit_resolutions"."posted_by" is null))
);
--> statement-breakpoint
ALTER TABLE "transfers" DROP CONSTRAINT "transfers_status_ck";--> statement-breakpoint
ALTER TABLE "stores_client_keys" ADD CONSTRAINT "stores_client_keys_indent_id_store_indents_id_fk" FOREIGN KEY ("indent_id") REFERENCES "public"."store_indents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_custody_handoffs" ADD CONSTRAINT "stores_custody_handoffs_indent_id_store_indents_id_fk" FOREIGN KEY ("indent_id") REFERENCES "public"."store_indents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_custody_handoffs" ADD CONSTRAINT "stores_custody_handoffs_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_delivery_lines" ADD CONSTRAINT "stores_delivery_lines_transfer_line_id_transfer_lines_id_fk" FOREIGN KEY ("transfer_line_id") REFERENCES "public"."transfer_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_delivery_lines" ADD CONSTRAINT "stores_delivery_lines_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_delivery_lines" ADD CONSTRAINT "stores_delivery_lines_indent_id_store_indents_id_fk" FOREIGN KEY ("indent_id") REFERENCES "public"."store_indents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_delivery_lines" ADD CONSTRAINT "stores_delivery_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_scan_confirmations" ADD CONSTRAINT "stores_scan_confirmations_handoff_id_stores_custody_handoffs_id_fk" FOREIGN KEY ("handoff_id") REFERENCES "public"."stores_custody_handoffs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_transit_resolutions" ADD CONSTRAINT "stores_transit_resolutions_indent_id_store_indents_id_fk" FOREIGN KEY ("indent_id") REFERENCES "public"."store_indents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_transit_resolutions" ADD CONSTRAINT "stores_transit_resolutions_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_transit_resolutions" ADD CONSTRAINT "stores_transit_resolutions_transfer_line_id_transfer_lines_id_fk" FOREIGN KEY ("transfer_line_id") REFERENCES "public"."transfer_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stores_custody_handoffs_transfer_idx" ON "stores_custody_handoffs" USING btree ("transfer_id","occurred_at");--> statement-breakpoint
CREATE INDEX "stores_custody_handoffs_indent_idx" ON "stores_custody_handoffs" USING btree ("indent_id");--> statement-breakpoint
CREATE INDEX "stores_delivery_lines_indent_idx" ON "stores_delivery_lines" USING btree ("indent_id");--> statement-breakpoint
CREATE INDEX "stores_transit_resolutions_indent_idx" ON "stores_transit_resolutions" USING btree ("indent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_transit_resolutions_short_ux" ON "stores_transit_resolutions" USING btree ("transfer_line_id") WHERE "stores_transit_resolutions"."kind" in ('found', 'returned', 'lost') and "stores_transit_resolutions"."status" <> 'refused';--> statement-breakpoint
CREATE UNIQUE INDEX "stores_transit_resolutions_back_ux" ON "stores_transit_resolutions" USING btree ("transfer_line_id","kind","to_resource_id") WHERE "stores_transit_resolutions"."kind" in ('sent_back', 'undelivered');--> statement-breakpoint
CREATE UNIQUE INDEX "stores_ticket_details_reask_ux" ON "stores_ticket_details" USING btree ("origin_indent_id") WHERE "stores_ticket_details"."origin_kind" = 're_ask';--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_status_ck" CHECK ("transfers"."status" in ('in_transit', 'received', 'discrepancy', 'returned'));--> statement-breakpoint
-- ═══ STORES S2b (#1112, decision 7) — THE CUSTODY CHAIN IS APPEND-ONLY (drizzle-kit emits no triggers) ═══
--
-- A hand-off, once written, is the record of whose hands the goods were in. It is never changed and never
-- deleted: a wrong hand-off is answered by the next one (a take-over names the holder it overrides). TRUNCATE
-- (the test helper) does not fire a row trigger.
CREATE OR REPLACE FUNCTION stores_custody_handoffs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stores_custody_handoffs_append_only: a custody hand-off is never changed or deleted (id %)', OLD.id;
END $$;--> statement-breakpoint
CREATE TRIGGER stores_custody_handoffs_append_only BEFORE UPDATE OR DELETE ON stores_custody_handoffs
  FOR EACH ROW EXECUTE FUNCTION stores_custody_handoffs_append_only();
