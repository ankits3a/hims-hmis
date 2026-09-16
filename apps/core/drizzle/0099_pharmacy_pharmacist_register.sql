-- ═══ PHARMACY P2: THE REGISTER OF PHARMACISTS ═══
--
-- Phase doc: docs/superpowers/plans/2026-09-16-phase-pharmacy-p2-pharmacist-register.md.
-- The Pharmacy Act 1948 s.42 reserves dispensing to a registered pharmacist; this table holds who
-- has a current state council registration. A row is never edited: a renewal ends the old row and a
-- mistake is ended with a reason. Two partial unique indexes keep one current row per person and
-- per council number; the checks refuse a self-filed row and a half-ended one.
--
-- `pharmacy_reg_h1.pharmacist_reg_no` records the handing-over pharmacist's number on the statutory
-- register. Additive and nullable: rows written before this migration have no number to backfill.
CREATE TABLE "pharmacy_pharmacist_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"council" text NOT NULL,
	"registration_no" text NOT NULL,
	"valid_until" date,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" text,
	"end_reason" text,
	CONSTRAINT "pharmacy_pharmacist_reg_ended_ck" CHECK (("pharmacy_pharmacist_registrations"."ended_at" is null) = ("pharmacy_pharmacist_registrations"."ended_by" is null) and ("pharmacy_pharmacist_registrations"."ended_at" is null) = ("pharmacy_pharmacist_registrations"."end_reason" is null)),
	CONSTRAINT "pharmacy_pharmacist_reg_not_self_ck" CHECK ("pharmacy_pharmacist_registrations"."recorded_by" <> "pharmacy_pharmacist_registrations"."user_id"),
	CONSTRAINT "pharmacy_pharmacist_reg_text_ck" CHECK (btrim("pharmacy_pharmacist_registrations"."council") <> '' and btrim("pharmacy_pharmacist_registrations"."registration_no") <> '')
);
--> statement-breakpoint
ALTER TABLE "pharmacy_reg_h1" ADD COLUMN "pharmacist_reg_no" text;--> statement-breakpoint
ALTER TABLE "pharmacy_pharmacist_registrations" ADD CONSTRAINT "pharmacy_pharmacist_registrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_pharmacist_registrations" ADD CONSTRAINT "pharmacy_pharmacist_registrations_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_pharmacist_registrations" ADD CONSTRAINT "pharmacy_pharmacist_registrations_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_pharmacist_reg_current_user_ux" ON "pharmacy_pharmacist_registrations" USING btree ("user_id") WHERE "pharmacy_pharmacist_registrations"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_pharmacist_reg_current_no_ux" ON "pharmacy_pharmacist_registrations" USING btree (lower("council"),lower("registration_no")) WHERE "pharmacy_pharmacist_registrations"."ended_at" is null;