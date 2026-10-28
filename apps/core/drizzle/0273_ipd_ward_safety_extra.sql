CREATE TABLE "ipd_nurse_registrations" (
	"user_id" text PRIMARY KEY NOT NULL,
	"council" text NOT NULL,
	"registration_no" text NOT NULL,
	"valid_until" date NOT NULL,
	"verified_by" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"revoked_by" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "ipd_nurse_registrations_revoked_ck" CHECK (("ipd_nurse_registrations"."revoked_at" is null) = ("ipd_nurse_registrations"."revoked_by" is null))
);
