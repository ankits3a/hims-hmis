CREATE TABLE "icd11_map_loads" (
	"id" text PRIMARY KEY NOT NULL,
	"release" text NOT NULL,
	"source_file" text NOT NULL,
	"sha256" text NOT NULL,
	"row_count" integer NOT NULL,
	"loaded_by" text NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "icd11_map_loads_release_uq" UNIQUE("release"),
	CONSTRAINT "icd11_map_loads_sha256_uq" UNIQUE("sha256"),
	CONSTRAINT "icd11_map_loads_release_ck" CHECK ("icd11_map_loads"."release" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "icd11_map_loads_row_count_ck" CHECK ("icd11_map_loads"."row_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "icd11_map_rows" (
	"release" text NOT NULL,
	"icd10_code" text NOT NULL,
	"icd10_title" text NOT NULL,
	"icd11_code" text NOT NULL,
	"icd11_title" text NOT NULL,
	"icd11_chapter" text NOT NULL,
	"icd11_class_kind" text NOT NULL,
	"icd11_release_uri" text NOT NULL,
	"icd11_foundation_uri" text NOT NULL,
	"map_kind" text NOT NULL,
	CONSTRAINT "icd11_map_rows_release_icd10_code_pk" PRIMARY KEY("release","icd10_code"),
	CONSTRAINT "icd11_map_rows_map_kind_ck" CHECK ("icd11_map_rows"."map_kind" in ('mapped', 'no_mapping', 'grouping'))
);
--> statement-breakpoint
ALTER TABLE "icd11_map_rows" ADD CONSTRAINT "icd11_map_rows_release_icd11_map_loads_release_fk" FOREIGN KEY ("release") REFERENCES "public"."icd11_map_loads"("release") ON DELETE no action ON UPDATE no action;