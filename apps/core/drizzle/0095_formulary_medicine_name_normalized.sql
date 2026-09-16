-- ═══ THE BRAND NAME AS `normalizeDrugName` SEES IT, STORED ═══
--
-- `resolveDrugTexts` read EVERY ACTIVE MEDICINE on every prescription issue and every claim, then
-- normalized each brand in JavaScript to build a lookup map — because the normalized form existed
-- nowhere a WHERE clause could reach. Measured on the loaded national catalogue that is 103,383
-- rows per call. `modules/formulary/resolve.ts` names this column as its own extension point, in as
-- many words: "a stored normalized column ... filled by the SAME function, so there is still one
-- normalizer and the WHERE clause reads a column rather than re-deriving a value."
--
-- ═══ THREE STATEMENTS, AND THE ORDER IS THE WHOLE POINT ═══
--
-- `drizzle-kit generate` emitted this as a single `ADD COLUMN "name_normalized" text NOT NULL`,
-- which FAILS on any table that already has rows — there is no default to give them. Rewritten by
-- hand as add-nullable, backfill, then constrain. The generator cannot know the backfill exists:
-- REGENERATING THIS FILE WOULD SILENTLY DELETE IT and restore the version that cannot apply. If the
-- generator is ever re-run against this schema, diff its output against this file.
--
-- ═══ THE BACKFILL IS THE ONE PLACE THE NORMALIZER IS WRITTEN IN SQL ═══
--
-- Every other filler is the TypeScript `normalizeDrugName`, called at each write site, which is what
-- keeps ONE normalizer rather than two. §2.54's objection — that two copies of one fact drift by
-- construction — applies to this statement, and the answer is not an argument but a test:
-- `resolve.test.ts`'s drift pin writes an adversarial corpus through `addMedicine` and asserts the
-- stored key equals `normalizeDrugName(brandName)` for every shape the normalizer touches.
--
-- The chain reproduces the function exactly: lowercase, strip `. , ( ) - /`, collapse whitespace
-- runs to one space, trim. VERIFIED against real data before it was written here — run over the
-- 103,383 brand names of the loaded catalogue it produces 103,332 distinct keys, the same count the
-- JavaScript function produces over the same names.
--
-- ═══ THE INDEX IS NOT UNIQUE, AND THAT IS MEASURED RATHER THAN CONCEDED ═══
--
-- The extension point's own wording asks for "a unique index". It will not build: those 51 colliding
-- groups are real products — `Ab-Xone` and `Abxone`, `A-Pan` and `Apan`, `A-Ret` and `Aret`. Same
-- shape and same reason as `formulary_generics_name_norm_idx`, where 774 groups collide. The
-- resolver keeps its existing last-one-wins behaviour for a collision, which is a separate recorded
-- defect and not one this migration changes.

ALTER TABLE "formulary_medicines" ADD COLUMN "name_normalized" text;--> statement-breakpoint

UPDATE "formulary_medicines"
   SET "name_normalized" = btrim(
         regexp_replace(
           regexp_replace(lower("brand_name"), '[.,()/-]', '', 'g'),
           '\s+', ' ', 'g'))
 WHERE "name_normalized" IS NULL;--> statement-breakpoint

ALTER TABLE "formulary_medicines" ALTER COLUMN "name_normalized" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "formulary_medicines_name_norm_idx" ON "formulary_medicines" USING btree ("name_normalized");
