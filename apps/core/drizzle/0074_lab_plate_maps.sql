CREATE TABLE "lab_plate_maps" (
	"id" text PRIMARY KEY NOT NULL,
	"instrument_id" text NOT NULL,
	"plate_ref" text NOT NULL,
	"assay" text NOT NULL,
	"kit_lot" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"cutoff_multiplier" numeric(8, 4) NOT NULL,
	"cutoff_offset" numeric(8, 4) NOT NULL,
	"min_pc_nc_ratio" numeric(8, 4) NOT NULL,
	"max_nc_od" numeric(8, 4) NOT NULL,
	"nc_mean_od" numeric(8, 4),
	"pc_mean_od" numeric(8, 4),
	"cutoff_od" numeric(8, 4),
	"controls_fail_reason" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_by" text NOT NULL,
	"read_at" timestamp with time zone,
	"read_by_transmission_id" text,
	CONSTRAINT "lab_plate_maps_status_ck" CHECK ("lab_plate_maps"."status" in ('open', 'read', 'controls_failed', 'abandoned')),
	CONSTRAINT "lab_plate_maps_failed_reason_ck" CHECK (("lab_plate_maps"."status" = 'controls_failed') = ("lab_plate_maps"."controls_fail_reason" is not null)),
	CONSTRAINT "lab_plate_maps_cutoff_ck" CHECK ("lab_plate_maps"."cutoff_multiplier" > 0 or "lab_plate_maps"."cutoff_offset" > 0)
);
--> statement-breakpoint
CREATE TABLE "lab_plate_wells" (
	"plate_map_id" text NOT NULL,
	"well" text NOT NULL,
	"role" text NOT NULL,
	"specimen_id" text,
	"od" numeric(8, 4),
	"verdict" text,
	"repeat_required" boolean DEFAULT false NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scanned_by" text NOT NULL,
	CONSTRAINT "lab_plate_wells_plate_map_id_well_pk" PRIMARY KEY("plate_map_id","well"),
	CONSTRAINT "lab_plate_wells_role_ck" CHECK ("lab_plate_wells"."role" in ('blank', 'negative_control', 'positive_control', 'cutoff_control', 'patient')),
	CONSTRAINT "lab_plate_wells_specimen_ck" CHECK (("lab_plate_wells"."role" = 'patient') = ("lab_plate_wells"."specimen_id" is not null)),
	CONSTRAINT "lab_plate_wells_verdict_ck" CHECK ("lab_plate_wells"."verdict" is null or "lab_plate_wells"."verdict" in ('non_reactive', 'reactive', 'control_ok', 'control_failed'))
);
--> statement-breakpoint
ALTER TABLE "lab_plate_maps" ADD CONSTRAINT "lab_plate_maps_instrument_id_lab_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."lab_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_plate_wells" ADD CONSTRAINT "lab_plate_wells_plate_map_id_lab_plate_maps_id_fk" FOREIGN KEY ("plate_map_id") REFERENCES "public"."lab_plate_maps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_plate_wells" ADD CONSTRAINT "lab_plate_wells_specimen_id_lab_specimens_id_fk" FOREIGN KEY ("specimen_id") REFERENCES "public"."lab_specimens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lab_plate_maps_open_ux" ON "lab_plate_maps" USING btree ("instrument_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "lab_plate_maps_instrument_idx" ON "lab_plate_maps" USING btree ("instrument_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_plate_wells_specimen_ux" ON "lab_plate_wells" USING btree ("plate_map_id","specimen_id");