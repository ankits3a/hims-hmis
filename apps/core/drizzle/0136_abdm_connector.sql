CREATE TABLE "abdm_care_contexts" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"encounter_id" text NOT NULL,
	"hip_id" text NOT NULL,
	"reference_number" text NOT NULL,
	"patient_reference" text NOT NULL,
	"display" text NOT NULL,
	"hi_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"abha_address" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"linked_via" text,
	"link_request_id" text,
	"linked_at" timestamp with time zone,
	"last_error" text,
	"notified_hi_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"notified_at" timestamp with time zone,
	"notify_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "abdm_care_contexts_status_ck" CHECK ("abdm_care_contexts"."status" in ('pending', 'linking', 'linked', 'failed')),
	CONSTRAINT "abdm_care_contexts_via_ck" CHECK ("abdm_care_contexts"."linked_via" is null or "abdm_care_contexts"."linked_via" in ('hip', 'patient')),
	CONSTRAINT "abdm_care_contexts_linked_ck" CHECK (("abdm_care_contexts"."status" = 'linked') = ("abdm_care_contexts"."linked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "abdm_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"consent_id" text NOT NULL,
	"hip_id" text NOT NULL,
	"status" text NOT NULL,
	"patient_abha_address" text,
	"patient_id" text,
	"hiu_id" text,
	"purpose_code" text,
	"hi_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"care_contexts" jsonb NOT NULL,
	"date_from" timestamp with time zone,
	"date_to" timestamp with time zone,
	"data_erase_at" timestamp with time zone,
	"access_mode" text,
	"artefact" jsonb,
	"signature" text,
	"message_id" text NOT NULL,
	"granted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "abdm_consents_status_ck" CHECK ("abdm_consents"."status" in ('GRANTED', 'REVOKED', 'EXPIRED', 'DENIED'))
);
--> statement-breakpoint
CREATE TABLE "abdm_external_records" (
	"id" text PRIMARY KEY NOT NULL,
	"data_request_id" text NOT NULL,
	"artefact_id" text NOT NULL,
	"consent_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"care_context_reference" text NOT NULL,
	"hip_id" text NOT NULL,
	"hip_name" text,
	"hi_type" text NOT NULL,
	"record_date" timestamp with time zone,
	"title" text,
	"checksum" text NOT NULL,
	"checksum_verified" boolean NOT NULL,
	"bundle" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abdm_health_info_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"consent_id" text NOT NULL,
	"hip_id" text NOT NULL,
	"patient_id" text,
	"message_id" text NOT NULL,
	"requested_from" timestamp with time zone,
	"requested_to" timestamp with time zone,
	"data_push_url" text,
	"status" text NOT NULL,
	"refusal" text,
	"released" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"pushed_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "abdm_hi_requests_status_ck" CHECK ("abdm_health_info_requests"."status" in ('refused', 'held', 'transferring', 'transferred', 'failed')),
	CONSTRAINT "abdm_hi_requests_refused_ck" CHECK (("abdm_health_info_requests"."status" = 'refused') = ("abdm_health_info_requests"."refusal" is not null))
);
--> statement-breakpoint
CREATE TABLE "abdm_hiu_consent_artefacts" (
	"id" text PRIMARY KEY NOT NULL,
	"hiu_request_id" text NOT NULL,
	"consent_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"status" text NOT NULL,
	"fetch_request_id" text,
	"fetched_at" timestamp with time zone,
	"hip_id" text,
	"hip_name" text,
	"care_contexts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hi_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"date_from" timestamp with time zone,
	"date_to" timestamp with time zone,
	"data_erase_at" timestamp with time zone,
	"access_mode" text,
	"artefact" jsonb,
	"signature" text,
	"erased_at" timestamp with time zone,
	"erased_count" integer DEFAULT 0 NOT NULL,
	"erase_reason" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "abdm_hiu_artefacts_status_ck" CHECK ("abdm_hiu_consent_artefacts"."status" in ('GRANTED', 'REVOKED', 'EXPIRED'))
);
--> statement-breakpoint
CREATE TABLE "abdm_hiu_consent_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"encounter_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"requester_name" text NOT NULL,
	"requester_reg_no" text,
	"hiu_id" text NOT NULL,
	"abha_address" text NOT NULL,
	"purpose_code" text NOT NULL,
	"hi_types" text[] NOT NULL,
	"date_from" timestamp with time zone NOT NULL,
	"date_to" timestamp with time zone NOT NULL,
	"data_erase_at" timestamp with time zone NOT NULL,
	"request_id" text NOT NULL,
	"consent_request_id" text,
	"status" text NOT NULL,
	"error" text,
	"status_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "abdm_hiu_consent_requests_status_ck" CHECK ("abdm_hiu_consent_requests"."status" in ('requested', 'awaiting_patient', 'granted', 'denied', 'expired', 'revoked', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "abdm_hiu_data_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"artefact_id" text NOT NULL,
	"consent_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"request_id" text NOT NULL,
	"transaction_id" text,
	"push_token_hash" text NOT NULL,
	"public_key" text NOT NULL,
	"nonce" text NOT NULL,
	"private_key_sealed" text,
	"key_expires_at" timestamp with time zone NOT NULL,
	"date_from" timestamp with time zone NOT NULL,
	"date_to" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"page_count" integer,
	"pages_received" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "abdm_hiu_data_requests_status_ck" CHECK ("abdm_hiu_data_requests"."status" in ('requested', 'acknowledged', 'receiving', 'received', 'failed', 'erased')),
	CONSTRAINT "abdm_hiu_data_requests_key_ck" CHECK ("abdm_hiu_data_requests"."status" in ('requested', 'acknowledged', 'receiving') or "abdm_hiu_data_requests"."private_key_sealed" is null)
);
--> statement-breakpoint
CREATE TABLE "abdm_link_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"link_ref_number" text NOT NULL,
	"transaction_id" text NOT NULL,
	"request_id" text NOT NULL,
	"hip_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"abha_address" text NOT NULL,
	"care_contexts" jsonb NOT NULL,
	"otp_hash" text,
	"otp_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "abdm_link_requests_status_ck" CHECK ("abdm_link_requests"."status" in ('otp_sent', 'otp_unsent', 'linked', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "abdm_link_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"hip_id" text NOT NULL,
	"abha_address" text NOT NULL,
	"patient_id" text NOT NULL,
	"request_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"token_sealed" text,
	"abha_number" text,
	"expires_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_at" timestamp with time zone,
	CONSTRAINT "abdm_link_tokens_status_ck" CHECK ("abdm_link_tokens"."status" in ('pending', 'received', 'failed')),
	CONSTRAINT "abdm_link_tokens_received_ck" CHECK (("abdm_link_tokens"."status" = 'received') = ("abdm_link_tokens"."token_sealed" is not null))
);
--> statement-breakpoint
CREATE TABLE "abdm_profile_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"message_id" text NOT NULL,
	"hip_id" text NOT NULL,
	"counter_id" text,
	"intent" text NOT NULL,
	"abha_number" text,
	"abha_address" text NOT NULL,
	"profile" jsonb NOT NULL,
	"token_date" date NOT NULL,
	"token_number" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ack_status" text,
	"ack_error" text,
	"patient_id" text,
	"linked_by" text,
	"linked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "abdm_profile_shares_status_ck" CHECK ("abdm_profile_shares"."status" in ('pending', 'linked', 'dismissed')),
	CONSTRAINT "abdm_profile_shares_ack_ck" CHECK ("abdm_profile_shares"."ack_status" is null or "abdm_profile_shares"."ack_status" in ('sent', 'failed')),
	CONSTRAINT "abdm_profile_shares_linked_ck" CHECK (("abdm_profile_shares"."status" = 'linked') = ("abdm_profile_shares"."patient_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "abdm_messages" ADD COLUMN "actor_id" text;--> statement-breakpoint
ALTER TABLE "abdm_care_contexts" ADD CONSTRAINT "abdm_care_contexts_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_care_contexts" ADD CONSTRAINT "abdm_care_contexts_encounter_id_opd_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."opd_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_consents" ADD CONSTRAINT "abdm_consents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_consents" ADD CONSTRAINT "abdm_consents_message_id_abdm_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."abdm_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_external_records" ADD CONSTRAINT "abdm_external_records_data_request_id_abdm_hiu_data_requests_id_fk" FOREIGN KEY ("data_request_id") REFERENCES "public"."abdm_hiu_data_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_external_records" ADD CONSTRAINT "abdm_external_records_artefact_id_abdm_hiu_consent_artefacts_id_fk" FOREIGN KEY ("artefact_id") REFERENCES "public"."abdm_hiu_consent_artefacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_external_records" ADD CONSTRAINT "abdm_external_records_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_health_info_requests" ADD CONSTRAINT "abdm_health_info_requests_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_health_info_requests" ADD CONSTRAINT "abdm_health_info_requests_message_id_abdm_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."abdm_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_hiu_consent_artefacts" ADD CONSTRAINT "abdm_hiu_consent_artefacts_hiu_request_id_abdm_hiu_consent_requests_id_fk" FOREIGN KEY ("hiu_request_id") REFERENCES "public"."abdm_hiu_consent_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_hiu_consent_artefacts" ADD CONSTRAINT "abdm_hiu_consent_artefacts_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_hiu_consent_requests" ADD CONSTRAINT "abdm_hiu_consent_requests_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_hiu_consent_requests" ADD CONSTRAINT "abdm_hiu_consent_requests_encounter_id_opd_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."opd_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_hiu_data_requests" ADD CONSTRAINT "abdm_hiu_data_requests_artefact_id_abdm_hiu_consent_artefacts_id_fk" FOREIGN KEY ("artefact_id") REFERENCES "public"."abdm_hiu_consent_artefacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_hiu_data_requests" ADD CONSTRAINT "abdm_hiu_data_requests_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_link_requests" ADD CONSTRAINT "abdm_link_requests_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_link_tokens" ADD CONSTRAINT "abdm_link_tokens_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_profile_shares" ADD CONSTRAINT "abdm_profile_shares_message_id_abdm_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."abdm_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abdm_profile_shares" ADD CONSTRAINT "abdm_profile_shares_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_care_contexts_encounter_ux" ON "abdm_care_contexts" USING btree ("encounter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_care_contexts_reference_ux" ON "abdm_care_contexts" USING btree ("hip_id","reference_number");--> statement-breakpoint
CREATE INDEX "abdm_care_contexts_patient_idx" ON "abdm_care_contexts" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "abdm_care_contexts_link_request_idx" ON "abdm_care_contexts" USING btree ("link_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_consents_consent_ux" ON "abdm_consents" USING btree ("consent_id");--> statement-breakpoint
CREATE INDEX "abdm_consents_patient_idx" ON "abdm_consents" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_external_records_entry_ux" ON "abdm_external_records" USING btree ("consent_id","care_context_reference","checksum");--> statement-breakpoint
CREATE INDEX "abdm_external_records_patient_idx" ON "abdm_external_records" USING btree ("patient_id","record_date");--> statement-breakpoint
CREATE INDEX "abdm_external_records_artefact_idx" ON "abdm_external_records" USING btree ("artefact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_hi_requests_transaction_ux" ON "abdm_health_info_requests" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "abdm_hi_requests_consent_idx" ON "abdm_health_info_requests" USING btree ("consent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_hiu_artefacts_consent_ux" ON "abdm_hiu_consent_artefacts" USING btree ("consent_id");--> statement-breakpoint
CREATE INDEX "abdm_hiu_artefacts_request_idx" ON "abdm_hiu_consent_artefacts" USING btree ("hiu_request_id");--> statement-breakpoint
CREATE INDEX "abdm_hiu_artefacts_patient_idx" ON "abdm_hiu_consent_artefacts" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "abdm_hiu_artefacts_erase_idx" ON "abdm_hiu_consent_artefacts" USING btree ("status","data_erase_at");--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_hiu_consent_requests_request_ux" ON "abdm_hiu_consent_requests" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_hiu_consent_requests_cr_ux" ON "abdm_hiu_consent_requests" USING btree ("consent_request_id") WHERE "abdm_hiu_consent_requests"."consent_request_id" is not null;--> statement-breakpoint
CREATE INDEX "abdm_hiu_consent_requests_patient_idx" ON "abdm_hiu_consent_requests" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_hiu_data_requests_request_ux" ON "abdm_hiu_data_requests" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_hiu_data_requests_txn_ux" ON "abdm_hiu_data_requests" USING btree ("transaction_id") WHERE "abdm_hiu_data_requests"."transaction_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_hiu_data_requests_token_ux" ON "abdm_hiu_data_requests" USING btree ("push_token_hash");--> statement-breakpoint
CREATE INDEX "abdm_hiu_data_requests_artefact_idx" ON "abdm_hiu_data_requests" USING btree ("artefact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_link_requests_ref_ux" ON "abdm_link_requests" USING btree ("link_ref_number");--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_link_requests_request_ux" ON "abdm_link_requests" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "abdm_link_requests_patient_idx" ON "abdm_link_requests" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_link_tokens_request_ux" ON "abdm_link_tokens" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "abdm_link_tokens_address_idx" ON "abdm_link_tokens" USING btree ("hip_id","abha_address","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_profile_shares_request_ux" ON "abdm_profile_shares" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_profile_shares_token_ux" ON "abdm_profile_shares" USING btree ("hip_id","token_date","token_number");--> statement-breakpoint
CREATE INDEX "abdm_profile_shares_status_idx" ON "abdm_profile_shares" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "abdm_profile_shares_address_idx" ON "abdm_profile_shares" USING btree ("hip_id","abha_address");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_abha_number_ux" ON "patients" USING btree (regexp_replace("abha_number", '[^0-9]', '', 'g')) WHERE "patients"."abha_number" is not null and regexp_replace("patients"."abha_number", '[^0-9]', '', 'g') <> '' and "patients"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "patients_abha_address_ux" ON "patients" USING btree (lower(btrim("abha_address"))) WHERE "patients"."abha_address" is not null and btrim("patients"."abha_address") <> '' and "patients"."status" = 'active';