-- Spec #1046 (owner 2026-11-13, ruling 0093) — the pharmacy counter goes live. Additive: new nullable columns,
-- widened checks, and the live-prescription index re-made so a balance ticket does not collide with its source.
--   D1  pharmacy_dispenses.collected_by / collector_name / collector_relation; identity_confirmed_via may be 'collected_by'.
--   D6  pharmacy_dispense_lines.owed_qty_base; pharmacy_dispenses.balance_of (one live balance per source).
--   D7  pharmacy_authorisations.book may be 'substitution' (an H/H1 brand swap the prescriber agrees to).
ALTER TABLE "pharmacy_authorisations" DROP CONSTRAINT "pharmacy_authorisations_book_ck";--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" DROP CONSTRAINT "pharmacy_dispenses_identity_ck";--> statement-breakpoint
DROP INDEX "pharmacy_dispenses_live_rx_ux";--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD COLUMN "owed_qty_base" integer;--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD COLUMN "collected_by" text;--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD COLUMN "collector_name" text;--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD COLUMN "collector_relation" text;--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD COLUMN "balance_of" text;--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD CONSTRAINT "pharmacy_dispenses_balance_of_pharmacy_dispenses_id_fk" FOREIGN KEY ("balance_of") REFERENCES "public"."pharmacy_dispenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_dispenses_live_balance_ux" ON "pharmacy_dispenses" USING btree ("balance_of") WHERE "pharmacy_dispenses"."status" <> 'cancelled' and "pharmacy_dispenses"."balance_of" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_dispenses_live_rx_ux" ON "pharmacy_dispenses" USING btree ("prescription_id","prescription_version") WHERE "pharmacy_dispenses"."status" <> 'cancelled' and "pharmacy_dispenses"."balance_of" is null;--> statement-breakpoint
ALTER TABLE "pharmacy_authorisations" ADD CONSTRAINT "pharmacy_authorisations_book_ck" CHECK ("pharmacy_authorisations"."book" in ('allergy', 'interaction', 'duplicate', 'drug_disease', 'substitution'));--> statement-breakpoint
ALTER TABLE "pharmacy_dispense_lines" ADD CONSTRAINT "pharmacy_dispense_lines_owed_ck" CHECK ("pharmacy_dispense_lines"."owed_qty_base" is null or "pharmacy_dispense_lines"."owed_qty_base" > 0);--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD CONSTRAINT "pharmacy_dispenses_collected_ck" CHECK (("pharmacy_dispenses"."collected_by" is null and "pharmacy_dispenses"."collector_name" is null and "pharmacy_dispenses"."collector_relation" is null)
        or ("pharmacy_dispenses"."collected_by" = 'self' and "pharmacy_dispenses"."collector_name" is null and "pharmacy_dispenses"."collector_relation" is null)
        or ("pharmacy_dispenses"."collected_by" = 'attendant' and btrim("pharmacy_dispenses"."collector_name") <> '' and "pharmacy_dispenses"."collector_relation" is not null));--> statement-breakpoint
ALTER TABLE "pharmacy_dispenses" ADD CONSTRAINT "pharmacy_dispenses_identity_ck" CHECK ("pharmacy_dispenses"."identity_confirmed_via" is null or "pharmacy_dispenses"."identity_confirmed_via" in ('token', 'phone_last4', 'collected_by'));