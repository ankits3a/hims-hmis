CREATE TABLE "icd10_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"raw_code" text NOT NULL,
	"order_number" integer NOT NULL,
	"billable" boolean NOT NULL,
	"short_description" text NOT NULL,
	"long_description" text NOT NULL,
	"chapter_no" integer NOT NULL,
	"chapter_name" text NOT NULL,
	"generality" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "icd10_codes_desc_trgm_idx" ON "icd10_codes" USING gin (lower("short_description") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "icd10_codes_code_lower_idx" ON "icd10_codes" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "icd10_codes_billable_idx" ON "icd10_codes" USING btree ("billable");