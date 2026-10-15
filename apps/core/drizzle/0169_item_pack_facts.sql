ALTER TABLE "items" ADD COLUMN "mfg_licence_no" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "pharmacopoeia" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "lasa_note" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "storage_max_c" integer;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_storage_max_c_ck" CHECK ("items"."storage_max_c" is null or "items"."storage_max_c" between -80 and 60);