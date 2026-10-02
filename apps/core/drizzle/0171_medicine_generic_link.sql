ALTER TABLE "formulary_medicines" ADD COLUMN "generic_sctid" text;--> statement-breakpoint
CREATE INDEX "formulary_medicines_generic_sctid_idx" ON "formulary_medicines" USING btree ("generic_sctid");