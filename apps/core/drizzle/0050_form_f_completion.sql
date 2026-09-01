-- PLAN 18a T6 / FINDING F25 — THE FORM F TRIGGER FROZE A ROW THE DESIGN REQUIRES TO BE COMPLETED
-- ONCE, AND THE WHOLE REGISTER WAS UNREACHABLE BECAUSE OF IT.
--
-- `0047` shipped `pcpndt_form_f_forbid_mutation()` comparing WHOLE ROWS minus `verified_by` and
-- `verified_at`, so no column could change after insert. Three files describe a two-step life for
-- this row and the trigger permitted only the first of them:
--
--   · `schema/pcpndt.ts` — *"A form is OPENED when the sonologist starts it (which mints the serial,
--     irreversibly) and RECORDED when it is complete and signed."*
--   · `FORM_F_STATUSES = ['open','recorded']`, and `pcpndt_form_f_recorded_shape_ck` exists precisely
--     to allow a null signer while `status = 'open'` and to demand one otherwise.
--   · §5 T6 A3 — *"`assertFormFRecorded` is refused for a study with an OPEN form and passes with a
--     RECORDED one"*, which requires one study to be able to hold each state in turn. It cannot:
--     `pcpndt_form_f_study_ux` allows exactly one row per study, so "later recorded" can only mean
--     "this row, updated".
--
-- MEASURED AT THE DATABASE RATHER THAN REASONED ABOUT (this phase's own F2 discipline): inserting an
-- `open` form and running `UPDATE … SET status='recorded', sections=…, signed_by=…, signed_at=…`
-- against `hmis_lane_b_scratch_1` raises
-- `pcpndt_form_f_immutable: only verified_by and verified_at may change after insert`.
-- **Every applicable scan in the hospital was therefore permanently unacquirable**, because T7's
-- `assertFormFRecorded` can never see a recorded form.
--
-- ═══ WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT ═══
--
-- It permits EXACTLY ONE transition — `open → recorded`, the sonologist completing the form they
-- started — and freezes the row thereafter. It does NOT widen A4 by a single column:
--
--   · a RECORDED form's `sections`, `serial_no`, `person_id`, `patient_id` and every other column
--     remain unchangeable, which is A4's assertion and the mutant it names (*"the trigger omits
--     `sections` → the Part F indication is editable after the inspector left"*);
--   · `serial_no`, `serial_year`, `machine_id`, `study_id` and `patient_id` are frozen from INSERT,
--     including across the completion — a form cannot be completed onto a different machine, a
--     different serial or a different woman than the one whose scan minted it;
--   · DELETE stays refused in every state;
--   · `recorded → open` is refused, so a completed declaration cannot be reopened and rewritten;
--   · `verified_by`/`verified_at` remain the only columns a recorded row may ever change, and
--     `pcpndt_form_f_verify_after_record_ck` still refuses a verification on an unrecorded form.
--
-- ═══ DISCLOSED: THIS MIGRATION IS OUTSIDE T6's FILES LIST ═══
--
-- T1 owns the migrations and T6 owns the module. The alternative was a CHAIN HALT (AGENT-RULES §3
-- branch (a)), and it was rejected because the defect makes T6 through T9 unbuildable rather than
-- merely wrong: there is no version of this module that works against the shipped trigger. Recorded
-- as F25 in §9.2 and flagged for the close review rather than taken quietly.
CREATE OR REPLACE FUNCTION pcpndt_form_f_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pcpndt_form_f_immutable: pcpndt_form_f rows are append-only (DELETE refused)';
  END IF;

  -- The identity of the declaration is frozen from INSERT and survives the completion below: which
  -- machine, which serial, which scan, which woman. These are the columns an inspector counts.
  IF NEW.serial_no IS DISTINCT FROM OLD.serial_no
     OR NEW.serial_year IS DISTINCT FROM OLD.serial_year
     OR NEW.machine_id IS DISTINCT FROM OLD.machine_id
     OR NEW.study_id IS DISTINCT FROM OLD.study_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    RAISE EXCEPTION 'pcpndt_form_f_immutable: the serial, machine, study and patient of a Form F are fixed when it is opened';
  END IF;

  -- THE ONE COMPLETION. Everything else about the row may be written exactly once, on the single
  -- transition out of `open`; `pcpndt_form_f_recorded_shape_ck` independently demands the signer.
  IF OLD.status = 'open' AND NEW.status = 'recorded' THEN
    RETURN NEW;
  END IF;

  -- Anything else is the original rule, unchanged: verification only.
  IF (to_jsonb(NEW) - 'verified_by' - 'verified_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'verified_by' - 'verified_at') THEN
    RAISE EXCEPTION 'pcpndt_form_f_immutable: only verified_by and verified_at may change after a form is recorded';
  END IF;
  RETURN NEW;
END $$;
