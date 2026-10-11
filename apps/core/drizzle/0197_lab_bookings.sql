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
ALTER TABLE "lab_bookings" ADD CONSTRAINT "lab_bookings_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_bookings" ADD CONSTRAINT "lab_bookings_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_bookings_day_slot_idx" ON "lab_bookings" USING btree ("service_date","slot_start");--> statement-breakpoint
CREATE INDEX "lab_bookings_patient_idx" ON "lab_bookings" USING btree ("patient_id");