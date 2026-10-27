CREATE TABLE "linen_challan_returns" (
	"id" text PRIMARY KEY NOT NULL,
	"challan_id" text NOT NULL,
	"item_code" text NOT NULL,
	"accepted" integer NOT NULL,
	"damaged" integer NOT NULL,
	"stained" integer NOT NULL,
	"condemn_request_id" text,
	"returned_at" timestamp with time zone NOT NULL,
	"recorded_by" text NOT NULL,
	CONSTRAINT "linen_challan_returns_counts_ck" CHECK ("linen_challan_returns"."accepted" >= 0 and "linen_challan_returns"."damaged" >= 0 and "linen_challan_returns"."stained" >= 0 and "linen_challan_returns"."accepted" + "linen_challan_returns"."damaged" + "linen_challan_returns"."stained" > 0),
	CONSTRAINT "linen_challan_returns_condemn_ck" CHECK (("linen_challan_returns"."damaged" > 0) = ("linen_challan_returns"."condemn_request_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "linen_challans" (
	"id" text PRIMARY KEY NOT NULL,
	"challan_no" text NOT NULL,
	"batch_id" text NOT NULL,
	"linen_vendor_id" text NOT NULL,
	"lines" jsonb NOT NULL,
	"pieces" integer NOT NULL,
	"weight_grams" integer NOT NULL,
	"rush" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"sent_by" text NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "linen_challans_pieces_ck" CHECK ("linen_challans"."pieces" > 0 and "linen_challans"."weight_grams" > 0),
	CONSTRAINT "linen_challans_due_ck" CHECK ("linen_challans"."due_at" > "linen_challans"."sent_at")
);
--> statement-breakpoint
CREATE TABLE "linen_licences" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"licence_no" text NOT NULL,
	"authority" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"filed_by" text NOT NULL,
	"filed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "linen_licences_kind_ck" CHECK ("linen_licences"."kind" in ('etp_consent', 'boiler')),
	CONSTRAINT "linen_licences_dates_ck" CHECK ("linen_licences"."valid_to" >= "linen_licences"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "linen_recoveries" (
	"id" text PRIMARY KEY NOT NULL,
	"linen_vendor_id" text NOT NULL,
	"month" text NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"lines" jsonb NOT NULL,
	"proposed_paise" bigint NOT NULL,
	"approved_paise" bigint,
	"proposed_by" text NOT NULL,
	"proposed_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"note" text,
	"bill_id" text,
	CONSTRAINT "linen_recoveries_month_ck" CHECK ("linen_recoveries"."month" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "linen_recoveries_state_ck" CHECK ("linen_recoveries"."state" in ('proposed', 'approved', 'rejected')),
	CONSTRAINT "linen_recoveries_decided_ck" CHECK (("linen_recoveries"."state" = 'proposed') = ("linen_recoveries"."decided_at" is null)),
	CONSTRAINT "linen_recoveries_approved_ck" CHECK (("linen_recoveries"."state" = 'approved') = ("linen_recoveries"."approved_paise" is not null)),
	CONSTRAINT "linen_recoveries_four_eyes_ck" CHECK ("linen_recoveries"."decided_by" is null or "linen_recoveries"."decided_by" <> "linen_recoveries"."proposed_by")
);
--> statement-breakpoint
CREATE TABLE "linen_uniform_moves" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"item_code" text NOT NULL,
	"kind" text NOT NULL,
	"sets_out" integer DEFAULT 0 NOT NULL,
	"sets_in" integer DEFAULT 0 NOT NULL,
	"size" text,
	"at" timestamp with time zone NOT NULL,
	"by" text NOT NULL,
	CONSTRAINT "linen_uniform_moves_kind_ck" CHECK ("linen_uniform_moves"."kind" in ('issue', 'exchange', 'return')),
	CONSTRAINT "linen_uniform_moves_sets_ck" CHECK ("linen_uniform_moves"."sets_out" >= 0 and "linen_uniform_moves"."sets_in" >= 0 and "linen_uniform_moves"."sets_out" + "linen_uniform_moves"."sets_in" > 0),
	CONSTRAINT "linen_uniform_moves_shape_ck" CHECK (("linen_uniform_moves"."kind" = 'issue' and "linen_uniform_moves"."sets_in" = 0) or ("linen_uniform_moves"."kind" = 'return' and "linen_uniform_moves"."sets_out" = 0) or ("linen_uniform_moves"."kind" = 'exchange' and "linen_uniform_moves"."sets_in" = "linen_uniform_moves"."sets_out"))
);
--> statement-breakpoint
CREATE TABLE "linen_uniform_roles" (
	"role_key" text PRIMARY KEY NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linen_vendor_bills" (
	"id" text PRIMARY KEY NOT NULL,
	"linen_vendor_id" text NOT NULL,
	"month" text NOT NULL,
	"vendor_bill_no" text NOT NULL,
	"lines" jsonb NOT NULL,
	"billed_paise" bigint NOT NULL,
	"accepted_value_paise" bigint NOT NULL,
	"gst_paise" bigint NOT NULL,
	"recovery_paise" bigint NOT NULL,
	"payable_paise" bigint NOT NULL,
	"held_paise" bigint NOT NULL,
	"state" text NOT NULL,
	"checked_by" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "linen_vendor_bills_month_ck" CHECK ("linen_vendor_bills"."month" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "linen_vendor_bills_state_ck" CHECK ("linen_vendor_bills"."state" in ('checked', 'held', 'approved', 'refused')),
	CONSTRAINT "linen_vendor_bills_held_ck" CHECK ("linen_vendor_bills"."held_paise" >= 0 and ("linen_vendor_bills"."state" = 'held') <= ("linen_vendor_bills"."held_paise" > 0)),
	CONSTRAINT "linen_vendor_bills_four_eyes_ck" CHECK ("linen_vendor_bills"."decided_by" is null or "linen_vendor_bills"."decided_by" <> "linen_vendor_bills"."checked_by")
);
--> statement-breakpoint
CREATE TABLE "linen_vendor_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"linen_vendor_id" text NOT NULL,
	"item_code" text NOT NULL,
	"rate_paise" bigint NOT NULL,
	"effective_from" date NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	CONSTRAINT "linen_vendor_rates_rate_ck" CHECK ("linen_vendor_rates"."rate_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "linen_vendors" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"vendor_id" text,
	"turnaround_hours" integer DEFAULT 24 NOT NULL,
	"rush_turnaround_hours" integer DEFAULT 12 NOT NULL,
	"gst_rate_bps" integer DEFAULT 1800 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "linen_vendors_turnaround_ck" CHECK ("linen_vendors"."turnaround_hours" between 1 and 240 and "linen_vendors"."rush_turnaround_hours" between 1 and "linen_vendors"."turnaround_hours"),
	CONSTRAINT "linen_vendors_gst_ck" CHECK ("linen_vendors"."gst_rate_bps" between 0 and 2800)
);
--> statement-breakpoint
ALTER TABLE "linen_condemn_requests" ADD COLUMN "piece_id" text;--> statement-breakpoint
ALTER TABLE "linen_items" ADD COLUMN "materials_item_id" text;--> statement-breakpoint
ALTER TABLE "linen_items" ADD COLUMN "price_paise" bigint;--> statement-breakpoint
ALTER TABLE "linen_pieces" ADD COLUMN "condemned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "linen_pieces" ADD COLUMN "registered_by" text;--> statement-breakpoint
ALTER TABLE "linen_wash_cycles" ADD COLUMN "load_grams" integer;--> statement-breakpoint
ALTER TABLE "linen_challan_returns" ADD CONSTRAINT "linen_challan_returns_challan_id_linen_challans_id_fk" FOREIGN KEY ("challan_id") REFERENCES "public"."linen_challans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_challan_returns" ADD CONSTRAINT "linen_challan_returns_item_code_linen_items_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."linen_items"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_challan_returns" ADD CONSTRAINT "linen_challan_returns_condemn_request_id_linen_condemn_requests_id_fk" FOREIGN KEY ("condemn_request_id") REFERENCES "public"."linen_condemn_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_challans" ADD CONSTRAINT "linen_challans_batch_id_linen_laundry_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."linen_laundry_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_challans" ADD CONSTRAINT "linen_challans_linen_vendor_id_linen_vendors_id_fk" FOREIGN KEY ("linen_vendor_id") REFERENCES "public"."linen_vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_recoveries" ADD CONSTRAINT "linen_recoveries_linen_vendor_id_linen_vendors_id_fk" FOREIGN KEY ("linen_vendor_id") REFERENCES "public"."linen_vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_uniform_moves" ADD CONSTRAINT "linen_uniform_moves_item_code_linen_items_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."linen_items"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_vendor_bills" ADD CONSTRAINT "linen_vendor_bills_linen_vendor_id_linen_vendors_id_fk" FOREIGN KEY ("linen_vendor_id") REFERENCES "public"."linen_vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_vendor_rates" ADD CONSTRAINT "linen_vendor_rates_linen_vendor_id_linen_vendors_id_fk" FOREIGN KEY ("linen_vendor_id") REFERENCES "public"."linen_vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_vendor_rates" ADD CONSTRAINT "linen_vendor_rates_item_code_linen_items_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."linen_items"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_vendors" ADD CONSTRAINT "linen_vendors_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "linen_challan_returns_challan_idx" ON "linen_challan_returns" USING btree ("challan_id");--> statement-breakpoint
CREATE INDEX "linen_challan_returns_at_idx" ON "linen_challan_returns" USING btree ("returned_at");--> statement-breakpoint
CREATE UNIQUE INDEX "linen_challans_no_uq" ON "linen_challans" USING btree ("challan_no");--> statement-breakpoint
CREATE UNIQUE INDEX "linen_challans_batch_uq" ON "linen_challans" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "linen_challans_vendor_idx" ON "linen_challans" USING btree ("linen_vendor_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "linen_licences_live_uq" ON "linen_licences" USING btree ("kind") WHERE "linen_licences"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "linen_recoveries_month_uq" ON "linen_recoveries" USING btree ("linen_vendor_id","month") WHERE "linen_recoveries"."state" <> 'rejected';--> statement-breakpoint
CREATE INDEX "linen_uniform_moves_user_idx" ON "linen_uniform_moves" USING btree ("user_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "linen_vendor_bills_no_uq" ON "linen_vendor_bills" USING btree ("linen_vendor_id","vendor_bill_no");--> statement-breakpoint
CREATE UNIQUE INDEX "linen_vendor_rates_uq" ON "linen_vendor_rates" USING btree ("linen_vendor_id","item_code","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "linen_vendors_name_uq" ON "linen_vendors" USING btree ("name");--> statement-breakpoint
ALTER TABLE "linen_condemn_requests" ADD CONSTRAINT "linen_condemn_requests_piece_id_linen_pieces_id_fk" FOREIGN KEY ("piece_id") REFERENCES "public"."linen_pieces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_items" ADD CONSTRAINT "linen_items_materials_item_id_items_id_fk" FOREIGN KEY ("materials_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_condemn_requests" ADD CONSTRAINT "linen_condemn_requests_piece_ck" CHECK ("linen_condemn_requests"."piece_id" is null or "linen_condemn_requests"."qty" = 1);--> statement-breakpoint
ALTER TABLE "linen_items" ADD CONSTRAINT "linen_items_price_ck" CHECK ("linen_items"."price_paise" is null or "linen_items"."price_paise" >= 0);--> statement-breakpoint
ALTER TABLE "linen_pieces" ADD CONSTRAINT "linen_pieces_condemned_ck" CHECK ("linen_pieces"."condemned_at" is null or not "linen_pieces"."active");--> statement-breakpoint
-- LD-2 (#979): a uniform set is a linen item of the uniform stream (no ward's par); the four uniformed staff groups
-- (decision 0087) are entitled from the start; more roles are added in setup.
INSERT INTO "linen_items" ("code", "name", "units_per_set", "sort", "stream") VALUES ('uniform_set', 'Uniform set', 0, 10, 'uniform') ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
INSERT INTO "linen_uniform_roles" ("role_key", "set_by", "set_at") VALUES
  ('nurse', 'system:migration', now()), ('ward_nurse', 'system:migration', now()), ('staff_nurse', 'system:migration', now()),
  ('lab_technician', 'system:migration', now()), ('ot_nurse', 'system:migration', now()), ('ot_incharge', 'system:migration', now()),
  ('housekeeping', 'system:migration', now()) ON CONFLICT ("role_key") DO NOTHING;
