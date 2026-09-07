CREATE TABLE "lab_catalogue_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"file_names" text NOT NULL,
	"file_hash" text NOT NULL,
	"analytes_written" integer DEFAULT 0 NOT NULL,
	"orderables_written" integer DEFAULT 0 NOT NULL,
	"ranges_written" integer DEFAULT 0 NOT NULL,
	"imported_by" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "lab_catalogue_imports_hash_ux" ON "lab_catalogue_imports" USING btree ("file_hash");