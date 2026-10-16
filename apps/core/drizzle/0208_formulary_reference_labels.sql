CREATE TABLE "formulary_reference_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"retrieved_on" date NOT NULL,
	"ref_key" text NOT NULL,
	"label_id" text NOT NULL,
	"set_id" text NOT NULL,
	"version" text NOT NULL,
	"product" text NOT NULL,
	"product_type" text,
	"effective_date" date,
	"match_tier" text,
	"sections" jsonb NOT NULL,
	"import_batch" text NOT NULL,
	"imported_by" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by" text
);
--> statement-breakpoint
CREATE TABLE "formulary_reference_names" (
	"name" text PRIMARY KEY NOT NULL,
	"ref_key" text NOT NULL,
	"import_batch" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formulary_reference_names_lower_ck" CHECK ("formulary_reference_names"."name" = lower("formulary_reference_names"."name"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "formulary_reference_labels_live_ux" ON "formulary_reference_labels" USING btree ("source","ref_key") WHERE "formulary_reference_labels"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "formulary_reference_labels_key_idx" ON "formulary_reference_labels" USING btree ("ref_key");--> statement-breakpoint
CREATE INDEX "formulary_reference_labels_key_trgm_idx" ON "formulary_reference_labels" USING gin ("ref_key" gin_trgm_ops);