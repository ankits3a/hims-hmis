-- PLAN 22c-A T1 — the identity spine: assurance, administrative gender, versions, two permissions.
--
-- THE GENERATED FORM OF THIS MIGRATION COULD NOT RUN. `drizzle-kit` emits
-- `ALTER TABLE patients ADD COLUMN administrative_gender text NOT NULL`, which Postgres refuses on
-- any table that has rows — and production has 24. The three-step form below (add nullable,
-- backfill, SET NOT NULL) is the hand-written correction, and it is the reason this file is edited
-- rather than taken as generated.

CREATE TABLE "patient_identity_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"dob" date,
	"dob_estimated" boolean DEFAULT false NOT NULL,
	"administrative_gender" text NOT NULL,
	"abha_number" text,
	"identity_assurance" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"reason_class" text,
	"evidence_ref" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patient_identity_versions" ADD CONSTRAINT "patient_identity_versions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_identity_versions_patient_version_ux" ON "patient_identity_versions" USING btree ("patient_id","version");--> statement-breakpoint
CREATE INDEX "patient_identity_versions_resolve_idx" ON "patient_identity_versions" USING btree ("patient_id","valid_from" DESC NULLS LAST);--> statement-breakpoint

-- DD4 — administrative gender, added NULLABLE so the backfill can run, then closed to NOT NULL.
ALTER TABLE "patients" ADD COLUMN "administrative_gender" text;--> statement-breakpoint
UPDATE "patients" SET "administrative_gender" = "sex" WHERE "administrative_gender" IS NULL;--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "administrative_gender" SET NOT NULL;--> statement-breakpoint

-- DD2 — the assurance ladder. THE DEFAULT AND THE BACKFILL DELIBERATELY DIFFER, and that is the
-- whole point of writing this by hand. The column default is 'self_declared' because that is what
-- a patient asserting their own identity in the app will be from 22c-B onward. Every row that
-- exists at this moment is instead 'staff_verified': each was typed in by a clerk who had the
-- person in front of them. Taking the default here would silently downgrade the entire master.
ALTER TABLE "patients" ADD COLUMN "identity_assurance" text DEFAULT 'self_declared' NOT NULL;--> statement-breakpoint
UPDATE "patients" SET "identity_assurance" = 'staff_verified';--> statement-breakpoint

-- DD3/A20 — version 1 for every patient that already exists, so the resolver has something to
-- return for a document issued before this migration ever ran. `valid_from` is the patient's own
-- `created_at`: this identity state has been in force since registration, and claiming it began
-- today would make every pre-0043 document resolve to nothing.
--
-- `id` follows 0032's migration-constant grammar (`'MIG0032-' || r."id"`) rather than minting a
-- ULID no application code produced. `created_by` DEPARTS from that precedent and carries the
-- patient's own registering clerk — 0032 used a constant because "nobody performed this act", but
-- somebody did perform this one: the person who recorded these values is exactly who this row is
-- about. `reason_class` is NULL because there was no amendment; this is the original state.
INSERT INTO "patient_identity_versions" (
  "id", "patient_id", "version", "name", "dob", "dob_estimated",
  "administrative_gender", "abha_number", "identity_assurance", "valid_from",
  "reason_class", "evidence_ref", "created_by", "created_at"
)
SELECT
  'MIG0043-' || p."id",
  p."id",
  1,
  p."name",
  p."dob",
  p."dob_estimated",
  p."administrative_gender",
  p."abha_number",
  p."identity_assurance",
  p."created_at",
  NULL,
  NULL,
  p."created_by",
  now()
FROM "patients" p;--> statement-breakpoint

-- APPEND-ONLY, ENFORCED BY THE DATABASE — the 0012 billing pattern, verbatim in shape. A version
-- row that can be UPDATEd is not a version, and enforcing this in application code would leave the
-- guarantee one forgotten code path away from being false. A10 is the assertion; the mutant
-- attempts an UPDATE and this trigger is what must refuse it.
CREATE OR REPLACE FUNCTION patient_identity_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'patient_identity_immutable: % rows are append-only (% refused)', TG_TABLE_NAME, TG_OP; END $$;--> statement-breakpoint
CREATE TRIGGER patient_identity_versions_immutable BEFORE UPDATE OR DELETE ON patient_identity_versions FOR EACH ROW EXECUTE FUNCTION patient_identity_forbid_mutation();
