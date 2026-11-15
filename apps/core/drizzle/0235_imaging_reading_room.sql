ALTER TABLE "imaging_reports" ADD COLUMN "drafted_by" text;--> statement-breakpoint
ALTER TABLE "imaging_reports" ADD COLUMN "autosaved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD COLUMN "reading_pool" text;--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD COLUMN "assigned_reader_id" text;--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD COLUMN "reading_claimed_by" text;--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD COLUMN "reading_claimed_at" timestamp with time zone;--> statement-breakpoint

-- #1081 / ruling 0098 §5 — AUTOSAVE MAY OVERWRITE THE READER'S OWN WORKING DRAFT, FOR TEN MINUTES, AND NOTHING
-- ELSE MOVES. 0047's comment asked for exactly this: a later column is frozen by default and a migration that
-- needs one mutable widens the trigger consciously. `status` and `published_at` still move as before
-- (publication, supersession). Beyond them a row may change ONLY when it is an AUTOSAVED human draft — `draft`
-- before and after, no `provenance` (not the machine's proposal), a `drafted_by` that does not change, and an
-- `autosaved_at` — and then only its text (`body`, `impression`, `laterality`, `template_key`) and its
-- `autosaved_at`, which must move forward (every overwrite stamps its instant) and stay inside ten minutes of
-- the version's `created_at`; after that the next autosave cuts a new version. A Save, a prelim, a proposal and every signed, superseded or
-- co-sign-waiting version stay frozen, and DELETE stays refused: every draft version is kept for the record's
-- retention period and nothing is purged at signature.
CREATE OR REPLACE FUNCTION imaging_reports_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'imaging_report_immutable: imaging_reports rows are append-only (DELETE refused)';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'published_at')
     IS NOT DISTINCT FROM (to_jsonb(OLD) - 'status' - 'published_at') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'draft'
     AND OLD.provenance IS NULL AND OLD.drafted_by IS NOT NULL
     AND OLD.autosaved_at IS NOT NULL AND NEW.autosaved_at IS NOT NULL
     AND NEW.autosaved_at > OLD.autosaved_at
     AND NEW.autosaved_at < OLD.created_at + interval '10 minutes'
     AND (to_jsonb(NEW) - 'body' - 'impression' - 'laterality' - 'template_key' - 'autosaved_at')
         IS NOT DISTINCT FROM (to_jsonb(OLD) - 'body' - 'impression' - 'laterality' - 'template_key' - 'autosaved_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'imaging_report_immutable: only status and published_at may change after insert (and an autosaved draft''s own text, for ten minutes)';
END $$;
