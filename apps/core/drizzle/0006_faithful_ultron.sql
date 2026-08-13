CREATE SEQUENCE "public"."uhid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "patient_allergies" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"substance" text NOT NULL,
	"reaction" text,
	"severity" text,
	"source" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"corrected_by" text,
	"corrected_at" timestamp with time zone,
	"correction_reason" text
);
--> statement-breakpoint
CREATE TABLE "patient_guardians" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"relationship" text NOT NULL,
	"id_type" text,
	"id_number_masked" text,
	"id_verified" boolean DEFAULT false NOT NULL,
	"authority_messages" boolean DEFAULT true NOT NULL,
	"authority_consents" boolean DEFAULT true NOT NULL,
	"authority_dsr" boolean DEFAULT false NOT NULL,
	"authority_bills" boolean DEFAULT true NOT NULL,
	"consent_note" text,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_by" text,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "patient_merge_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"winner_id" text NOT NULL,
	"loser_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"unmerge_approval_id" text,
	"request_note" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"moved_rows" jsonb,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_by" text,
	"executed_at" timestamp with time zone,
	"unmerged_by" text,
	"unmerged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "patient_photos" (
	"patient_id" text PRIMARY KEY NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" text PRIMARY KEY NOT NULL,
	"uhid" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"alt_phone" text,
	"dob" date,
	"dob_estimated" boolean DEFAULT false NOT NULL,
	"sex" text NOT NULL,
	"address_line" text,
	"district" text,
	"state_name" text,
	"pincode" text,
	"language" text DEFAULT 'hi' NOT NULL,
	"blood_group" text,
	"is_confidential" boolean DEFAULT false NOT NULL,
	"alias" text,
	"sensitive_context" boolean DEFAULT false NOT NULL,
	"abha_address" text,
	"abha_number" text,
	"abha_verification_status" text DEFAULT 'none' NOT NULL,
	"abha_link_token" text,
	"legacy_uhid" text,
	"qr_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"merged_into_patient_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registration_config" (
	"id" text PRIMARY KEY NOT NULL,
	"uhid_prefix" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patient_allergies" ADD CONSTRAINT "patient_allergies_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_guardians" ADD CONSTRAINT "patient_guardians_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_requests" ADD CONSTRAINT "patient_merge_requests_winner_id_patients_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merge_requests" ADD CONSTRAINT "patient_merge_requests_loser_id_patients_id_fk" FOREIGN KEY ("loser_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_photos" ADD CONSTRAINT "patient_photos_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_allergies_patient_idx" ON "patient_allergies" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "patient_guardians_patient_idx" ON "patient_guardians" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_merge_requests_pending_loser_ux" ON "patient_merge_requests" USING btree ("loser_id") WHERE "patient_merge_requests"."status" = 'requested';--> statement-breakpoint
CREATE INDEX "patient_merge_requests_winner_idx" ON "patient_merge_requests" USING btree ("winner_id");--> statement-breakpoint
CREATE INDEX "patient_merge_requests_loser_idx" ON "patient_merge_requests" USING btree ("loser_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_uhid_ux" ON "patients" USING btree ("uhid");--> statement-breakpoint
CREATE INDEX "patients_phone_idx" ON "patients" USING btree ("phone" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "patients_alt_phone_idx" ON "patients" USING btree ("alt_phone" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "patients_name_idx" ON "patients" USING btree (lower("name") text_pattern_ops);