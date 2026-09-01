-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PLAN 18a — FINDING F63, SECOND PASS: `0051` CLOSED THE VERIFICATION HOLE AND LEFT THE SHAPE THAT
-- PRODUCED IT.
--
-- `0051` stopped a Form F being recorded and self-counter-signed in one statement. It did that by
-- adding one more explicit refusal to a branch that still ends in a bare `RETURN NEW` — so every
-- column outside the six-column identity list stayed free during the completion, including:
--
--   · **`person_id`** — the registered doctor Part H names as having conducted the procedure.
--     `openFormF` resolves that person and `assertPersonRegistered` checks their membership of the
--     machine's registration; the completing statement could then replace it with any other row id
--     and nothing re-runs. The register would name a doctor who did not perform the scan, on a row
--     that can never be corrected or deleted.
--   · `indication_code` — Part F's stated reason for the examination.
--   · `applicability`, `created_at`, and `id`.
--
-- That is the deny-list shape `0047`'s header argued against at length and that `0045` existed to
-- remove, reintroduced in the one window where a row is legitimately written. Closing the
-- verification hole while leaving it would have been a fix that taught nothing.
--
-- ═══ WHAT THIS CHANGES ═══
--
-- The completion becomes an ALLOW-LIST of what may change, compared whole-row like every other
-- update. What a completion may write is exactly what a completion IS: the status, the form's
-- contents (`sections`, `declaration`, `referral`, `gestation_weeks`) and who signed it when.
-- Everything else — including a column a LATER migration adds — is frozen here by default rather
-- than silently mutable, which is the property `0047` chose whole-row comparison for.
--
-- ═══ WHY THIS IS A NEW MIGRATION AND NOT AN EDIT TO `0051` ═══
--
-- `0051` is committed and peer lanes' test databases have already applied it. A migration that has
-- run does not run again, so amending the file in place would leave every database that saw the
-- first version silently diverged from every database created after — the exact class AGENT-RULES
-- §6 exists to prevent, and invisible to `tsc` and to every suite.
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
    IF (to_jsonb(NEW) - 'status' - 'sections' - 'declaration' - 'referral' - 'gestation_weeks' - 'signed_by' - 'signed_at')
       IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'sections' - 'declaration' - 'referral' - 'gestation_weeks' - 'signed_by' - 'signed_at') THEN
      RAISE EXCEPTION 'pcpndt_form_f_immutable: the completion may write only the form itself and its signature — the person, the indication and the applicability are fixed when it is opened (F63)';
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
