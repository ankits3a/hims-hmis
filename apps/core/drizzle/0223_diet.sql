CREATE TABLE "diet_consults" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"reason" text NOT NULL,
	"state" text NOT NULL,
	"source" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "diet_consults_state_ck" CHECK ("diet_consults"."state" in ('open', 'done', 'cancelled')),
	CONSTRAINT "diet_consults_source_ck" CHECK ("diet_consults"."source" in ('doctor', 'dietician', 'nurse', 'ot_booking', 'system'))
);
--> statement-breakpoint
CREATE TABLE "diet_meal_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"list_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"bed_id" text,
	"bed_code" text,
	"code" text NOT NULL,
	"preference" text NOT NULL,
	"tube" text,
	"defaulted" boolean DEFAULT false NOT NULL,
	"late" boolean DEFAULT false NOT NULL,
	"state" text NOT NULL,
	"withdrawn_reason" text,
	"withdrawn_at" timestamp with time zone,
	"served" text,
	"served_at" timestamp with time zone,
	"served_by" text,
	"changed_at" timestamp with time zone,
	"on_load" boolean DEFAULT false NOT NULL,
	"tray_task_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "diet_meal_lines_state_ck" CHECK ("diet_meal_lines"."state" in ('active', 'withdrawn')),
	CONSTRAINT "diet_meal_lines_withdrawn_ck" CHECK (("diet_meal_lines"."state" = 'withdrawn') = ("diet_meal_lines"."withdrawn_reason" is not null)),
	CONSTRAINT "diet_meal_lines_reason_ck" CHECK ("diet_meal_lines"."withdrawn_reason" is null or "diet_meal_lines"."withdrawn_reason" in ('npo', 'transferred', 'discharged', 'deceased', 'lama', 'absconded', 'transferred_out')),
	CONSTRAINT "diet_meal_lines_served_ck" CHECK ("diet_meal_lines"."served" is null or "diet_meal_lines"."served" in ('delivered', 'refused'))
);
--> statement-breakpoint
CREATE TABLE "diet_meal_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"ward_id" text NOT NULL,
	"meal" text NOT NULL,
	"service_date" text NOT NULL,
	"serve_at" timestamp with time zone NOT NULL,
	"built_at" timestamp with time zone NOT NULL,
	"built_by" text NOT NULL,
	"printed_at" timestamp with time zone,
	"printed_by" text,
	"last_printed_at" timestamp with time zone,
	"changed_since_print" boolean DEFAULT false NOT NULL,
	"dispatched_at" timestamp with time zone,
	"dispatched_by" text,
	"delivery_task_id" text,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "diet_meal_lists_meal_ck" CHECK ("diet_meal_lists"."meal" in ('breakfast', 'lunch', 'evening', 'dinner'))
);
--> statement-breakpoint
CREATE TABLE "diet_meal_rounds" (
	"meal" text PRIMARY KEY NOT NULL,
	"cutoff_minute" integer NOT NULL,
	"serve_minute" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "diet_meal_rounds_meal_ck" CHECK ("diet_meal_rounds"."meal" in ('breakfast', 'lunch', 'evening', 'dinner')),
	CONSTRAINT "diet_meal_rounds_times_ck" CHECK ("diet_meal_rounds"."cutoff_minute" >= 0 and "diet_meal_rounds"."serve_minute" < 1440 and "diet_meal_rounds"."cutoff_minute" < "diet_meal_rounds"."serve_minute")
);
--> statement-breakpoint
CREATE TABLE "diet_npo" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"admission_id" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" text,
	"lift_reason" text,
	CONSTRAINT "diet_npo_source_ck" CHECK ("diet_npo"."source" in ('doctor', 'dietician', 'nurse', 'ot_booking', 'system')),
	CONSTRAINT "diet_npo_window_ck" CHECK ("diet_npo"."ends_at" is null or "diet_npo"."ends_at" > "diet_npo"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "diet_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"code" text NOT NULL,
	"preference" text NOT NULL,
	"tube_volume_ml" integer,
	"tube_every_hours" integer,
	"note" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	"source" text NOT NULL,
	"ordered_by" text NOT NULL,
	CONSTRAINT "diet_orders_code_ck" CHECK ("diet_orders"."code" in ('normal', 'soft', 'liquid_clear', 'liquid_full', 'diabetic', 'renal', 'cardiac', 'high_protein', 'ryles_feed', 'paediatric', 'npo') and "diet_orders"."code" <> 'npo'),
	CONSTRAINT "diet_orders_preference_ck" CHECK ("diet_orders"."preference" in ('veg', 'non_veg', 'jain')),
	CONSTRAINT "diet_orders_source_ck" CHECK ("diet_orders"."source" in ('doctor', 'dietician', 'nurse', 'ot_booking', 'system')),
	CONSTRAINT "diet_orders_tube_ck" CHECK (("diet_orders"."code" = 'ryles_feed') = ("diet_orders"."tube_volume_ml" is not null and "diet_orders"."tube_every_hours" is not null))
);
--> statement-breakpoint
ALTER TABLE "diet_consults" ADD CONSTRAINT "diet_consults_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diet_meal_lines" ADD CONSTRAINT "diet_meal_lines_list_id_diet_meal_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."diet_meal_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diet_meal_lines" ADD CONSTRAINT "diet_meal_lines_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diet_meal_lists" ADD CONSTRAINT "diet_meal_lists_ward_id_resources_id_fk" FOREIGN KEY ("ward_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diet_npo" ADD CONSTRAINT "diet_npo_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diet_orders" ADD CONSTRAINT "diet_orders_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "diet_consults_open_ux" ON "diet_consults" USING btree ("admission_id") WHERE "diet_consults"."state" = 'open';--> statement-breakpoint
CREATE INDEX "diet_consults_state_idx" ON "diet_consults" USING btree ("state","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "diet_meal_lines_list_admission_ux" ON "diet_meal_lines" USING btree ("list_id","admission_id");--> statement-breakpoint
CREATE INDEX "diet_meal_lines_admission_idx" ON "diet_meal_lines" USING btree ("admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "diet_meal_lists_ward_meal_ux" ON "diet_meal_lists" USING btree ("ward_id","service_date","meal");--> statement-breakpoint
CREATE INDEX "diet_meal_lists_serve_idx" ON "diet_meal_lists" USING btree ("serve_at");--> statement-breakpoint
CREATE UNIQUE INDEX "diet_npo_source_ref_ux" ON "diet_npo" USING btree ("source_ref") WHERE "diet_npo"."source_ref" is not null;--> statement-breakpoint
CREATE INDEX "diet_npo_patient_idx" ON "diet_npo" USING btree ("patient_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "diet_orders_live_ux" ON "diet_orders" USING btree ("admission_id") WHERE "diet_orders"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "diet_orders_admission_idx" ON "diet_orders" USING btree ("admission_id","started_at");--> statement-breakpoint
-- E4.4 DIET — the four meal rounds, IST minutes after midnight (DECIDED defaults; the dietician edits them).
INSERT INTO "diet_meal_rounds" ("meal", "cutoff_minute", "serve_minute", "updated_by", "updated_at") VALUES
  ('breakfast', 360, 450, 'system:migration', now()),
  ('lunch', 630, 750, 'system:migration', now()),
  ('evening', 900, 990, 'system:migration', now()),
  ('dinner', 1050, 1170, 'system:migration', now())
ON CONFLICT ("meal") DO NOTHING;
