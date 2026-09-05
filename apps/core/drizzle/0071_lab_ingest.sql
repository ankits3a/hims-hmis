CREATE TABLE "lab_parked_results" (
	"id" text PRIMARY KEY NOT NULL,
	"transmission_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"position" integer NOT NULL,
	"sample_id" text,
	"instrument_code" text NOT NULL,
	"raw_value" text NOT NULL,
	"raw_unit" text,
	"instrument_at" timestamp with time zone,
	"reason" text NOT NULL,
	"status" text DEFAULT 'parked' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"discard_reason" text,
	CONSTRAINT "lab_parked_results_reason_ck" CHECK ("lab_parked_results"."reason" in ('unmapped_code', 'unknown_sample', 'no_open_item', 'sample_not_received', 'no_run_sheet', 'no_plate_well', 'guard_refused')),
	CONSTRAINT "lab_parked_results_status_ck" CHECK ("lab_parked_results"."status" in ('parked', 'matched', 'discarded')),
	CONSTRAINT "lab_parked_results_discard_ck" CHECK (("lab_parked_results"."status" = 'discarded') = ("lab_parked_results"."discard_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "lab_transmissions" (
	"id" text PRIMARY KEY NOT NULL,
	"instrument_id" text NOT NULL,
	"transmission_ref" text NOT NULL,
	"arrived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_count" integer NOT NULL,
	"received_by_type" text NOT NULL,
	"received_by_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lab_parked_results" ADD CONSTRAINT "lab_parked_results_transmission_id_lab_transmissions_id_fk" FOREIGN KEY ("transmission_id") REFERENCES "public"."lab_transmissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_parked_results" ADD CONSTRAINT "lab_parked_results_instrument_id_lab_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."lab_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_transmissions" ADD CONSTRAINT "lab_transmissions_instrument_id_lab_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."lab_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_parked_results_status_idx" ON "lab_parked_results" USING btree ("status","instrument_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_parked_results_transmission_position_ux" ON "lab_parked_results" USING btree ("transmission_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_transmissions_instrument_ref_ux" ON "lab_transmissions" USING btree ("instrument_id","transmission_ref");--> statement-breakpoint
CREATE INDEX "lab_transmissions_instrument_arrived_idx" ON "lab_transmissions" USING btree ("instrument_id","arrived_at");