ALTER TABLE "formulary_medicines" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "formulary_medicines" ADD COLUMN "salt_rank" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "formulary_medicines" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "formulary_salts" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "formulary_salts" ADD COLUMN "product_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "formulary_medicine_salts_salt_idx" ON "formulary_medicine_salts" USING btree ("salt_id");--> statement-breakpoint
CREATE INDEX "formulary_medicines_brand_trgm_idx" ON "formulary_medicines" USING gin (lower("brand_name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "formulary_medicines_code_idx" ON "formulary_medicines" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "formulary_salts_name_trgm_idx" ON "formulary_salts" USING gin (lower("name") gin_trgm_ops);