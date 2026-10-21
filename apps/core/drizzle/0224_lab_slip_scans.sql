CREATE TABLE "lab_slip_ignored_codes" (
	"instrument_id" text NOT NULL,
	"code" text NOT NULL,
	"reason" text NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lab_slip_ignored_codes_instrument_id_code_pk" PRIMARY KEY("instrument_id","code"),
	CONSTRAINT "lab_slip_ignored_codes_reason_ck" CHECK (btrim("lab_slip_ignored_codes"."reason") <> '')
);
--> statement-breakpoint
CREATE TABLE "lab_slip_scans" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"image_purged_at" timestamp with time zone,
	"source" text NOT NULL,
	"photo_taken_at" timestamp with time zone,
	"captured_by" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"read_started_at" timestamp with time zone,
	"instrument_id" text NOT NULL,
	"provider" text,
	"model" text,
	"prompt_version" text,
	"latency_ms" integer,
	"tokens_in" integer,
	"tokens_out" integer,
	"raw_reply" jsonb,
	"identity" jsonb,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_report_id" text,
	"quick_report_id" text,
	"match_kind" text,
	"matched_by" text,
	"matched_at" timestamp with time zone,
	"confirm_note" text,
	"discard_reason" text,
	"discarded_by" text,
	"discarded_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "lab_slip_scans_status_ck" CHECK ("lab_slip_scans"."status" in ('reading', 'read', 'failed', 'waiting', 'attached', 'discarded')),
	CONSTRAINT "lab_slip_scans_source_ck" CHECK ("lab_slip_scans"."source" in ('camera', 'gallery')),
	CONSTRAINT "lab_slip_scans_attached_ck" CHECK (("lab_slip_scans"."status" = 'attached') = ("lab_slip_scans"."quick_report_id" is not null and "lab_slip_scans"."match_kind" is not null and "lab_slip_scans"."matched_by" is not null and "lab_slip_scans"."matched_at" is not null)),
	CONSTRAINT "lab_slip_scans_discarded_ck" CHECK (("lab_slip_scans"."status" = 'discarded') = ("lab_slip_scans"."discard_reason" is not null and btrim("lab_slip_scans"."discard_reason") <> '' and "lab_slip_scans"."discarded_by" is not null and "lab_slip_scans"."discarded_at" is not null)),
	CONSTRAINT "lab_slip_scans_match_kind_ck" CHECK ("lab_slip_scans"."match_kind" is null or "lab_slip_scans"."match_kind" in ('sample_no', 'uhid', 'staff_pick', 'from_report'))
);
--> statement-breakpoint
ALTER TABLE "lab_slip_ignored_codes" ADD CONSTRAINT "lab_slip_ignored_codes_instrument_id_lab_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."lab_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_slip_scans" ADD CONSTRAINT "lab_slip_scans_instrument_id_lab_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."lab_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_slip_scans" ADD CONSTRAINT "lab_slip_scans_requested_report_id_lab_quick_reports_id_fk" FOREIGN KEY ("requested_report_id") REFERENCES "public"."lab_quick_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_slip_scans" ADD CONSTRAINT "lab_slip_scans_quick_report_id_lab_quick_reports_id_fk" FOREIGN KEY ("quick_report_id") REFERENCES "public"."lab_quick_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_slip_scans_status_idx" ON "lab_slip_scans" USING btree ("status","captured_at");--> statement-breakpoint
CREATE INDEX "lab_slip_scans_sha256_idx" ON "lab_slip_scans" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "lab_slip_scans_report_idx" ON "lab_slip_scans" USING btree ("quick_report_id");