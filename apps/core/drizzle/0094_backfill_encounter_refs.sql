-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- THE VISITS THE LEDGER FILED UNDER A NAME NO READER LOOKS FOR
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- Owner, 2026-09-12: *"if the visit was already charged then why does the screen show UNPAID on the
-- left panel?"* Owner, 2026-09-15, on the papers sheet: *"This visit is paid but I see no related
-- papers."* One cause, reported twice.
--
-- `invoices.encounter_id` is plain text with no FK, and until #200 the counter stored whatever the
-- cashier typed. A cashier types the VISIT NUMBER — `V2609150001`, the only identifier printed on
-- the patient's slip — while every projection over the ledger keys on `opd_encounters.id`:
--
--   * `encounterFeeStatuses` — the token stamp on the OPD queue AND the counter's own rail
--   * `feeGate`             — THE CONSULT GATE. A patient who paid is refused at the doctor's door.
--   * `daily-close`         — the uncharged-visit sweep, which keeps asking about a billed visit
--
-- #200 fixed the WRITER (`canonicalEncounterRef`). It shipped no backfill, so every row written
-- before that deploy is still filed under the display string. This is that backfill, and the owner
-- authorised it on 2026-09-15.
--
-- ═══ WHY THIS IS HAND-WRITTEN AND MUST NEVER BE REGENERATED ═══
--
-- `drizzle-kit generate` reproduces a SCHEMA diff. There is no schema change here at all — not one
-- column, index or constraint moves — so regenerating this file produces an EMPTY migration and
-- silently deletes the repair. The same trap `0043_patient_identity_spine.sql` carries at its head.
--
-- ═══ IT SWITCHES OFF AN IMMUTABILITY TRIGGER, AND THAT NEEDS SAYING OUT LOUD ═══
--
-- `invoices` is append-only: migration 0012's `invoices_immutable` raises on UPDATE and DELETE,
-- because an invoice is a tax document. This migration disables that trigger for the length of one
-- statement and re-arms it. Three things make that defensible rather than a hole:
--
--   1. NOTHING LEGAL MOVES. No amount, tax head, party, document number, issue time or issuer is
--      touched. The repaired column is an internal reference to a visit — the row already claims
--      that exact visit, by its other name. The bill's content is what it always was.
--   2. IT IS ONE STATEMENT, NOT A WINDOW. The disable, the update and the re-arm are inside a
--      single `DO` block, which Postgres executes atomically: if any part raises, the whole
--      statement rolls back and the trigger is never left off. A bare `ALTER … DISABLE` followed by
--      a failing UPDATE would leave production's money table unguarded — silently, and for ever.
--   3. THE GUARD IS NOT WEAKENED. No `WHEN` clause is added, no row is exempted, nothing about the
--      application's access changes. The trigger is in force before this statement and after it.
--
-- ═══ WHERE THE TWO NAMES DISAGREE ABOUT THE PERSON, THIS DECIDES NOTHING ═══
--
-- FD-35 states the rule for exactly this situation: *"A GUARD, NOT A CORRECTION. The server does not
-- get to decide which of the two the cashier meant — it refuses, names both, and lets the person at
-- the counter say which."* A row whose `patient_id` is not the visit's own patient is that case,
-- frozen in the ledger. Making its reference canonical would ACTIVATE that link — settling one
-- person's visit with another person's bill in every projection above — on a decision no one made.
--
-- So those rows are counted, reported by name in the deploy log, and left exactly as they are. They
-- need a human. The read side finds them either way (`encounterRefSpellings`), so nothing is lost
-- by leaving them; something would be lost by guessing.
--
-- ═══ WHAT IS DELIBERATELY NOT TOUCHED ═══
--
--   * `events` and `phi_access` carry `encounter_id` and were written from the same raw reference.
--     They are APPEND-ONLY HISTORY. An event says "at time T this was emitted with this scope",
--     which is a true statement about the past whatever the reference was. Rewriting an audit log
--     to make history tidier is the one repair that is always wrong.
--   * Every other `encounter_id` in the schema either carries a real foreign key (which made this
--     class impossible) or belongs to a module with its own episode spelling (`modules/ot`'s `D…`).
--
-- IDEMPOTENT. Re-running matches nothing: after the first pass no `encounter_id` equals a
-- `visit_no` any more. That matters because this file is executed a second time, deliberately, by
-- `test/backfill-encounter-refs.test.ts` — the only honest way to test the SQL that actually ships.

DO $$
DECLARE
  repaired_invoices integer := 0;
  skipped_invoices  integer := 0;
  repaired_jobs     integer := 0;
  repaired_params   integer := 0;
BEGIN
  -- Counted BEFORE the repair, because afterwards the mismatched rows are the only ones left and
  -- "how many did we decline to touch" stops being answerable from the data.
  SELECT count(*) INTO skipped_invoices
  FROM invoices i
  JOIN opd_encounters e ON e.visit_no = i.encounter_id
  WHERE i.patient_id <> e.patient_id;

  ALTER TABLE invoices DISABLE TRIGGER invoices_immutable;

  WITH moved AS (
    UPDATE invoices i
       SET encounter_id = e.id
      FROM opd_encounters e
     WHERE i.encounter_id = e.visit_no
       AND i.patient_id   = e.patient_id   -- FD-35: never decide which human the row meant
    RETURNING 1
  )
  SELECT count(*) INTO repaired_invoices FROM moved;

  ALTER TABLE invoices ENABLE TRIGGER invoices_immutable;

  -- ═══ THE PRINT QUEUE, FOR THE SAME REASON AND FROM THE SAME WRITER ═══
  --
  -- `opd/encounters.ts` has always enqueued with `encounter.id`. `billing/invoices.ts` has not: the
  -- payment receipt rides the invoice transaction and took `input.encounterId`, so a receipt queued
  -- for a visit billed by its number carries `V…` here too. No trigger and no foreign key on this
  -- table; the `patient_id` agreement is still required where the column is set, for FD-35's reason,
  -- and a NULL subject gates on nothing because such a job names no person.
  WITH moved AS (
    UPDATE print_jobs j
       SET encounter_id = e.id
      FROM opd_encounters e
     WHERE j.encounter_id = e.visit_no
       AND (j.patient_id IS NULL OR j.patient_id = e.patient_id)
    RETURNING 1
  )
  SELECT count(*) INTO repaired_jobs FROM moved;

  -- AND THE PARAMS THE RENDERER READS, which is a separate copy of the same reference and would
  -- otherwise stay broken after the column beside it was fixed. `subjectOf` (kernel/printing/
  -- render.ts) looks the encounter up by `opd_encounters.id` ALONE — it does not accept a visit
  -- number the way `getEncounter` does — so a legacy receipt renders NULL, and the papers sheet
  -- answers "save as PDF" with *"This payment receipt is no longer available to open."* The column
  -- and the payload are one fact stored twice; repairing one of them is repairing neither.
  WITH moved AS (
    UPDATE print_jobs j
       SET params = jsonb_set(j.params, '{encounterId}', to_jsonb(e.id))
      FROM opd_encounters e
     WHERE j.params ->> 'encounterId' = e.visit_no
       AND (j.patient_id IS NULL OR j.patient_id = e.patient_id)
    RETURNING 1
  )
  SELECT count(*) INTO repaired_params FROM moved;

  RAISE NOTICE 'backfill 0094: % invoice(s) and % print job(s) (% payload(s)) re-filed under the canonical encounter id', repaired_invoices, repaired_jobs, repaired_params;

  IF skipped_invoices > 0 THEN
    RAISE NOTICE 'backfill 0094: % invoice(s) LEFT UNREPAIRED — patient_id does not match the visit''s own patient (FD-35). These need a human; list them with: SELECT i.id, i.invoice_no, i.patient_id, e.id, e.patient_id FROM invoices i JOIN opd_encounters e ON e.visit_no = i.encounter_id WHERE i.patient_id <> e.patient_id;', skipped_invoices;
  END IF;
END $$;
