CREATE TABLE "pharmacy_tally_config" (
	"id" text PRIMARY KEY NOT NULL,
	"ledgers" jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pharmacy_tally_config_one_row_ck" CHECK ("pharmacy_tally_config"."id" = 'main')
);
--> statement-breakpoint
CREATE TABLE "pharmacy_tally_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"voucher_count" integer NOT NULL,
	"counts" jsonb NOT NULL,
	"debit_paise" bigint NOT NULL,
	"checksum" text NOT NULL,
	"ledgers" jsonb NOT NULL,
	"vouchers_xml" text NOT NULL,
	"masters_xml" text NOT NULL,
	"exported_by" text NOT NULL,
	"exported_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pharmacy_tally_exports_range_ck" CHECK ("pharmacy_tally_exports"."to_date" >= "pharmacy_tally_exports"."from_date"),
	CONSTRAINT "pharmacy_tally_exports_money_ck" CHECK ("pharmacy_tally_exports"."voucher_count" >= 0 and "pharmacy_tally_exports"."debit_paise" >= 0),
	CONSTRAINT "pharmacy_tally_exports_checksum_ck" CHECK ("pharmacy_tally_exports"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "pharmacy_tally_config" ADD CONSTRAINT "pharmacy_tally_config_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_tally_exports" ADD CONSTRAINT "pharmacy_tally_exports_exported_by_users_id_fk" FOREIGN KEY ("exported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pharmacy_tally_exports_range_idx" ON "pharmacy_tally_exports" USING btree ("from_date","to_date");--> statement-breakpoint
CREATE INDEX "pharmacy_tally_exports_at_idx" ON "pharmacy_tally_exports" USING btree ("exported_at");