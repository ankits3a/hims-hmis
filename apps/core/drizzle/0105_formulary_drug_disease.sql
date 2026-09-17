CREATE TABLE "formulary_drug_disease" (
	"id" text PRIMARY KEY NOT NULL,
	"salt_id" text NOT NULL,
	"icd10_prefix" text NOT NULL,
	"icd10_title" text NOT NULL,
	"severity" text NOT NULL,
	"note" text NOT NULL,
	"alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	"route_scope" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formulary_drug_disease_severity_ck" CHECK ("formulary_drug_disease"."severity" in ('severe', 'moderate')),
	CONSTRAINT "formulary_drug_disease_prefix_ck" CHECK ("formulary_drug_disease"."icd10_prefix" ~ '^[A-Z][A-Z0-9]{2}([.][A-Z0-9]{1,3})?$'),
	CONSTRAINT "formulary_drug_disease_note_ck" CHECK (length(btrim("formulary_drug_disease"."note")) > 0),
	CONSTRAINT "formulary_drug_disease_title_ck" CHECK (length(btrim("formulary_drug_disease"."icd10_title")) > 0),
	CONSTRAINT "formulary_drug_disease_route_scope_ck" CHECK ("formulary_drug_disease"."route_scope" is null or "formulary_drug_disease"."route_scope" = 'systemic_only')
);
--> statement-breakpoint
ALTER TABLE "formulary_drug_disease" ADD CONSTRAINT "formulary_drug_disease_salt_id_formulary_salts_id_fk" FOREIGN KEY ("salt_id") REFERENCES "public"."formulary_salts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "formulary_drug_disease_ux" ON "formulary_drug_disease" USING btree ("salt_id","icd10_prefix");--> statement-breakpoint
CREATE INDEX "formulary_drug_disease_prefix_idx" ON "formulary_drug_disease" USING btree ("icd10_prefix");