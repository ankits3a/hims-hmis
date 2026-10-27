CREATE TABLE "canteen_bed_class_meals" (
	"bed_class" text PRIMARY KEY NOT NULL,
	"meals_per_day" integer NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	CONSTRAINT "canteen_bed_class_meals_ck" CHECK ("canteen_bed_class_meals"."meals_per_day" >= 0)
);
--> statement-breakpoint
CREATE TABLE "canteen_bed_qrs" (
	"id" text PRIMARY KEY NOT NULL,
	"bed_id" text NOT NULL,
	"outlet_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "canteen_charity_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"approval_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"kind" text NOT NULL,
	"meals" integer NOT NULL,
	"meal_limit_paise" bigint NOT NULL,
	"valid_until" date NOT NULL,
	"note" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	CONSTRAINT "canteen_charity_grants_kind_ck" CHECK ("canteen_charity_grants"."kind" in ('free', 'subsidised')),
	CONSTRAINT "canteen_charity_grants_meals_ck" CHECK ("canteen_charity_grants"."meals" > 0 and "canteen_charity_grants"."meal_limit_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "canteen_cost_centres" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canteen_dish_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"dish_id" text NOT NULL,
	"list" text NOT NULL,
	"price_paise" bigint NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"set_by" text NOT NULL,
	CONSTRAINT "canteen_dish_prices_list_ck" CHECK ("canteen_dish_prices"."list" in ('public', 'staff', 'subsidised')),
	CONSTRAINT "canteen_dish_prices_price_ck" CHECK ("canteen_dish_prices"."price_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "canteen_dishes" (
	"id" text PRIMARY KEY NOT NULL,
	"outlet_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"meal" text NOT NULL,
	"food_type" text NOT NULL,
	"allergens" text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "canteen_dishes_meal_ck" CHECK ("canteen_dishes"."meal" in ('breakfast', 'lunch', 'snacks', 'dinner', 'all_day')),
	CONSTRAINT "canteen_dishes_food_type_ck" CHECK ("canteen_dishes"."food_type" in ('veg', 'egg', 'non_veg')),
	CONSTRAINT "canteen_dishes_allergens_ck" CHECK ("canteen_dishes"."allergens" <@ array['gluten', 'crustacean', 'milk', 'egg', 'fish', 'peanut', 'tree_nut', 'soy', 'sulphite']::text[])
);
--> statement-breakpoint
CREATE TABLE "canteen_free_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"per_day" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "canteen_free_rules_per_day_ck" CHECK ("canteen_free_rules"."per_day" > 0)
);
--> statement-breakpoint
CREATE TABLE "canteen_outlets" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"caterer_name" text,
	"caterer_gstin" text,
	"monthly_rent_paise" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "canteen_outlets_kind_ck" CHECK ("canteen_outlets"."kind" in ('in_house', 'caterer')),
	CONSTRAINT "canteen_outlets_caterer_ck" CHECK ("canteen_outlets"."kind" = 'in_house' or ("canteen_outlets"."caterer_name" is not null and "canteen_outlets"."caterer_gstin" is not null and "canteen_outlets"."monthly_rent_paise" is not null)),
	CONSTRAINT "canteen_outlets_rent_ck" CHECK ("canteen_outlets"."monthly_rent_paise" is null or "canteen_outlets"."monthly_rent_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "canteen_rent_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_no" text NOT NULL,
	"outlet_id" text NOT NULL,
	"month" text NOT NULL,
	"sac_code" text NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	CONSTRAINT "canteen_rent_invoices_sum_ck" CHECK ("canteen_rent_invoices"."taxable_paise" + "canteen_rent_invoices"."cgst_paise" + "canteen_rent_invoices"."sgst_paise" = "canteen_rent_invoices"."total_paise")
);
--> statement-breakpoint
CREATE TABLE "canteen_sale_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"sale_id" text NOT NULL,
	"dish_id" text NOT NULL,
	"dish_name" text NOT NULL,
	"food_type" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_paise" bigint NOT NULL,
	"net_paise" bigint NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"gst_treatment" text NOT NULL,
	"gst_category" text,
	"gst_rate_bps" integer NOT NULL,
	CONSTRAINT "canteen_sale_lines_qty_ck" CHECK ("canteen_sale_lines"."qty" > 0),
	CONSTRAINT "canteen_sale_lines_treatment_ck" CHECK ("canteen_sale_lines"."gst_treatment" in ('taxable', 'exempt', 'not_supply', 'caterer')),
	CONSTRAINT "canteen_sale_lines_sum_ck" CHECK ("canteen_sale_lines"."taxable_paise" + "canteen_sale_lines"."cgst_paise" + "canteen_sale_lines"."sgst_paise" = "canteen_sale_lines"."net_paise"),
	CONSTRAINT "canteen_sale_lines_taxed_ck" CHECK ("canteen_sale_lines"."gst_treatment" = 'taxable' or ("canteen_sale_lines"."cgst_paise" = 0 and "canteen_sale_lines"."sgst_paise" = 0))
);
--> statement-breakpoint
CREATE TABLE "canteen_sales" (
	"id" text PRIMARY KEY NOT NULL,
	"sale_no" text NOT NULL,
	"token" integer NOT NULL,
	"outlet_id" text NOT NULL,
	"session_id" text,
	"channel" text NOT NULL,
	"state" text NOT NULL,
	"pay_mode" text NOT NULL,
	"upi_reference" text,
	"admission_id" text,
	"patient_id" text,
	"for_patient" boolean DEFAULT false NOT NULL,
	"staff_card_id" text,
	"staff_user_id" text,
	"staff_rule_id" text,
	"staff_rule" jsonb,
	"night_meal" boolean DEFAULT false NOT NULL,
	"deduction_paise" bigint DEFAULT 0 NOT NULL,
	"cost_centre_id" text,
	"free_rule_id" text,
	"free_note" text,
	"grant_id" text,
	"bed_qr_id" text,
	"total_paise" bigint NOT NULL,
	"menu_value_paise" bigint NOT NULL,
	"tendered_paise" bigint,
	"idempotency_key" text NOT NULL,
	"sold_by" text NOT NULL,
	"sold_at" timestamp with time zone NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "canteen_sales_channel_ck" CHECK ("canteen_sales"."channel" in ('counter', 'bed_qr')),
	CONSTRAINT "canteen_sales_state_ck" CHECK ("canteen_sales"."state" in ('completed', 'awaiting_confirmation', 'cancelled')),
	CONSTRAINT "canteen_sales_pay_mode_ck" CHECK ("canteen_sales"."pay_mode" in ('cash', 'upi', 'staff_card', 'ipd_bill', 'bed_class', 'cost_centre', 'free_rule', 'charity')),
	CONSTRAINT "canteen_sales_upi_ck" CHECK ("canteen_sales"."pay_mode" <> 'upi' or "canteen_sales"."upi_reference" is not null),
	CONSTRAINT "canteen_sales_admission_ck" CHECK ("canteen_sales"."pay_mode" not in ('ipd_bill', 'bed_class') or "canteen_sales"."admission_id" is not null),
	CONSTRAINT "canteen_sales_patient_ck" CHECK (not "canteen_sales"."for_patient" or "canteen_sales"."admission_id" is not null),
	CONSTRAINT "canteen_sales_staff_ck" CHECK ("canteen_sales"."pay_mode" <> 'staff_card' or ("canteen_sales"."staff_card_id" is not null and "canteen_sales"."staff_rule_id" is not null and "canteen_sales"."staff_rule" is not null)),
	CONSTRAINT "canteen_sales_cost_centre_ck" CHECK ("canteen_sales"."pay_mode" <> 'cost_centre' or "canteen_sales"."cost_centre_id" is not null),
	CONSTRAINT "canteen_sales_free_rule_ck" CHECK ("canteen_sales"."pay_mode" <> 'free_rule' or ("canteen_sales"."free_rule_id" is not null and "canteen_sales"."free_note" is not null)),
	CONSTRAINT "canteen_sales_charity_ck" CHECK ("canteen_sales"."pay_mode" <> 'charity' or "canteen_sales"."grant_id" is not null),
	CONSTRAINT "canteen_sales_session_ck" CHECK ("canteen_sales"."state" <> 'completed' or "canteen_sales"."pay_mode" not in ('cash', 'upi') or "canteen_sales"."session_id" is not null),
	CONSTRAINT "canteen_sales_money_ck" CHECK ("canteen_sales"."total_paise" >= 0 and "canteen_sales"."deduction_paise" >= 0 and "canteen_sales"."deduction_paise" <= "canteen_sales"."total_paise")
);
--> statement-breakpoint
CREATE TABLE "canteen_series" (
	"series_key" text NOT NULL,
	"period" text NOT NULL,
	"next_no" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "canteen_series_series_key_period_pk" PRIMARY KEY("series_key","period")
);
--> statement-breakpoint
CREATE TABLE "canteen_staff_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"category_id" text NOT NULL,
	"staff_code" text NOT NULL,
	"photo_document_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canteen_staff_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canteen_staff_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"price_basis" text NOT NULL,
	"daily_cap" integer NOT NULL,
	"night_meal" boolean NOT NULL,
	"salary_deduction" boolean NOT NULL,
	"gst" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"set_by" text NOT NULL,
	CONSTRAINT "canteen_staff_rules_basis_ck" CHECK ("canteen_staff_rules"."price_basis" in ('free', 'staff', 'subsidised', 'public')),
	CONSTRAINT "canteen_staff_rules_gst_ck" CHECK ("canteen_staff_rules"."gst" in ('not_supply', 'taxable')),
	CONSTRAINT "canteen_staff_rules_cap_ck" CHECK ("canteen_staff_rules"."daily_cap" >= 0)
);
--> statement-breakpoint
CREATE TABLE "canteen_till_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"till_id" text NOT NULL,
	"cashier_id" text NOT NULL,
	"state" text NOT NULL,
	"opening_cash_paise" bigint NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"expected_cash_paise" bigint,
	"counted_cash_paise" bigint,
	"close_note" text,
	"variance_approved_by" text,
	"variance_approved_at" timestamp with time zone,
	"variance_note" text,
	CONSTRAINT "canteen_till_sessions_state_ck" CHECK ("canteen_till_sessions"."state" in ('open', 'variance_pending', 'closed')),
	CONSTRAINT "canteen_till_sessions_close_ck" CHECK ("canteen_till_sessions"."state" = 'open' or ("canteen_till_sessions"."closed_at" is not null and "canteen_till_sessions"."expected_cash_paise" is not null and "canteen_till_sessions"."counted_cash_paise" is not null))
);
--> statement-breakpoint
CREATE TABLE "canteen_tills" (
	"id" text PRIMARY KEY NOT NULL,
	"outlet_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ipd_charge_exceptions" DROP CONSTRAINT "ipd_charge_exceptions_component_ck";--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" DROP CONSTRAINT "ipd_charge_lines_component_ck";--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" DROP CONSTRAINT "ipd_charge_lines_source_ck";--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD COLUMN "canteen_sale_line_id" text;--> statement-breakpoint
ALTER TABLE "canteen_bed_qrs" ADD CONSTRAINT "canteen_bed_qrs_bed_id_resources_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_bed_qrs" ADD CONSTRAINT "canteen_bed_qrs_outlet_id_canteen_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."canteen_outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_dish_prices" ADD CONSTRAINT "canteen_dish_prices_dish_id_canteen_dishes_id_fk" FOREIGN KEY ("dish_id") REFERENCES "public"."canteen_dishes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_dishes" ADD CONSTRAINT "canteen_dishes_outlet_id_canteen_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."canteen_outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_rent_invoices" ADD CONSTRAINT "canteen_rent_invoices_outlet_id_canteen_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."canteen_outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_sale_lines" ADD CONSTRAINT "canteen_sale_lines_sale_id_canteen_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."canteen_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_sale_lines" ADD CONSTRAINT "canteen_sale_lines_dish_id_canteen_dishes_id_fk" FOREIGN KEY ("dish_id") REFERENCES "public"."canteen_dishes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_sales" ADD CONSTRAINT "canteen_sales_outlet_id_canteen_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."canteen_outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_sales" ADD CONSTRAINT "canteen_sales_session_id_canteen_till_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."canteen_till_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_sales" ADD CONSTRAINT "canteen_sales_staff_card_id_canteen_staff_cards_id_fk" FOREIGN KEY ("staff_card_id") REFERENCES "public"."canteen_staff_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_sales" ADD CONSTRAINT "canteen_sales_staff_rule_id_canteen_staff_rules_id_fk" FOREIGN KEY ("staff_rule_id") REFERENCES "public"."canteen_staff_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_sales" ADD CONSTRAINT "canteen_sales_cost_centre_id_canteen_cost_centres_id_fk" FOREIGN KEY ("cost_centre_id") REFERENCES "public"."canteen_cost_centres"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_sales" ADD CONSTRAINT "canteen_sales_free_rule_id_canteen_free_rules_id_fk" FOREIGN KEY ("free_rule_id") REFERENCES "public"."canteen_free_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_sales" ADD CONSTRAINT "canteen_sales_bed_qr_id_canteen_bed_qrs_id_fk" FOREIGN KEY ("bed_qr_id") REFERENCES "public"."canteen_bed_qrs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_staff_cards" ADD CONSTRAINT "canteen_staff_cards_category_id_canteen_staff_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."canteen_staff_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_staff_rules" ADD CONSTRAINT "canteen_staff_rules_category_id_canteen_staff_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."canteen_staff_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_till_sessions" ADD CONSTRAINT "canteen_till_sessions_till_id_canteen_tills_id_fk" FOREIGN KEY ("till_id") REFERENCES "public"."canteen_tills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canteen_tills" ADD CONSTRAINT "canteen_tills_outlet_id_canteen_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."canteen_outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canteen_bed_qrs_token_ux" ON "canteen_bed_qrs" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "canteen_bed_qrs_live_ux" ON "canteen_bed_qrs" USING btree ("bed_id") WHERE "canteen_bed_qrs"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "canteen_charity_grants_approval_ux" ON "canteen_charity_grants" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "canteen_charity_grants_admission_idx" ON "canteen_charity_grants" USING btree ("admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canteen_cost_centres_code_ux" ON "canteen_cost_centres" USING btree ("code");--> statement-breakpoint
CREATE INDEX "canteen_dish_prices_dish_idx" ON "canteen_dish_prices" USING btree ("dish_id","list","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "canteen_dishes_code_ux" ON "canteen_dishes" USING btree ("outlet_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "canteen_free_rules_code_ux" ON "canteen_free_rules" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "canteen_outlets_code_ux" ON "canteen_outlets" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "canteen_rent_invoices_no_ux" ON "canteen_rent_invoices" USING btree ("invoice_no");--> statement-breakpoint
CREATE UNIQUE INDEX "canteen_rent_invoices_month_ux" ON "canteen_rent_invoices" USING btree ("outlet_id","month");--> statement-breakpoint
CREATE INDEX "canteen_sale_lines_sale_idx" ON "canteen_sale_lines" USING btree ("sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canteen_sales_no_ux" ON "canteen_sales" USING btree ("sale_no");--> statement-breakpoint
CREATE UNIQUE INDEX "canteen_sales_key_ux" ON "canteen_sales" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "canteen_sales_session_idx" ON "canteen_sales" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "canteen_sales_outlet_idx" ON "canteen_sales" USING btree ("outlet_id","sold_at");--> statement-breakpoint
CREATE INDEX "canteen_sales_admission_idx" ON "canteen_sales" USING btree ("admission_id","sold_at");--> statement-breakpoint
CREATE INDEX "canteen_sales_staff_idx" ON "canteen_sales" USING btree ("staff_user_id","sold_at");--> statement-breakpoint
CREATE INDEX "canteen_sales_grant_idx" ON "canteen_sales" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canteen_staff_cards_user_ux" ON "canteen_staff_cards" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canteen_staff_cards_code_ux" ON "canteen_staff_cards" USING btree ("staff_code");--> statement-breakpoint
CREATE UNIQUE INDEX "canteen_staff_categories_code_ux" ON "canteen_staff_categories" USING btree ("code");--> statement-breakpoint
CREATE INDEX "canteen_staff_rules_category_idx" ON "canteen_staff_rules" USING btree ("category_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "canteen_till_sessions_open_ux" ON "canteen_till_sessions" USING btree ("till_id") WHERE "canteen_till_sessions"."state" = 'open';--> statement-breakpoint
CREATE INDEX "canteen_till_sessions_till_idx" ON "canteen_till_sessions" USING btree ("till_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "canteen_tills_code_ux" ON "canteen_tills" USING btree ("code");--> statement-breakpoint
CREATE INDEX "canteen_tills_outlet_idx" ON "canteen_tills" USING btree ("outlet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_charge_lines_canteen_ux" ON "ipd_charge_lines" USING btree ("canteen_sale_line_id") WHERE "ipd_charge_lines"."source" = 'ipd.canteen';--> statement-breakpoint
ALTER TABLE "ipd_charge_exceptions" ADD CONSTRAINT "ipd_charge_exceptions_component_ck" CHECK ("ipd_charge_exceptions"."component" is null or "ipd_charge_exceptions"."component" in ('room', 'nursing', 'rmo', 'visit', 'cross_visit', 'lab', 'imaging', 'pharmacy', 'er', 'canteen'));--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD CONSTRAINT "ipd_charge_lines_component_ck" CHECK ("ipd_charge_lines"."component" in ('room', 'nursing', 'rmo', 'visit', 'cross_visit', 'lab', 'imaging', 'pharmacy', 'er', 'canteen'));--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD CONSTRAINT "ipd_charge_lines_source_ck" CHECK ("ipd_charge_lines"."source" in ('ipd.nightly', 'ipd.visit', 'ipd.reversal', 'ipd.order', 'ipd.pharmacy', 'ipd.er', 'ipd.canteen'));--> statement-breakpoint
CREATE FUNCTION canteen_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;--> statement-breakpoint
CREATE TRIGGER canteen_dish_prices_append_only BEFORE UPDATE OR DELETE ON canteen_dish_prices FOR EACH ROW EXECUTE FUNCTION canteen_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER canteen_staff_rules_append_only BEFORE UPDATE OR DELETE ON canteen_staff_rules FOR EACH ROW EXECUTE FUNCTION canteen_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER canteen_sale_lines_append_only BEFORE UPDATE OR DELETE ON canteen_sale_lines FOR EACH ROW EXECUTE FUNCTION canteen_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER canteen_rent_invoices_append_only BEFORE UPDATE OR DELETE ON canteen_rent_invoices FOR EACH ROW EXECUTE FUNCTION canteen_forbid_mutation();--> statement-breakpoint
-- Decision 0088 GST positions (the CA confirms): canteen food 5% (SAC 996331, no ITC), caterer rent 18% (SAC 997212),
-- in-patient diet exempt healthcare (rate_bps holds the would-be rate, gst_config convention). Staff recovery has NO row:
-- finance sets it, and a taxable staff sale is refused until it does.
INSERT INTO gst_config (category, sac_code, exempt, rate_bps, updated_by) VALUES
  ('canteen_food', '996331', false, 500, 'migration:0262_canteen'),
  ('canteen_rent', '997212', false, 1800, 'migration:0262_canteen'),
  ('inpatient_diet', '999311', true, 500, 'migration:0262_canteen')
ON CONFLICT (category) DO NOTHING;
--> statement-breakpoint
-- The two tariff services an IPD-bill meal posts against (the price is always the canteen's prepaid quote, so neither
-- needs a tariff item). `modules/canteen/seed.ts` writes the same rows for a truncated test database.
INSERT INTO services (id, code, name, category, created_by, updated_by) VALUES
  ('svc-canteen-meal', 'CANTEEN_MEAL', 'Canteen meal (attendant)', 'canteen_food', 'migration:0262_canteen', 'migration:0262_canteen'),
  ('svc-canteen-diet', 'CANTEEN_DIET', 'Patient meal (in-patient diet)', 'inpatient_diet', 'migration:0262_canteen', 'migration:0262_canteen')
ON CONFLICT (code) DO NOTHING;
