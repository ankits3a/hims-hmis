-- ═══ FORMULARY PHASE 3: A DECISION ADOPTED UNDER A RESOLUTION SAYS SO ═══
--
-- Phase doc: docs/superpowers/plans/2026-09-16-phase3-formulary-adoption.md §1 (owner ruling
-- 2026-09-16: every pending release substance is decided under one named resolution).
--
-- `adopted_under` names that resolution on each decision adopted in bulk. It is null for a decision a
-- person made on the worklist, and a pharmacist's later correction clears it. The check keeps a
-- pending row from carrying one. Additive and nullable: every existing row is a person's decision or
-- pending, so null is correct for all of them and nothing is backfilled.
ALTER TABLE "formulary_substances" ADD COLUMN "adopted_under" text;--> statement-breakpoint
ALTER TABLE "formulary_substances" ADD CONSTRAINT "formulary_substances_adopted_decided_ck" CHECK ("formulary_substances"."adopted_under" is null or "formulary_substances"."mapping_status" <> 'pending');