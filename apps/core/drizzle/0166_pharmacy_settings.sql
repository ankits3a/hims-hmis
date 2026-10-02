CREATE TABLE "pharmacy_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"quick_desk" boolean DEFAULT false NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pharmacy_settings_one_row_ck" CHECK ("pharmacy_settings"."id" = 'main')
);
