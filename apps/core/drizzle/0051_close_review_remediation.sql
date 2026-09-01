-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PLAN 18a — THE CLOSE REVIEW'S REMEDIATION MIGRATION (findings F55, F61, F63, F66, F76)
--
-- Five columns and one trigger, each with its finding:
--
--   · `imaging_studies.duration_min` (F55) — declared on every study type, validated by the body
--     schema, seeded with real values, and READ BY NOTHING. The slot unique is on an exact
--     `scheduled_at`, so the "slot" was a point and a 45-minute MRI took two bookings fifteen
--     minutes apart with no refusal. Snapshotted onto the study so an overlap is computable.
--   · `imaging_reports.lockout_override` (F66) — the medical superintendent who approved a
--     DEMOGRAPHIC-tier lockout hit, and why. A coded-tier hit can be approved by nobody.
--   · `imaging_critical_findings.recorded_by` (F76) — who TYPED the acknowledgement, kept apart
--     from `acknowledged_by`, which is now the clinician who actually received the call.
--   · `pcpndt_form_f.device_resource_id` + the re-keyed serial counter (F61) — see the schema.
--     The counter was keyed on a REGISTRATION-scoped row, and there is no renew path, so a renewal
--     minted a new machine row for the same scanner and restarted the year's serials at 1. The
--     unique index could not see the duplicates because it was keyed the same way.
--   · the Form F trigger (F63) — below.
--
-- ═══ TWO NOTES A REVIEWER SHOULD NOT HAVE TO RE-DERIVE ═══
--
-- **The two `NOT NULL` columns without defaults.** They are safe not because the tables are empty
-- but because in production the tables DO NOT EXIST: `0047` created them and production is at 46
-- migrations, so `pcpndt_form_f` and `pcpndt_form_f_serials` arrive with `0047`..`0051` in one
-- deploy and are created empty by definition. That is a claim about the MIGRATION COUNT and not
-- about rows, which is the honest form of it — "the table has no rows" would be a claim about a
-- statutory register that nobody had measured.
--
-- **`DROP INDEX` and `CREATE UNIQUE INDEX` name the same index.** Between the two statements the
-- uniqueness guard on a statutory register is absent, which would matter if a migration could
-- half-apply. It cannot: drizzle's node-postgres migrator wraps each file in one transaction
-- (`session.transaction` in `pg-core/dialect.ts`), so either both statements land or neither does.
--
-- **STATEMENT ORDER IS LOAD-BEARING HERE, and it was wrong once.** drizzle-kit emits its constraint
-- block before its column block, so the generated file added the `_serials` primary key on
-- `device_resource_id` FIVE statements before creating that column. `setupTestDb` migrates before
-- any suite touches a row, so the result was not "radiology tests fail" — it was that **no test
-- database in the repository could be created at all**, for every lane, and `tsc` cannot see it.
-- The PK now sits after both `ADD COLUMN`s. Found by a peer lane's e2e, not by this one's typecheck.

DROP INDEX "pcpndt_form_f_machine_serial_ux";--> statement-breakpoint
ALTER TABLE "pcpndt_form_f_serials" DROP CONSTRAINT "pcpndt_form_f_serials_machine_id_year_pk";--> statement-breakpoint
ALTER TABLE "pcpndt_form_f_serials" ALTER COLUMN "machine_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "imaging_critical_findings" ADD COLUMN "recorded_by" text;--> statement-breakpoint
ALTER TABLE "imaging_reports" ADD COLUMN "lockout_override" jsonb;--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD COLUMN "duration_min" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "pcpndt_form_f" ADD COLUMN "device_resource_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "pcpndt_form_f_serials" ADD COLUMN "device_resource_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "pcpndt_form_f_serials" ADD CONSTRAINT "pcpndt_form_f_serials_device_resource_id_year_pk" PRIMARY KEY("device_resource_id","year");--> statement-breakpoint
ALTER TABLE "pcpndt_form_f" ADD CONSTRAINT "pcpndt_form_f_device_resource_id_resources_id_fk" FOREIGN KEY ("device_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pcpndt_form_f_serials" ADD CONSTRAINT "pcpndt_form_f_serials_device_resource_id_resources_id_fk" FOREIGN KEY ("device_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pcpndt_form_f_machine_serial_ux" ON "pcpndt_form_f" USING btree ("device_resource_id","serial_year","serial_no");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- FINDING F63 — `0050`'s COMPLETION WINDOW WAS AN ALLOW-LIST WRITTEN AS A DENY-LIST, AND IT LET
-- THE WRITER COUNTER-SIGN THEMSELVES.
--
-- `0050` fixed F25 correctly and introduced one new escape. Its completion branch is an
-- UNCONDITIONAL `RETURN NEW` on `OLD.status='open' AND NEW.status='recorded'`, placed AFTER the
-- identity check and BEFORE the whole-row comparison. So in that ONE statement every column not in
-- the identity list is free — including `verified_by` and `verified_at`, the two the entire
-- separation of duties rests on. `pcpndt_form_f_verify_after_record_ck` then admits them, because
-- after the statement `status` IS `'recorded'`. A single
--
--   UPDATE pcpndt_form_f SET status='recorded', sections=…, signed_by='dr.x', signed_at=now(),
--                            verified_by='dr.x', verified_at=now() WHERE id=…
--
-- is accepted by the trigger and by every CHECK: **the statutory declaration written and
-- self-counter-signed in one statement by one person**, under a criminal statute whose entire point
-- is that the writer and the verifier are two people.
--
-- No shipped path does it — `recordFormF` never sets the verification columns and `verifyFormF`
-- refuses `same_actor` — so the separation held in application code and ONLY in application code.
-- That is exactly the posture `0047`'s own header argued against when it chose whole-row
-- comparison: *"a column a LATER migration adds is frozen by default rather than silently
-- mutable"*. `0050` reintroduced, in the one window where a row is legitimately written, the
-- deny-list shape that `0045` existed to remove.
--
-- WHAT CHANGES: the completion is still exactly one transition and still writes the whole
-- declaration. It may no longer carry a VERIFICATION with it. Verifying is a second statement, by a
-- second person, through the path that checks they are not the signer. `device_resource_id` joins
-- the frozen identity list for the same reason `machine_id` is on it.
CREATE OR REPLACE FUNCTION pcpndt_form_f_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pcpndt_form_f_immutable: pcpndt_form_f rows are append-only (DELETE refused)';
  END IF;

  IF NEW.serial_no IS DISTINCT FROM OLD.serial_no
     OR NEW.serial_year IS DISTINCT FROM OLD.serial_year
     OR NEW.machine_id IS DISTINCT FROM OLD.machine_id
     OR NEW.device_resource_id IS DISTINCT FROM OLD.device_resource_id
     OR NEW.study_id IS DISTINCT FROM OLD.study_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    RAISE EXCEPTION 'pcpndt_form_f_immutable: the serial, machine, device, study and patient of a Form F are fixed when it is opened';
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'recorded' THEN
    IF NEW.verified_by IS NOT NULL OR NEW.verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'pcpndt_form_f_immutable: a Form F cannot be recorded and verified in one statement — the verifier is a second person (F63)';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - 'verified_by' - 'verified_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'verified_by' - 'verified_at') THEN
    RAISE EXCEPTION 'pcpndt_form_f_immutable: only verified_by and verified_at may change after insert';
  END IF;

  RETURN NEW;
END;
$$;
