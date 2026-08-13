CREATE TABLE "adjustment_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_key" text NOT NULL,
	"source_key" text NOT NULL,
	"title" text NOT NULL,
	"params" jsonb NOT NULL,
	"service_category" text,
	"service_id" text,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gst_config" (
	"category" text PRIMARY KEY NOT NULL,
	"sac_code" text NOT NULL,
	"exempt" boolean NOT NULL,
	"rate_bps" integer NOT NULL,
	"special_rule" text,
	"threshold_paise" bigint,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gst_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"composite_healthcare_exempt" boolean DEFAULT true NOT NULL,
	"ca_signed" boolean DEFAULT false NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulated_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"mrp_paise" bigint,
	"ceiling_paise" bigint,
	"effective_from" timestamp with time zone NOT NULL,
	"gazette_ref" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"regulated" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tariff_items" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"service_id" text NOT NULL,
	"price_paise" bigint NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tariff_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"version_no" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"approval_id" text,
	"effective_from" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_by" text,
	"submitted_at" timestamp with time zone,
	"activated_by" text,
	"activated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "regulated_prices" ADD CONSTRAINT "regulated_prices_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariff_items" ADD CONSTRAINT "tariff_items_version_id_tariff_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."tariff_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariff_items" ADD CONSTRAINT "tariff_items_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "adjustment_rules_key_ux" ON "adjustment_rules" USING btree ("rule_key");--> statement-breakpoint
CREATE INDEX "adjustment_rules_source_idx" ON "adjustment_rules" USING btree ("source_key");--> statement-breakpoint
CREATE INDEX "regulated_prices_service_idx" ON "regulated_prices" USING btree ("service_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "services_code_ux" ON "services" USING btree ("code");--> statement-breakpoint
CREATE INDEX "services_category_idx" ON "services" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "tariff_items_version_service_ux" ON "tariff_items" USING btree ("version_id","service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tariff_versions_no_ux" ON "tariff_versions" USING btree ("version_no");--> statement-breakpoint
CREATE INDEX "tariff_versions_status_idx" ON "tariff_versions" USING btree ("status");