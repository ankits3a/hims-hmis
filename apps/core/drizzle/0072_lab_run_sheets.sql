CREATE TABLE "lab_run_sheet_positions" (
	"run_sheet_id" text NOT NULL,
	"position" integer NOT NULL,
	"specimen_id" text NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scanned_by" text NOT NULL,
	CONSTRAINT "lab_run_sheet_positions_run_sheet_id_position_pk" PRIMARY KEY("run_sheet_id","position")
);
--> statement-breakpoint
CREATE TABLE "lab_run_sheets" (
	"id" text PRIMARY KEY NOT NULL,
	"instrument_id" text NOT NULL,
	"run_ref" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_by" text NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_transmission_id" text,
	CONSTRAINT "lab_run_sheets_status_ck" CHECK ("lab_run_sheets"."status" in ('open', 'closed', 'abandoned')),
	CONSTRAINT "lab_run_sheets_closed_ck" CHECK (("lab_run_sheets"."status" = 'open') = ("lab_run_sheets"."closed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "lab_run_sheet_positions" ADD CONSTRAINT "lab_run_sheet_positions_run_sheet_id_lab_run_sheets_id_fk" FOREIGN KEY ("run_sheet_id") REFERENCES "public"."lab_run_sheets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_run_sheet_positions" ADD CONSTRAINT "lab_run_sheet_positions_specimen_id_lab_specimens_id_fk" FOREIGN KEY ("specimen_id") REFERENCES "public"."lab_specimens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_run_sheets" ADD CONSTRAINT "lab_run_sheets_instrument_id_lab_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."lab_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lab_run_sheet_positions_specimen_ux" ON "lab_run_sheet_positions" USING btree ("run_sheet_id","specimen_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_run_sheets_open_ux" ON "lab_run_sheets" USING btree ("instrument_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "lab_run_sheets_instrument_idx" ON "lab_run_sheets" USING btree ("instrument_id","opened_at");