CREATE TABLE "formulary_generic_salts" (
	"generic_id" text NOT NULL,
	"salt_id" text NOT NULL,
	"strength" text,
	"unit" text,
	CONSTRAINT "formulary_generic_salts_generic_id_salt_id_pk" PRIMARY KEY("generic_id","salt_id")
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
ALTER TABLE "formulary_salts" ADD COLUMN "sctid" text;--> statement-breakpoint
ALTER TABLE "formulary_generic_salts" ADD CONSTRAINT "formulary_generic_salts_generic_id_formulary_generics_id_fk" FOREIGN KEY ("generic_id") REFERENCES "public"."formulary_generics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formulary_generic_salts" ADD CONSTRAINT "formulary_generic_salts_salt_id_formulary_salts_id_fk" FOREIGN KEY ("salt_id") REFERENCES "public"."formulary_salts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "formulary_generics_sctid_ux" ON "formulary_generics" USING btree ("sctid");--> statement-breakpoint
CREATE UNIQUE INDEX "formulary_salts_sctid_ux" ON "formulary_salts" USING btree ("sctid");