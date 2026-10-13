CREATE TABLE "ipd_charge_exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"admission_id" text NOT NULL,
	"service_date" date,
	"component" text,
	"billed_class" text,
	"service_code" text,
	"reason" text NOT NULL,
	"tariff_version_id" text,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_line_id" text,
	CONSTRAINT "ipd_charge_exceptions_component_ck" CHECK ("ipd_charge_exceptions"."component" is null or "ipd_charge_exceptions"."component" in ('room', 'nursing', 'rmo', 'visit', 'cross_visit')),
	CONSTRAINT "ipd_charge_exceptions_reason_ck" CHECK ("ipd_charge_exceptions"."reason" in ('rate_missing', 'tariff_missing', 'posting_failed')),
	CONSTRAINT "ipd_charge_exceptions_shape_ck" CHECK (("ipd_charge_exceptions"."reason" = 'posting_failed') = ("ipd_charge_exceptions"."component" is null) and ("ipd_charge_exceptions"."component" is null) = ("ipd_charge_exceptions"."service_date" is null))
);
--> statement-breakpoint
CREATE TABLE "ipd_charge_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"service_date" date NOT NULL,
	"component" text NOT NULL,
	"billed_class" text,
	"service_id" text NOT NULL,
	"service_code" text NOT NULL,
	"service_name" text NOT NULL,
	"tariff_version_id" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_paise" bigint NOT NULL,
	"gross_paise" bigint NOT NULL,
	"discount_paise" bigint NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"net_paise" bigint NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	"gst_exempt" boolean NOT NULL,
	"source" text NOT NULL,
	"consultant_user_id" text,
	"visit_seq" integer,
	"reversal_of" text,
	"reason" text,
	"posted_by" text NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_charge_lines_component_ck" CHECK ("ipd_charge_lines"."component" in ('room', 'nursing', 'rmo', 'visit', 'cross_visit')),
	CONSTRAINT "ipd_charge_lines_source_ck" CHECK ("ipd_charge_lines"."source" in ('ipd.nightly', 'ipd.visit', 'ipd.reversal')),
	CONSTRAINT "ipd_charge_lines_qty_ck" CHECK ("ipd_charge_lines"."qty" > 0),
	CONSTRAINT "ipd_charge_lines_reversal_ck" CHECK (("ipd_charge_lines"."source" = 'ipd.reversal') = ("ipd_charge_lines"."reversal_of" is not null)),
	CONSTRAINT "ipd_charge_lines_sign_ck" CHECK (case when "ipd_charge_lines"."reversal_of" is null then "ipd_charge_lines"."unit_paise" >= 0 and "ipd_charge_lines"."gross_paise" >= 0 and "ipd_charge_lines"."discount_paise" >= 0 and "ipd_charge_lines"."net_paise" >= 0
          else "ipd_charge_lines"."unit_paise" <= 0 and "ipd_charge_lines"."gross_paise" <= 0 and "ipd_charge_lines"."discount_paise" <= 0 and "ipd_charge_lines"."net_paise" <= 0 end),
	CONSTRAINT "ipd_charge_lines_visit_seq_ck" CHECK (("ipd_charge_lines"."source" = 'ipd.visit') = ("ipd_charge_lines"."visit_seq" is not null) or "ipd_charge_lines"."source" = 'ipd.reversal'),
	CONSTRAINT "ipd_charge_lines_reason_ck" CHECK ("ipd_charge_lines"."reversal_of" is null or coalesce(btrim("ipd_charge_lines"."reason"), '') <> '')
);
--> statement-breakpoint
ALTER TABLE "ipd_admissions" ADD COLUMN "tariff_version_id" text;--> statement-breakpoint
ALTER TABLE "ipd_admissions" ADD COLUMN "charges_posted_through" date;--> statement-breakpoint
ALTER TABLE "ipd_charge_exceptions" ADD CONSTRAINT "ipd_charge_exceptions_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD CONSTRAINT "ipd_charge_lines_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_charge_exceptions_key_ux" ON "ipd_charge_exceptions" USING btree ("key");--> statement-breakpoint
CREATE INDEX "ipd_charge_exceptions_open_idx" ON "ipd_charge_exceptions" USING btree ("admission_id") WHERE "ipd_charge_exceptions"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_charge_lines_nightly_ux" ON "ipd_charge_lines" USING btree ("admission_id","service_date","component") WHERE "ipd_charge_lines"."source" = 'ipd.nightly';--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_charge_lines_visit_ux" ON "ipd_charge_lines" USING btree ("admission_id","service_date","consultant_user_id","visit_seq") WHERE "ipd_charge_lines"."source" = 'ipd.visit';--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_charge_lines_reversal_ux" ON "ipd_charge_lines" USING btree ("reversal_of") WHERE "ipd_charge_lines"."reversal_of" is not null;--> statement-breakpoint
CREATE INDEX "ipd_charge_lines_admission_idx" ON "ipd_charge_lines" USING btree ("admission_id","service_date");--> statement-breakpoint
CREATE FUNCTION ipd_charge_lines_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ipd_charge_lines_immutable: running-bill lines are append-only (% refused); post a reversal', TG_OP; END $$;--> statement-breakpoint
CREATE TRIGGER ipd_charge_lines_immutable BEFORE UPDATE OR DELETE ON "ipd_charge_lines" FOR EACH ROW EXECUTE FUNCTION ipd_charge_lines_forbid_mutation();
