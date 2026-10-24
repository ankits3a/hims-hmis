-- ER guards (#881, after lanes 2–8): the database refuses what the ER intents never do.
-- Append-only: triage entries, doses, med returns, procedures, consents, advances, settled bills — a correction is a new row.
CREATE FUNCTION er_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'er_append_only: % rows are never edited or deleted (% refused)', TG_TABLE_NAME, TG_OP; END $$;--> statement-breakpoint
CREATE TRIGGER er_triage_entries_append_only BEFORE UPDATE OR DELETE ON er_triage_entries FOR EACH ROW EXECUTE FUNCTION er_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER er_doses_append_only BEFORE UPDATE OR DELETE ON er_doses FOR EACH ROW EXECUTE FUNCTION er_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER er_med_returns_append_only BEFORE UPDATE OR DELETE ON er_med_returns FOR EACH ROW EXECUTE FUNCTION er_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER er_procedures_append_only BEFORE UPDATE OR DELETE ON er_procedures FOR EACH ROW EXECUTE FUNCTION er_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER er_consents_append_only BEFORE UPDATE OR DELETE ON er_consents FOR EACH ROW EXECUTE FUNCTION er_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER er_advances_append_only BEFORE UPDATE OR DELETE ON er_advances FOR EACH ROW EXECUTE FUNCTION er_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER er_bills_append_only BEFORE UPDATE OR DELETE ON er_bills FOR EACH ROW EXECUTE FUNCTION er_forbid_mutation();--> statement-breakpoint
-- er_notes: a draft changes once, by its co-signature (status draft -> signed, the co-signer, the time, an addendum);
-- a signed note is never edited (cosign_er_note is the only writer).
CREATE FUNCTION er_note_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'er_notes_write_once: notes are never deleted'; END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'er_notes_write_once: a signed note is never edited (an addendum is a new note)'; END IF;
  IF NEW.status <> 'signed' OR NEW.cosigned_by IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.episode_id IS DISTINCT FROM OLD.episode_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.text IS DISTINCT FROM OLD.text OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at OR NEW.provenance IS DISTINCT FROM OLD.provenance THEN
    RAISE EXCEPTION 'er_notes_write_once: a draft changes only by its co-signature';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER er_notes_write_once BEFORE UPDATE OR DELETE ON er_notes FOR EACH ROW EXECUTE FUNCTION er_note_guard();--> statement-breakpoint
-- er_codes: the call is written once; the scribe is set once; the end (time, outcome, leader, note) once, on a running
-- code; the debrief once, on an ended code. `place` follows the latest location event (paper back-entry may add one after
-- the end); its history is the append-only er_code_events.
CREATE FUNCTION er_code_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'er_codes_write_once: codes are never deleted'; END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.episode_id IS DISTINCT FROM OLD.episode_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.bay_id IS DISTINCT FROM OLD.bay_id
     OR NEW.called_by IS DISTINCT FROM OLD.called_by OR NEW.called_at IS DISTINCT FROM OLD.called_at
     OR NEW.door_at IS DISTINCT FROM OLD.door_at OR NEW.team IS DISTINCT FROM OLD.team
     OR NEW.incident_draft IS DISTINCT FROM OLD.incident_draft THEN
    RAISE EXCEPTION 'er_codes_write_once: the call (kind, patient, bay, caller, times, team) is written once';
  END IF;
  IF OLD.scribe_id IS NOT NULL AND NEW.scribe_id IS DISTINCT FROM OLD.scribe_id THEN
    RAISE EXCEPTION 'er_codes_write_once: the scribe is set once';
  END IF;
  IF (NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.outcome IS DISTINCT FROM OLD.outcome
      OR NEW.leader_id IS DISTINCT FROM OLD.leader_id OR NEW.note IS DISTINCT FROM OLD.note)
     AND (OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL) THEN
    RAISE EXCEPTION 'er_codes_write_once: the end (time, outcome, leader, note) is written once, when the code ends';
  END IF;
  IF (NEW.debrief IS DISTINCT FROM OLD.debrief OR NEW.debrief_by IS DISTINCT FROM OLD.debrief_by
      OR NEW.debrief_at IS DISTINCT FROM OLD.debrief_at)
     AND (OLD.ended_at IS NULL OR OLD.debrief_at IS NOT NULL OR NEW.debrief_at IS NULL) THEN
    RAISE EXCEPTION 'er_codes_write_once: the debrief is written once, after the code ended';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER er_codes_write_once BEFORE UPDATE OR DELETE ON er_codes FOR EACH ROW EXECUTE FUNCTION er_code_guard();--> statement-breakpoint
-- er_charge_lines: what was charged (episode, source, order/issue/procedure, item, qty, who, when) is written once. A line
-- awaiting its rate is priced once (rate_missing/rate_pending -> posted); an open line is reversed or moved to the IP
-- bill once; a reversed or moved line is final (a cancel after the move is IPD's own reversal line).
CREATE FUNCTION er_charge_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'er_charge_lines_write_once: charge lines are never deleted (a cancel is a reversal)'; END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.episode_id IS DISTINCT FROM OLD.episode_id OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.department IS DISTINCT FROM OLD.department OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.order_item_id IS DISTINCT FROM OLD.order_item_id OR NEW.issue_id IS DISTINCT FROM OLD.issue_id
     OR NEW.procedure_id IS DISTINCT FROM OLD.procedure_id OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.qty IS DISTINCT FROM OLD.qty OR NEW.posted_by IS DISTINCT FROM OLD.posted_by OR NEW.posted_at IS DISTINCT FROM OLD.posted_at THEN
    RAISE EXCEPTION 'er_charge_lines_write_once: what was charged is written once';
  END IF;
  IF OLD.status IN ('reversed', 'moved') THEN
    RAISE EXCEPTION 'er_charge_lines_write_once: a % line is final', OLD.status;
  END IF;
  IF NEW.status = 'posted' AND OLD.status IN ('rate_missing', 'rate_pending')
     AND NEW.reversed_at IS NULL AND NEW.reverse_reason IS NULL AND NEW.moved_to_admission_id IS NULL AND NEW.moved_ipd_line_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'reversed' AND NEW.reversed_at IS NOT NULL AND NEW.service_id IS NOT DISTINCT FROM OLD.service_id
     AND NEW.moved_to_admission_id IS NULL AND NEW.moved_ipd_line_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'moved' AND NEW.amount_paise IS NOT DISTINCT FROM OLD.amount_paise AND NEW.service_id IS NOT DISTINCT FROM OLD.service_id
     AND NEW.reversed_at IS NULL AND NEW.reverse_reason IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'er_charge_lines_write_once: % -> % is not a charge line step', OLD.status, NEW.status;
END $$;--> statement-breakpoint
CREATE TRIGGER er_charge_lines_write_once BEFORE UPDATE OR DELETE ON er_charge_lines FOR EACH ROW EXECUTE FUNCTION er_charge_line_guard();
