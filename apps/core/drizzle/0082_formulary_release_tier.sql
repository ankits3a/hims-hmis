CREATE TABLE "formulary_generic_substances" (
	"generic_id" text NOT NULL,
	"substance_id" text NOT NULL,
	"strength" text,
	"unit" text,
	CONSTRAINT "formulary_generic_substances_generic_id_substance_id_pk" PRIMARY KEY("generic_id","substance_id")
);
--> statement-breakpoint
CREATE TABLE "formulary_generics" (
	"id" text PRIMARY KEY NOT NULL,
	"sctid" text NOT NULL,
	"name" text NOT NULL,
	"dose_form" text NOT NULL,
	"route_of_administration" text NOT NULL,
	"composition_summary" text,
	"source" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "formulary_substances" (
	"id" text PRIMARY KEY NOT NULL,
	"sctid" text NOT NULL,
	"name" text NOT NULL,
	"synonyms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"salt_id" text,
	"mapping_status" text DEFAULT 'pending' NOT NULL,
	"mapped_by" text,
	"mapped_at" timestamp with time zone,
	"source" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formulary_substances_mapping_status_ck" CHECK ("formulary_substances"."mapping_status" in ('pending', 'mapped', 'unmappable')),
	CONSTRAINT "formulary_substances_mapped_has_salt_ck" CHECK (("formulary_substances"."mapping_status" = 'mapped') = ("formulary_substances"."salt_id" is not null)),
	CONSTRAINT "formulary_substances_decided_audit_ck" CHECK (("formulary_substances"."mapping_status" = 'pending') = ("formulary_substances"."mapped_by" is null and "formulary_substances"."mapped_at" is null))
);
--> statement-breakpoint
ALTER TABLE "formulary_medicine_salts" ADD COLUMN "source" text DEFAULT 'curated' NOT NULL;--> statement-breakpoint
ALTER TABLE "formulary_generic_substances" ADD CONSTRAINT "formulary_generic_substances_generic_id_formulary_generics_id_fk" FOREIGN KEY ("generic_id") REFERENCES "public"."formulary_generics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formulary_generic_substances" ADD CONSTRAINT "formulary_generic_substances_substance_id_formulary_substances_id_fk" FOREIGN KEY ("substance_id") REFERENCES "public"."formulary_substances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formulary_substances" ADD CONSTRAINT "formulary_substances_salt_id_formulary_salts_id_fk" FOREIGN KEY ("salt_id") REFERENCES "public"."formulary_salts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "formulary_generics_sctid_ux" ON "formulary_generics" USING btree ("sctid");--> statement-breakpoint
CREATE UNIQUE INDEX "formulary_substances_sctid_ux" ON "formulary_substances" USING btree ("sctid");--> statement-breakpoint
CREATE UNIQUE INDEX "formulary_substances_name_lower_ux" ON "formulary_substances" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "formulary_substances_salt_idx" ON "formulary_substances" USING btree ("salt_id");--> statement-breakpoint
ALTER TABLE "formulary_medicine_salts" ADD CONSTRAINT "formulary_medicine_salts_source_ck" CHECK ("formulary_medicine_salts"."source" in ('curated', 'derived'));