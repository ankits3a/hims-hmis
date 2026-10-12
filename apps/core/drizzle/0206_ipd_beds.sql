CREATE TABLE "ipd_bed_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"bed_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"note" text NOT NULL,
	"expected_return_at" timestamp with time zone NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	"ended_by" text,
	"ended_at" timestamp with time zone,
	"end_note" text,
	CONSTRAINT "ipd_bed_blocks_status_ck" CHECK ("ipd_bed_blocks"."status" in ('pending_release', 'active', 'ended', 'cancelled')),
	CONSTRAINT "ipd_bed_blocks_reason_ck" CHECK ("ipd_bed_blocks"."reason" in ('maintenance', 'infection_control', 'deep_clean', 'staff_shortage', 'other'))
);
--> statement-breakpoint
CREATE TABLE "ipd_bed_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"bed_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"status" text NOT NULL,
	"reserved_by" text NOT NULL,
	"reserved_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_by" text,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "ipd_bed_reservations_status_ck" CHECK ("ipd_bed_reservations"."status" in ('active', 'released', 'lapsed', 'consumed'))
);
--> statement-breakpoint
CREATE TABLE "ipd_bed_stays" (
	"id" text PRIMARY KEY NOT NULL,
	"bed_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"bed_class" text NOT NULL,
	"billed_class" text NOT NULL,
	"protected_until" timestamp with time zone,
	"class_change" text,
	"started_by" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_by" text,
	"ended_at" timestamp with time zone,
	CONSTRAINT "ipd_bed_stays_class_change_ck" CHECK ("ipd_bed_stays"."class_change" is null or "ipd_bed_stays"."class_change" in ('upgrade', 'downgrade'))
);
--> statement-breakpoint
ALTER TABLE "ipd_bed_blocks" ADD CONSTRAINT "ipd_bed_blocks_bed_id_resources_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_bed_reservations" ADD CONSTRAINT "ipd_bed_reservations_bed_id_resources_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_bed_stays" ADD CONSTRAINT "ipd_bed_stays_bed_id_resources_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_bed_blocks_live_bed_ux" ON "ipd_bed_blocks" USING btree ("bed_id") WHERE "ipd_bed_blocks"."status" in ('pending_release', 'active');--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_bed_reservations_live_bed_ux" ON "ipd_bed_reservations" USING btree ("bed_id") WHERE "ipd_bed_reservations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "ipd_bed_reservations_due_idx" ON "ipd_bed_reservations" USING btree ("expires_at") WHERE "ipd_bed_reservations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "ipd_bed_reservations_admission_idx" ON "ipd_bed_reservations" USING btree ("admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_bed_stays_open_bed_ux" ON "ipd_bed_stays" USING btree ("bed_id") WHERE "ipd_bed_stays"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_bed_stays_open_admission_ux" ON "ipd_bed_stays" USING btree ("admission_id") WHERE "ipd_bed_stays"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "ipd_bed_stays_patient_idx" ON "ipd_bed_stays" USING btree ("patient_id");