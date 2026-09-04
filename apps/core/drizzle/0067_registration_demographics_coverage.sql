-- FD-12 / OWNER RULING (2026-09-04): the registration counter takes a real record, not four fields.
--
-- The owner put a competitor's registration screen beside ours and the verdict was that ours "lacks
-- many fields". It did. `patients` could not hold a title, a father's or husband's name, a
-- nationality, an ID document, a religion, an occupation, an income, or the answer to "who sent
-- you" — and there was nowhere at all to record how the care gets paid for.
--
-- ADDITIVE AND NULLABLE THROUGHOUT. Every existing row keeps meaning exactly what it meant, and the
-- fast walk-in path still registers on a name and a sex alone: Desk One's four-field core is not
-- being traded away for this, it is being given somewhere to grow when the clerk has more.
--
-- THE NATIONAL ID IS A LAST-4 TAIL, following `patient_guardians.id_number_masked`, which already
-- ruled that this schema "never holds the full document number". The patient's own document is not
-- a weaker case than their guardian's, and for Aadhaar it is the only defensible answer: the
-- Aadhaar Act restricts who may store the number, and a masked tail still matches the card in the
-- patient's hand, which is all the counter needs it for.

ALTER TABLE "patients"
  ADD COLUMN IF NOT EXISTS "title" text,
  ADD COLUMN IF NOT EXISTS "father_husband_name" text,
  ADD COLUMN IF NOT EXISTS "marital_status" text,
  ADD COLUMN IF NOT EXISTS "nationality" text,
  ADD COLUMN IF NOT EXISTS "national_id_type" text,
  ADD COLUMN IF NOT EXISTS "national_id_masked" text,
  ADD COLUMN IF NOT EXISTS "religion" text,
  ADD COLUMN IF NOT EXISTS "occupation" text,
  ADD COLUMN IF NOT EXISTS "monthly_income_paise" integer,
  ADD COLUMN IF NOT EXISTS "referred_by_source" text,
  ADD COLUMN IF NOT EXISTS "referred_by_name" text,
  ADD COLUMN IF NOT EXISTS "referred_by_phone" text,
  ADD COLUMN IF NOT EXISTS "referred_by_speciality" text;

-- HOW THIS PATIENT'S CARE GETS PAID FOR. A TABLE and not columns, because a patient holds several
-- of these at once as the NORMAL case — an Ayushman card and a private mediclaim, an employer
-- scheme and a top-up. Flattening them onto `patients` would model "the one policy" and silently
-- drop the second, which surfaces months later as a rejected claim.
--
-- This is the ENTITLEMENT — the card in the patient's wallet — and nothing more. `billing` keeps
-- owning corporate/TPA pricing and claim processing and reads this rather than being duplicated by
-- it. Policy and card numbers are stored IN FULL, unlike the national id above: a policy number is
-- not a government identity document, the claim cannot be filed without it, and the patient hands
-- it over precisely so that it can be.
CREATE TABLE IF NOT EXISTS "patient_coverages" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "kind" text NOT NULL,
  "payer_name" text,
  "tpa_name" text,
  "policy_number" text,
  "card_number" text,
  "beneficiary_id" text,
  "employee_id" text,
  "plan_class" text,
  "sum_insured_paise" integer,
  "valid_from" date,
  "valid_to" date,
  "claim_id" text,
  "verification_status" text DEFAULT 'self_declared' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "note" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "patient_coverages_patient_idx" ON "patient_coverages" ("patient_id");
