CREATE TABLE "stores_award_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"award_id" text NOT NULL,
	"item_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"quote_id" text,
	"rate_id" text,
	"qty_base" integer NOT NULL,
	"rate_paise" bigint NOT NULL,
	"discount_bps" integer DEFAULT 0 NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	"rank" integer,
	CONSTRAINT "stores_award_lines_source_ck" CHECK (("stores_award_lines"."quote_id" is null) <> ("stores_award_lines"."rate_id" is null)),
	CONSTRAINT "stores_award_lines_qty_ck" CHECK ("stores_award_lines"."qty_base" > 0 and "stores_award_lines"."rate_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stores_award_signatures" (
	"id" text PRIMARY KEY NOT NULL,
	"award_id" text NOT NULL,
	"seat" text NOT NULL,
	"kind" text NOT NULL,
	"by" text NOT NULL,
	"on_behalf_of" text,
	"delegation_id" text,
	"reason" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_award_signatures_kind_ck" CHECK ("stores_award_signatures"."kind" in ('approve', 'sign', 'object')),
	CONSTRAINT "stores_award_signatures_seat_ck" CHECK ("stores_award_signatures"."seat" in ('buyer', 'materials_head', 'accounts_head', 'medical_superintendent', 'user_hod', 'biomedical', 'owner')),
	CONSTRAINT "stores_award_signatures_reason_ck" CHECK ("stores_award_signatures"."kind" <> 'object' or "stores_award_signatures"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "stores_awards" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"rfq_id" text,
	"band" text NOT NULL,
	"equipment" boolean DEFAULT false NOT NULL,
	"reason" text,
	"total_paise" bigint NOT NULL,
	"seats" jsonb NOT NULL,
	"replaces_id" text,
	"proposed_by" text NOT NULL,
	"proposed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_awards_band_ck" CHECK ("stores_awards"."band" in ('A', 'B', 'C'))
);
--> statement-breakpoint
CREATE TABLE "stores_buy_group_moves" (
	"id" text PRIMARY KEY NOT NULL,
	"pr_id" text NOT NULL,
	"line_idx" integer NOT NULL,
	"group_id" text,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores_buy_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores_committee_seats" (
	"id" text PRIMARY KEY NOT NULL,
	"seat" text NOT NULL,
	"user_id" text NOT NULL,
	"from_at" timestamp with time zone NOT NULL,
	"to_at" timestamp with time zone,
	"set_by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_committee_seats_seat_ck" CHECK ("stores_committee_seats"."seat" in ('materials_head', 'accounts_head', 'medical_superintendent', 'biomedical')),
	CONSTRAINT "stores_committee_seats_window_ck" CHECK ("stores_committee_seats"."to_at" is null or "stores_committee_seats"."to_at" > "stores_committee_seats"."from_at")
);
--> statement-breakpoint
CREATE TABLE "stores_pr_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"pr_id" text NOT NULL,
	"line_idx" integer NOT NULL,
	"grn_id" text NOT NULL,
	"indent_id" text NOT NULL,
	"qty_base" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_pr_deliveries_qty_ck" CHECK ("stores_pr_deliveries"."qty_base" > 0)
);
--> statement-breakpoint
CREATE TABLE "stores_quote_admissions" (
	"id" text PRIMARY KEY NOT NULL,
	"quote_id" text NOT NULL,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores_quote_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"quote_id" text NOT NULL,
	"item_id" text NOT NULL,
	"qty_base" integer NOT NULL,
	"rate_paise" bigint NOT NULL,
	"discount_bps" integer DEFAULT 0 NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	"confirmed_by" text NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_quote_lines_ck" CHECK ("stores_quote_lines"."qty_base" > 0 and "stores_quote_lines"."rate_paise" >= 0 and "stores_quote_lines"."discount_bps" between 0 and 10000 and "stores_quote_lines"."gst_rate_bps" between 0 and 2800)
);
--> statement-breakpoint
CREATE TABLE "stores_quote_technical" (
	"id" text PRIMARY KEY NOT NULL,
	"rfq_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"role" text NOT NULL,
	"compliant" boolean NOT NULL,
	"reason" text,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_quote_technical_role_ck" CHECK ("stores_quote_technical"."role" in ('hod', 'biomedical')),
	CONSTRAINT "stores_quote_technical_reason_ck" CHECK ("stores_quote_technical"."compliant" or "stores_quote_technical"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "stores_quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"rfq_id" text,
	"vendor_id" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"supplier_ref" text,
	"freight_paise" bigint DEFAULT 0 NOT NULL,
	"other_paise" bigint DEFAULT 0 NOT NULL,
	"payment_terms_days" integer,
	"delivery_days" integer,
	"warranty_months" integer,
	"document_key" text,
	"late" boolean DEFAULT false NOT NULL,
	"entered_by" text NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_quotes_kind_ck" CHECK ("stores_quotes"."kind" in ('quote', 'revised', 'negotiated')),
	CONSTRAINT "stores_quotes_money_ck" CHECK ("stores_quotes"."freight_paise" >= 0 and "stores_quotes"."other_paise" >= 0 and "stores_quotes"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "stores_rfq_invitees" (
	"id" text PRIMARY KEY NOT NULL,
	"rfq_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"added_by" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores_rfq_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"rfq_id" text NOT NULL,
	"line_idx" integer NOT NULL,
	"item_id" text NOT NULL,
	"qty_base" integer NOT NULL,
	CONSTRAINT "stores_rfq_lines_qty_ck" CHECK ("stores_rfq_lines"."qty_base" > 0)
);
--> statement-breakpoint
CREATE TABLE "stores_rfq_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"rfq_id" text NOT NULL,
	"kind" text NOT NULL,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"channel" text,
	"vendor_ids" jsonb,
	"reply_by" timestamp with time zone,
	"reason" text,
	CONSTRAINT "stores_rfq_steps_kind_ck" CHECK ("stores_rfq_steps"."kind" in ('sent', 'reply_by_moved', 'closed')),
	CONSTRAINT "stores_rfq_steps_channel_ck" CHECK ("stores_rfq_steps"."kind" <> 'sent' or "stores_rfq_steps"."channel" in ('email', 'print', 'hand')),
	CONSTRAINT "stores_rfq_steps_move_ck" CHECK ("stores_rfq_steps"."kind" <> 'reply_by_moved' or ("stores_rfq_steps"."reply_by" is not null and "stores_rfq_steps"."reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "stores_rfqs" (
	"id" text PRIMARY KEY NOT NULL,
	"rfq_no" text NOT NULL,
	"group_id" text NOT NULL,
	"band" text NOT NULL,
	"equipment" boolean DEFAULT false NOT NULL,
	"reply_by" timestamp with time zone NOT NULL,
	"delivery_store_id" text NOT NULL,
	"delivery_date" date,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_rfqs_band_ck" CHECK ("stores_rfqs"."band" in ('A', 'B', 'C'))
);
--> statement-breakpoint
ALTER TABLE "stores_delegations" DROP CONSTRAINT "stores_delegations_scope_ck";--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "award_id" text;--> statement-breakpoint
ALTER TABLE "stores_delegations" ADD COLUMN "seat" text;--> statement-breakpoint
ALTER TABLE "stores_award_lines" ADD CONSTRAINT "stores_award_lines_award_id_stores_awards_id_fk" FOREIGN KEY ("award_id") REFERENCES "public"."stores_awards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_award_lines" ADD CONSTRAINT "stores_award_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_award_lines" ADD CONSTRAINT "stores_award_lines_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_award_lines" ADD CONSTRAINT "stores_award_lines_quote_id_stores_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."stores_quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_award_signatures" ADD CONSTRAINT "stores_award_signatures_award_id_stores_awards_id_fk" FOREIGN KEY ("award_id") REFERENCES "public"."stores_awards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_awards" ADD CONSTRAINT "stores_awards_group_id_stores_buy_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."stores_buy_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_awards" ADD CONSTRAINT "stores_awards_rfq_id_stores_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."stores_rfqs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_buy_group_moves" ADD CONSTRAINT "stores_buy_group_moves_pr_id_stores_purchase_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."stores_purchase_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_buy_group_moves" ADD CONSTRAINT "stores_buy_group_moves_group_id_stores_buy_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."stores_buy_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_pr_deliveries" ADD CONSTRAINT "stores_pr_deliveries_pr_id_stores_purchase_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."stores_purchase_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_pr_deliveries" ADD CONSTRAINT "stores_pr_deliveries_grn_id_grns_id_fk" FOREIGN KEY ("grn_id") REFERENCES "public"."grns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_pr_deliveries" ADD CONSTRAINT "stores_pr_deliveries_indent_id_store_indents_id_fk" FOREIGN KEY ("indent_id") REFERENCES "public"."store_indents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_quote_admissions" ADD CONSTRAINT "stores_quote_admissions_quote_id_stores_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."stores_quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_quote_lines" ADD CONSTRAINT "stores_quote_lines_quote_id_stores_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."stores_quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_quote_lines" ADD CONSTRAINT "stores_quote_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_quote_technical" ADD CONSTRAINT "stores_quote_technical_rfq_id_stores_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."stores_rfqs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_quote_technical" ADD CONSTRAINT "stores_quote_technical_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_quotes" ADD CONSTRAINT "stores_quotes_group_id_stores_buy_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."stores_buy_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_quotes" ADD CONSTRAINT "stores_quotes_rfq_id_stores_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."stores_rfqs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_quotes" ADD CONSTRAINT "stores_quotes_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_rfq_invitees" ADD CONSTRAINT "stores_rfq_invitees_rfq_id_stores_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."stores_rfqs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_rfq_invitees" ADD CONSTRAINT "stores_rfq_invitees_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_rfq_lines" ADD CONSTRAINT "stores_rfq_lines_rfq_id_stores_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."stores_rfqs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_rfq_lines" ADD CONSTRAINT "stores_rfq_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_rfq_steps" ADD CONSTRAINT "stores_rfq_steps_rfq_id_stores_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."stores_rfqs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_rfqs" ADD CONSTRAINT "stores_rfqs_group_id_stores_buy_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."stores_buy_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_rfqs" ADD CONSTRAINT "stores_rfqs_delivery_store_id_resources_id_fk" FOREIGN KEY ("delivery_store_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stores_award_lines_ux" ON "stores_award_lines" USING btree ("award_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_award_signatures_seat_ux" ON "stores_award_signatures" USING btree ("award_id","seat");--> statement-breakpoint
CREATE INDEX "stores_awards_group_idx" ON "stores_awards" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "stores_awards_rfq_idx" ON "stores_awards" USING btree ("rfq_id");--> statement-breakpoint
CREATE INDEX "stores_buy_group_moves_line_idx" ON "stores_buy_group_moves" USING btree ("pr_id","line_idx","at");--> statement-breakpoint
CREATE INDEX "stores_buy_group_moves_group_idx" ON "stores_buy_group_moves" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "stores_committee_seats_seat_idx" ON "stores_committee_seats" USING btree ("seat","at");--> statement-breakpoint
CREATE INDEX "stores_pr_deliveries_pr_idx" ON "stores_pr_deliveries" USING btree ("pr_id","line_idx");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_quote_admissions_ux" ON "stores_quote_admissions" USING btree ("quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_quote_lines_ux" ON "stores_quote_lines" USING btree ("quote_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_quote_technical_ux" ON "stores_quote_technical" USING btree ("rfq_id","vendor_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_quotes_version_ux" ON "stores_quotes" USING btree ("group_id","vendor_id","version");--> statement-breakpoint
CREATE INDEX "stores_quotes_rfq_idx" ON "stores_quotes" USING btree ("rfq_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_rfq_invitees_ux" ON "stores_rfq_invitees" USING btree ("rfq_id","vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_rfq_lines_ux" ON "stores_rfq_lines" USING btree ("rfq_id","item_id");--> statement-breakpoint
CREATE INDEX "stores_rfq_steps_rfq_idx" ON "stores_rfq_steps" USING btree ("rfq_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_rfq_steps_once_ux" ON "stores_rfq_steps" USING btree ("rfq_id","kind") WHERE "stores_rfq_steps"."kind" in ('reply_by_moved', 'closed');--> statement-breakpoint
CREATE UNIQUE INDEX "stores_rfqs_no_ux" ON "stores_rfqs" USING btree ("rfq_no");--> statement-breakpoint
CREATE INDEX "stores_rfqs_group_idx" ON "stores_rfqs" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_award_idx" ON "purchase_orders" USING btree ("award_id");--> statement-breakpoint
ALTER TABLE "stores_delegations" ADD CONSTRAINT "stores_delegations_seat_ck" CHECK (("stores_delegations"."scope" = 'committee_seat') = ("stores_delegations"."seat" is not null));--> statement-breakpoint
ALTER TABLE "stores_delegations" ADD CONSTRAINT "stores_delegations_scope_ck" CHECK ("stores_delegations"."scope" in ('hod_approval', 'committee_seat'));--> statement-breakpoint
-- ═══ STORES S5b (#1115, "Audit by construction") — GROUPS, RFQS, QUOTES, AWARDS, SIGNATURES, SEATS ARE WRITTEN ONCE ═══
--
-- A group's membership, an RFQ's life, a quote's revision, an award's signature and a committee seat's holder are
-- each a NEW row; nothing here is ever changed or deleted (the 0242 function). A revised quote is a new version, the
-- old one kept; a signature is one row per seat (unique). `purchase_orders.award_id` is a nullable column on the shared
-- materials table: no existing pharmacy row is touched. The delegation scope CHECK only ADDS a value; the new `seat`
-- column is null on every S5a row, which the new seat CHECK requires of an `hod_approval` row. TRUNCATE (the test
-- helper) does not fire a row trigger.
CREATE TRIGGER stores_buy_groups_append_only BEFORE UPDATE OR DELETE ON stores_buy_groups
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_buy_group_moves_append_only BEFORE UPDATE OR DELETE ON stores_buy_group_moves
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_rfqs_append_only BEFORE UPDATE OR DELETE ON stores_rfqs
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_rfq_lines_append_only BEFORE UPDATE OR DELETE ON stores_rfq_lines
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_rfq_invitees_append_only BEFORE UPDATE OR DELETE ON stores_rfq_invitees
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_rfq_steps_append_only BEFORE UPDATE OR DELETE ON stores_rfq_steps
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_quotes_append_only BEFORE UPDATE OR DELETE ON stores_quotes
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_quote_lines_append_only BEFORE UPDATE OR DELETE ON stores_quote_lines
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_quote_admissions_append_only BEFORE UPDATE OR DELETE ON stores_quote_admissions
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_quote_technical_append_only BEFORE UPDATE OR DELETE ON stores_quote_technical
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_awards_append_only BEFORE UPDATE OR DELETE ON stores_awards
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_award_lines_append_only BEFORE UPDATE OR DELETE ON stores_award_lines
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_award_signatures_append_only BEFORE UPDATE OR DELETE ON stores_award_signatures
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_committee_seats_append_only BEFORE UPDATE OR DELETE ON stores_committee_seats
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_pr_deliveries_append_only BEFORE UPDATE OR DELETE ON stores_pr_deliveries
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();
