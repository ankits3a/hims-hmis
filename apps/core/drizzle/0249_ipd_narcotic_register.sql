CREATE TABLE "ipd_narcotic_count_resolutions" (
	"id" text PRIMARY KEY NOT NULL,
	"count_id" text NOT NULL,
	"resolved_by" text NOT NULL,
	"note" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ipd_narcotic_counts" (
	"id" text PRIMARY KEY NOT NULL,
	"round_id" text NOT NULL,
	"ward_id" text NOT NULL,
	"medicine_id" text NOT NULL,
	"medicine_name" text NOT NULL,
	"unit" text NOT NULL,
	"expected_qty" double precision NOT NULL,
	"counted_qty" double precision NOT NULL,
	"variance" double precision NOT NULL,
	"shift" text NOT NULL,
	"counted_by" text NOT NULL,
	"witness_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_narcotic_counts_witness_ck" CHECK ("ipd_narcotic_counts"."witness_id" <> "ipd_narcotic_counts"."counted_by"),
	CONSTRAINT "ipd_narcotic_counts_qty_ck" CHECK ("ipd_narcotic_counts"."counted_qty" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ipd_emar_narcotic_register" DROP CONSTRAINT "ipd_emar_narcotic_kind_ck";--> statement-breakpoint
ALTER TABLE "ipd_emar_narcotic_register" ADD COLUMN "ward_id" text;--> statement-breakpoint
ALTER TABLE "ipd_emar_narcotic_register" ADD COLUMN "recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ipd_narcotic_count_resolutions" ADD CONSTRAINT "ipd_narcotic_count_resolutions_count_id_ipd_narcotic_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."ipd_narcotic_counts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_narcotic_count_resolutions_count_ux" ON "ipd_narcotic_count_resolutions" USING btree ("count_id");--> statement-breakpoint
CREATE INDEX "ipd_narcotic_counts_ward_idx" ON "ipd_narcotic_counts" USING btree ("ward_id","medicine_id","at");--> statement-breakpoint
CREATE INDEX "ipd_emar_narcotic_ward_idx" ON "ipd_emar_narcotic_register" USING btree ("ward_id","recorded_at");--> statement-breakpoint
ALTER TABLE "ipd_emar_narcotic_register" ADD CONSTRAINT "ipd_emar_narcotic_kind_ck" CHECK ("ipd_emar_narcotic_register"."kind" in ('received', 'given', 'wasted', 'returned', 'reversal', 'transfer_out', 'transfer_in'));--> statement-breakpoint
CREATE TRIGGER ipd_narcotic_counts_append_only BEFORE UPDATE OR DELETE ON ipd_narcotic_counts FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_narcotic_count_resolutions_append_only BEFORE UPDATE OR DELETE ON ipd_narcotic_count_resolutions FOR EACH ROW EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_narcotic_counts_no_truncate BEFORE TRUNCATE ON ipd_narcotic_counts FOR EACH STATEMENT EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ipd_narcotic_count_resolutions_no_truncate BEFORE TRUNCATE ON ipd_narcotic_count_resolutions FOR EACH STATEMENT EXECUTE FUNCTION ipd_emar_forbid_mutation();
--> statement-breakpoint
ALTER TABLE ipd_narcotic_counts ENABLE ALWAYS TRIGGER ipd_narcotic_counts_append_only;
--> statement-breakpoint
ALTER TABLE ipd_narcotic_count_resolutions ENABLE ALWAYS TRIGGER ipd_narcotic_count_resolutions_append_only;
--> statement-breakpoint
ALTER TABLE ipd_narcotic_counts ENABLE ALWAYS TRIGGER ipd_narcotic_counts_no_truncate;
--> statement-breakpoint
ALTER TABLE ipd_narcotic_count_resolutions ENABLE ALWAYS TRIGGER ipd_narcotic_count_resolutions_no_truncate;
