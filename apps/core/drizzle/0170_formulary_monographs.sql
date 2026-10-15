CREATE TABLE "formulary_monographs" (
	"id" text PRIMARY KEY NOT NULL,
	"generic_id" text NOT NULL,
	"source_version" text NOT NULL,
	"patient" jsonb,
	"prescriber" jsonb,
	"nursing" jsonb,
	"affordability" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formulary_monographs_status_ck" CHECK ("formulary_monographs"."status" in ('draft', 'reviewed')),
	CONSTRAINT "formulary_monographs_review_ck" CHECK (("formulary_monographs"."status" = 'reviewed') = ("formulary_monographs"."reviewed_by" is not null) and ("formulary_monographs"."status" = 'reviewed') = ("formulary_monographs"."reviewed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "formulary_renal_doses" (
	"id" text PRIMARY KEY NOT NULL,
	"monograph_id" text NOT NULL,
	"position" integer NOT NULL,
	"crcl_min" integer,
	"crcl_max" integer,
	"dose" text NOT NULL,
	"severity" text NOT NULL,
	CONSTRAINT "formulary_renal_doses_severity_ck" CHECK ("formulary_renal_doses"."severity" in ('normal', 'reduce', 'avoid')),
	CONSTRAINT "formulary_renal_doses_bounds_ck" CHECK (("formulary_renal_doses"."crcl_min" is not null or "formulary_renal_doses"."crcl_max" is not null) and ("formulary_renal_doses"."crcl_min" is null or "formulary_renal_doses"."crcl_min" >= 0) and ("formulary_renal_doses"."crcl_min" is null or "formulary_renal_doses"."crcl_max" is null or "formulary_renal_doses"."crcl_min" < "formulary_renal_doses"."crcl_max"))
);
--> statement-breakpoint
ALTER TABLE "formulary_monographs" ADD CONSTRAINT "formulary_monographs_generic_id_formulary_generics_id_fk" FOREIGN KEY ("generic_id") REFERENCES "public"."formulary_generics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formulary_renal_doses" ADD CONSTRAINT "formulary_renal_doses_monograph_id_formulary_monographs_id_fk" FOREIGN KEY ("monograph_id") REFERENCES "public"."formulary_monographs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "formulary_monographs_generic_ux" ON "formulary_monographs" USING btree ("generic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "formulary_renal_doses_monograph_position_ux" ON "formulary_renal_doses" USING btree ("monograph_id","position");