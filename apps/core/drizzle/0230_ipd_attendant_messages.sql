CREATE TABLE "ipd_attendant_message_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"attendant_kind" text NOT NULL,
	"attendant_ref" text NOT NULL,
	"consent" jsonb,
	"consented_by" text,
	"consented_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"stopped_by" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_attendant_message_consents_kind_ck" CHECK ("ipd_attendant_message_consents"."attendant_kind" in ('guardian', 'deposit_payer')),
	CONSTRAINT "ipd_attendant_message_consents_stop_ck" CHECK (("ipd_attendant_message_consents"."stopped_at" is null) = ("ipd_attendant_message_consents"."stopped_by" is null)),
	CONSTRAINT "ipd_attendant_message_consents_consent_ck" CHECK (("ipd_attendant_message_consents"."consent" is null) = ("ipd_attendant_message_consents"."consented_at" is null) and ("ipd_attendant_message_consents"."consented_at" is null) = ("ipd_attendant_message_consents"."consented_by" is null)),
	CONSTRAINT "ipd_attendant_message_consents_some_ck" CHECK ("ipd_attendant_message_consents"."consented_at" is not null or "ipd_attendant_message_consents"."stopped_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "ipd_attendant_message_consents" ADD CONSTRAINT "ipd_attendant_message_consents_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_attendant_message_consents_ux" ON "ipd_attendant_message_consents" USING btree ("admission_id","attendant_ref");