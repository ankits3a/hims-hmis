-- HK-2 housekeeping (#974, decision 0086): a floor's housekeeping store, and the random inspections of C and D areas. Additive.
CREATE TABLE "hk_floor_stores" (
	"floor_id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hk_inspections" (
	"id" text PRIMARY KEY NOT NULL,
	"area_id" text NOT NULL,
	"floor_id" text NOT NULL,
	"shift_starts_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'due' NOT NULL,
	"answers" jsonb,
	"score_pct" integer,
	"photo_key" text,
	"qr_version" integer,
	"inspected_by" text,
	"inspected_at" timestamp with time zone,
	"company" text,
	"contractor_id" text,
	"rework_task_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hk_inspections_status_ck" CHECK ("hk_inspections"."status" in ('due', 'passed', 'failed')),
	CONSTRAINT "hk_inspections_scored_ck" CHECK (("hk_inspections"."status" = 'due') = ("hk_inspections"."inspected_at" is null) and ("hk_inspections"."status" = 'due') = ("hk_inspections"."score_pct" is null)),
	CONSTRAINT "hk_inspections_score_ck" CHECK ("hk_inspections"."score_pct" is null or ("hk_inspections"."score_pct" >= 0 and "hk_inspections"."score_pct" <= 100))
);
--> statement-breakpoint
ALTER TABLE "hk_floor_stores" ADD CONSTRAINT "hk_floor_stores_floor_id_resources_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_floor_stores" ADD CONSTRAINT "hk_floor_stores_store_id_resources_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_inspections" ADD CONSTRAINT "hk_inspections_area_id_hk_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."hk_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_inspections" ADD CONSTRAINT "hk_inspections_floor_id_resources_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_inspections" ADD CONSTRAINT "hk_inspections_contractor_id_hk_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."hk_contractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_inspections" ADD CONSTRAINT "hk_inspections_rework_task_id_tasks_id_fk" FOREIGN KEY ("rework_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hk_floor_stores_store_ux" ON "hk_floor_stores" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hk_inspections_area_shift_ux" ON "hk_inspections" USING btree ("area_id","shift_starts_at");--> statement-breakpoint
CREATE INDEX "hk_inspections_floor_shift_idx" ON "hk_inspections" USING btree ("floor_id","shift_starts_at");--> statement-breakpoint
CREATE INDEX "hk_inspections_inspected_idx" ON "hk_inspections" USING btree ("inspected_at");