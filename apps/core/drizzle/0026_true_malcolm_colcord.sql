CREATE TABLE "formulary_interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"salt_a_id" text NOT NULL,
	"salt_b_id" text NOT NULL,
	"severity" text NOT NULL,
	"note" text NOT NULL,
	"source" text NOT NULL,
	"route_scope" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formulary_interactions_ordered_ck" CHECK ("formulary_interactions"."salt_a_id" < "formulary_interactions"."salt_b_id"),
	CONSTRAINT "formulary_interactions_severity_ck" CHECK ("formulary_interactions"."severity" in ('severe', 'moderate')),
	CONSTRAINT "formulary_interactions_route_scope_ck" CHECK ("formulary_interactions"."route_scope" is null or "formulary_interactions"."route_scope" = 'systemic_only')
);
--> statement-breakpoint
CREATE TABLE "formulary_medicine_salts" (
	"medicine_id" text NOT NULL,
	"salt_id" text NOT NULL,
	"strength" text,
	CONSTRAINT "formulary_medicine_salts_medicine_id_salt_id_pk" PRIMARY KEY("medicine_id","salt_id")
);
--> statement-breakpoint
CREATE TABLE "formulary_medicines" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_name" text NOT NULL,
	"form" text NOT NULL,
	"route_class" text DEFAULT 'systemic' NOT NULL,
	"strength_label" text,
	"schedule_flag" text,
	"staging_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formulary_medicines_route_class_ck" CHECK ("formulary_medicines"."route_class" in ('systemic', 'topical')),
	CONSTRAINT "formulary_medicines_schedule_flag_ck" CHECK ("formulary_medicines"."schedule_flag" is null or "formulary_medicines"."schedule_flag" in ('H', 'H1', 'X', 'OTC'))
);
--> statement-breakpoint
CREATE TABLE "formulary_salts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"drug_class" text,
	"atc_code" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "formulary_staging" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_url" text NOT NULL,
	"mined_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"medicine_id" text,
	CONSTRAINT "formulary_staging_kind_ck" CHECK ("formulary_staging"."kind" in ('medicine')),
	CONSTRAINT "formulary_staging_status_ck" CHECK ("formulary_staging"."status" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "formulary_interactions" ADD CONSTRAINT "formulary_interactions_salt_a_id_formulary_salts_id_fk" FOREIGN KEY ("salt_a_id") REFERENCES "public"."formulary_salts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formulary_interactions" ADD CONSTRAINT "formulary_interactions_salt_b_id_formulary_salts_id_fk" FOREIGN KEY ("salt_b_id") REFERENCES "public"."formulary_salts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formulary_medicine_salts" ADD CONSTRAINT "formulary_medicine_salts_medicine_id_formulary_medicines_id_fk" FOREIGN KEY ("medicine_id") REFERENCES "public"."formulary_medicines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formulary_medicine_salts" ADD CONSTRAINT "formulary_medicine_salts_salt_id_formulary_salts_id_fk" FOREIGN KEY ("salt_id") REFERENCES "public"."formulary_salts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "formulary_interactions_pair_ux" ON "formulary_interactions" USING btree ("salt_a_id","salt_b_id");--> statement-breakpoint
CREATE UNIQUE INDEX "formulary_medicines_brand_lower_ux" ON "formulary_medicines" USING btree (lower("brand_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "formulary_salts_name_lower_ux" ON "formulary_salts" USING btree (lower("name"));