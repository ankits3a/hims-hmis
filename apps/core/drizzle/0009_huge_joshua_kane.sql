ALTER TABLE "adjustment_rules" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "regulated_prices" ADD COLUMN "seq" bigserial NOT NULL;