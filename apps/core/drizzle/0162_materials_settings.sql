CREATE TABLE "materials_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"grn_qc_needs_second_person" boolean DEFAULT false NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "materials_settings_one_row_ck" CHECK ("materials_settings"."id" = 'main')
);
