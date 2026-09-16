-- ═══ THE FORMULARY MAPPING LOOP: DRAFTS, AND A PROVENANCE COLUMN THAT MAKES A PROJECTION REVERSIBLE ═══
--
-- Phase doc: docs/superpowers/plans/2026-09-16-phase2-formulary-mapping-loop.md (owner ruling R1).
--
-- `formulary_mapping_proposals` holds the drafter's advice to the pharmacist. It is not a decision:
-- the decision stays `formulary_substances.salt_id`, written only by `attestSubstance`.
--
-- `formulary_medicine_salts.derived_from` records which release substance a derived row came from,
-- so a mapping decision can find its rows again after they have moved.
--
-- ═══ HAND-EDITED AFTER `drizzle-kit generate`: THE BACKFILL BELOW IS NOT A SCHEMA DIFF ═══
--
-- The generator emitted every other statement here. It cannot know the UPDATE exists, and
-- REGENERATING THIS FILE WOULD SILENTLY DELETE IT (the 0043 and 0095 trap). If the generator is
-- ever re-run against this schema, diff its output against this file.
--
-- The backfill fills `derived_from` for DERIVED rows that point at a RELEASE IMAGE, from that
-- image's own `source_ref`. That is exact: the importer wrote each such row from that substance and
-- nothing else. It does NOT guess for derived rows on a CURATED moiety (the importer reused one by
-- exact name). Those carry no record of their substance, they already name a curated moiety, and
-- the projection leaves them where they are (phase doc E10). `test/formulary-mapping-backfill.test.ts`
-- runs this statement, read off this file, against both kinds of row.
--
-- Production holds no catalogue (owner, 2026-09-16), so there it matches nothing. On a dev database
-- that already holds both tiers, rows of a substance mapped BEFORE this migration stay on their
-- release image until something projects them. Re-running `import-cds-catalogue.ts --apply` does
-- that: it skips every existing product and then projects the whole catalogue.
CREATE TABLE "formulary_mapping_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"substance_id" text NOT NULL,
	"moiety_name" text NOT NULL,
	"basis" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"drafted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formulary_mapping_proposals_basis_ck" CHECK ("formulary_mapping_proposals"."basis" in ('release_boss', 'release_base', 'agent')),
	CONSTRAINT "formulary_mapping_proposals_moiety_name_ck" CHECK (length(btrim("formulary_mapping_proposals"."moiety_name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "formulary_medicine_salts" ADD COLUMN "derived_from" text;--> statement-breakpoint
UPDATE "formulary_medicine_salts" AS l
   SET "derived_from" = s."source_ref"
  FROM "formulary_salts" AS s
 WHERE s."id" = l."salt_id"
   AND l."source" = 'derived'
   AND s."source_ref" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "formulary_mapping_proposals" ADD CONSTRAINT "formulary_mapping_proposals_substance_id_formulary_substances_id_fk" FOREIGN KEY ("substance_id") REFERENCES "public"."formulary_substances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "formulary_mapping_proposals_substance_drafter_ux" ON "formulary_mapping_proposals" USING btree ("substance_id","drafted_by");--> statement-breakpoint
CREATE INDEX "formulary_generic_substances_substance_idx" ON "formulary_generic_substances" USING btree ("substance_id");--> statement-breakpoint
CREATE INDEX "formulary_medicine_salts_derived_from_idx" ON "formulary_medicine_salts" USING btree ("derived_from");--> statement-breakpoint
CREATE UNIQUE INDEX "formulary_salts_source_ref_ux" ON "formulary_salts" USING btree ("source_ref") WHERE "formulary_salts"."source_ref" is not null;--> statement-breakpoint
ALTER TABLE "formulary_medicine_salts" ADD CONSTRAINT "formulary_medicine_salts_curated_underived_ck" CHECK ("formulary_medicine_salts"."source" = 'derived' or "formulary_medicine_salts"."derived_from" is null);