-- ═══ `formulary_medicine_salts.source` STOPS BEING A DEFAULT AND BECOMES A STATEMENT ═══
--
-- The column has existed since 0026 with a DEFAULT of 'curated' and NO writer that ever set it.
-- Measured on the loaded national catalogue before this migration: all 142,759 rows — every one of
-- them written by the catalogue importer — read 'curated'. The table's own header claimed, in the
-- present tense, that "the curated delete is scoped to `curated`". It never was, and the column
-- could not have supported that scoping even if it had been, because it did not distinguish its two
-- writers. A column nobody writes, described by a comment nobody can check, reads as a guarantee.
--
-- THE BACKFILL IS NOT SOMETHING `drizzle-kit generate` CAN PRODUCE. The generator reproduces a
-- SCHEMA diff; the UPDATE below is a DATA statement, hand-written after the fact. REGENERATING THIS
-- FILE WOULD SILENTLY DELETE IT and leave only the DROP DEFAULT. If the generator is ever re-run
-- against this schema, diff its output against this file rather than overwriting it.
--
-- WHY `created_by` IS THE DISCRIMINATOR, AND WHY THERE IS NO SECOND BACKFILL. Provenance is knowable
-- exactly and only from the medicine's own `created_by`: the importer stamps 'cds-import' on every
-- row it writes (`scripts/import-cds-catalogue.ts`), and a pharmacist's actor id is a ULID. Because
-- `source` has carried a default and zero writers since 0026, the column itself holds no
-- information to preserve — so this sets the release rows to the truth and leaves every other row
-- reading 'curated', which for a row a human actually typed is also the truth.
--
-- THE ORDER OF THE TWO STATEMENTS MATTERS. The backfill runs FIRST, while the default is still in
-- place, so a concurrent insert during the migration cannot fail on a missing value; the column
-- becomes mandatory only once every existing row has been told what it is.
--
-- ON PRODUCTION THIS IS A MEASURED NO-OP: `formulary_medicines` is empty there and `deploy.sh` runs
-- no importer, so the UPDATE touches 0 rows. Re-measure at deploy rather than trusting this
-- sentence — it records 2026-09-16, not the day you read it.

UPDATE "formulary_medicine_salts" AS l
   SET "source" = 'derived'
  FROM "formulary_medicines" AS m
 WHERE m."id" = l."medicine_id"
   AND m."created_by" = 'cds-import';
--> statement-breakpoint
ALTER TABLE "formulary_medicine_salts" ALTER COLUMN "source" DROP DEFAULT;
