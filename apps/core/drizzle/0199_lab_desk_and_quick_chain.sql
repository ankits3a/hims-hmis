CREATE TABLE "lab_booking_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"open_at" text NOT NULL,
	"close_at" text NOT NULL,
	"slot_minutes" integer NOT NULL,
	"per_slot" integer NOT NULL,
	"days_ahead" integer NOT NULL,
	"closed_weekdays" jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_booking_settings_one_ck" CHECK ("lab_booking_settings"."id" = 'main'),
	CONSTRAINT "lab_booking_settings_hours_ck" CHECK ("lab_booking_settings"."open_at" ~ '^[0-2][0-9]:[0-5][0-9]$' and "lab_booking_settings"."close_at" ~ '^[0-2][0-9]:[0-5][0-9]$' and "lab_booking_settings"."open_at" < "lab_booking_settings"."close_at"),
	CONSTRAINT "lab_booking_settings_numbers_ck" CHECK ("lab_booking_settings"."slot_minutes" between 5 and 120 and "lab_booking_settings"."per_slot" between 1 and 100 and "lab_booking_settings"."days_ahead" between 1 and 365)
);
--> statement-breakpoint
CREATE TABLE "lab_bookings" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"service_date" date NOT NULL,
	"slot_start" text NOT NULL,
	"service_ids" jsonb NOT NULL,
	"note" text,
	"status" text DEFAULT 'booked' NOT NULL,
	"order_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	CONSTRAINT "lab_bookings_status_ck" CHECK ("lab_bookings"."status" in ('booked', 'fulfilled', 'cancelled', 'no_show')),
	CONSTRAINT "lab_bookings_slot_ck" CHECK ("lab_bookings"."slot_start" ~ '^[0-2][0-9]:[0-5][0-9]$'),
	CONSTRAINT "lab_bookings_fulfilled_ck" CHECK (("lab_bookings"."status" = 'fulfilled') = ("lab_bookings"."order_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "lab_quick_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"encounter_no" text,
	"order_id" text,
	"sample_no" text,
	"tests" jsonb NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"collected_by" text NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"reported_at" timestamp with time zone,
	"reported_by" text,
	"handed_over_at" timestamp with time zone,
	"handed_over_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_quick_reports_status_ck" CHECK ("lab_quick_reports"."status" in ('waiting', 'draft', 'reported')),
	CONSTRAINT "lab_quick_reports_reported_ck" CHECK (("lab_quick_reports"."status" = 'reported') = ("lab_quick_reports"."reported_at" is not null and "lab_quick_reports"."reported_by" is not null)),
	CONSTRAINT "lab_quick_reports_handover_ck" CHECK (("lab_quick_reports"."handed_over_at" is null and "lab_quick_reports"."handed_over_by" is null) or ("lab_quick_reports"."status" = 'reported' and "lab_quick_reports"."handed_over_at" is not null and "lab_quick_reports"."handed_over_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "lab_bookings" ADD CONSTRAINT "lab_bookings_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_bookings" ADD CONSTRAINT "lab_bookings_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_quick_reports" ADD CONSTRAINT "lab_quick_reports_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_quick_reports" ADD CONSTRAINT "lab_quick_reports_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_bookings_day_slot_idx" ON "lab_bookings" USING btree ("service_date","slot_start");--> statement-breakpoint
CREATE INDEX "lab_bookings_patient_idx" ON "lab_bookings" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "lab_quick_reports_status_idx" ON "lab_quick_reports" USING btree ("status","collected_at");--> statement-breakpoint
CREATE INDEX "lab_quick_reports_patient_idx" ON "lab_quick_reports" USING btree ("patient_id","collected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_quick_reports_order_ux" ON "lab_quick_reports" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_quick_reports_sample_ux" ON "lab_quick_reports" USING btree ("sample_no");