-- PHARMACY STAGE D5 — the Reserve/restricted antimicrobial approval gate.
-- Two columns on the product: its WHO AWaRe class (null, Access, Watch or Reserve) and whether a line carrying it needs
-- the antimicrobial steward's approval. No classification is written here: `seed:pharmacy` fills nulls from the cited
-- list in modules/formulary/aware.ts. The approval itself is the approvals kernel's row (type
-- pharmacy_restricted_antimicrobial, subject = the dispense and the moiety set), so no table is added.
ALTER TABLE "formulary_medicines" ADD COLUMN "aware_category" text;--> statement-breakpoint
ALTER TABLE "formulary_medicines" ADD COLUMN "antimicrobial_restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "formulary_medicines" ADD CONSTRAINT "formulary_medicines_aware_category_ck" CHECK ("formulary_medicines"."aware_category" is null or "formulary_medicines"."aware_category" in ('Access', 'Watch', 'Reserve'));