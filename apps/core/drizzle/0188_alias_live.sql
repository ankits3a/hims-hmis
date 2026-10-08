ALTER TABLE "cds_aliases" ADD COLUMN "term_key" text;--> statement-breakpoint
CREATE INDEX "cds_aliases_term_key_idx" ON "cds_aliases" USING btree ("term_key");