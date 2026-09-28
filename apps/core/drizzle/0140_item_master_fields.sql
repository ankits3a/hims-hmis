ALTER TABLE "items" ADD COLUMN "manufacturer" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "lead_time_days" integer;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "lasa" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "high_alert" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_lead_time_ck" CHECK ("items"."lead_time_days" is null or "items"."lead_time_days" between 1 and 365);