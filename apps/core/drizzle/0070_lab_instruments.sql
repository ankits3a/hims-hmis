CREATE TABLE "lab_instrument_codes" (
	"instrument_id" text NOT NULL,
	"instrument_code" text NOT NULL,
	"analyte_id" text NOT NULL,
	"unit" text,
	"factor" numeric(14, 6) DEFAULT '1' NOT NULL,
	CONSTRAINT "lab_instrument_codes_instrument_id_instrument_code_pk" PRIMARY KEY("instrument_id","instrument_code"),
	CONSTRAINT "lab_instrument_codes_factor_ck" CHECK ("lab_instrument_codes"."factor" > 0)
);
--> statement-breakpoint
CREATE TABLE "lab_instruments" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"sample_id_mode" text NOT NULL,
	"connection" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "lab_instruments_sample_id_mode_ck" CHECK ("lab_instruments"."sample_id_mode" in ('barcode', 'typed_id', 'run_sheet', 'plate_map'))
);
--> statement-breakpoint
ALTER TABLE "lab_instrument_codes" ADD CONSTRAINT "lab_instrument_codes_instrument_id_lab_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."lab_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_instrument_codes" ADD CONSTRAINT "lab_instrument_codes_analyte_id_lab_analytes_id_fk" FOREIGN KEY ("analyte_id") REFERENCES "public"."lab_analytes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_instruments" ADD CONSTRAINT "lab_instruments_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_instrument_codes_analyte_idx" ON "lab_instrument_codes" USING btree ("analyte_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_instruments_resource_ux" ON "lab_instruments" USING btree ("resource_id");