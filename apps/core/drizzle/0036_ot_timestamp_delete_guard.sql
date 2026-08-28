-- PLAN 15 CLOSE REVIEW M5 — DD8's write-once guard was BEFORE UPDATE only, so DELETE walked past it.
--
-- `0035` created `ot_cases_timestamps_immutable` as `BEFORE UPDATE`. The invariant DD8 states, and
-- that I4/A15 assert, is that the five clinical clocks cannot be changed once written "whatever
-- writes them" — and a DELETE followed by a re-INSERT changes them without ever firing an UPDATE
-- trigger. That is precisely the 2 a.m. data fix the cockpit's own docstring names as the thing this
-- guard exists to stop.
--
-- Billing's `0012_billing_immutability.sql` is the house precedent and it got this right: every one
-- of its six triggers is `BEFORE UPDATE OR DELETE`. This brings the OT into line.
--
-- A day-care case is never deleted by any code path in this module: cancellation is a state
-- (`cancelled`), a postponement is a state, and `truncateAll` uses TRUNCATE, which does not fire row
-- triggers — which is exactly why billing can afford the same guard and why the test suite is
-- unaffected. If a case ever genuinely must go, it goes the way a billing row goes: it does not.
DROP TRIGGER IF EXISTS ot_cases_timestamps_immutable ON ot_cases;--> statement-breakpoint

CREATE OR REPLACE FUNCTION ot_forbid_timestamp_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ot_timestamp_immutable: ot_cases row % cannot be deleted — the five clinical clocks are write-once (DD8), and a delete-then-reinsert is a rewrite', OLD.id;
  END IF;
  IF (OLD.wheel_in  IS NOT NULL AND NEW.wheel_in  IS DISTINCT FROM OLD.wheel_in)
  OR (OLD.induction IS NOT NULL AND NEW.induction IS DISTINCT FROM OLD.induction)
  OR (OLD.incision  IS NOT NULL AND NEW.incision  IS DISTINCT FROM OLD.incision)
  OR (OLD.closure   IS NOT NULL AND NEW.closure   IS DISTINCT FROM OLD.closure)
  OR (OLD.wheel_out IS NOT NULL AND NEW.wheel_out IS DISTINCT FROM OLD.wheel_out)
  THEN
    RAISE EXCEPTION 'ot_timestamp_immutable: ot_cases row % carries write-once clinical timestamps (DD8)', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER ot_cases_timestamps_immutable
  BEFORE UPDATE OR DELETE ON ot_cases
  FOR EACH ROW EXECUTE FUNCTION ot_forbid_timestamp_rewrite();
