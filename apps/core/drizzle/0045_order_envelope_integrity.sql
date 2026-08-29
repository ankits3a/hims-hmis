-- PLAN 17 PHASE 0 — CLOSE REVIEW REMEDIATION. Two data-integrity holes in `0044`, both found by
-- the independent reviewer and neither reachable through `advanceOrderItem`, which is precisely why
-- they are worth closing: this is a foundation table that five plans will write extensions against,
-- and `0044`'s own CHECKs are the only thing standing between a future direct writer and a row
-- nothing downstream can interpret.
--
-- A FOLLOW-UP MIGRATION RATHER THAN AN EDIT TO `0044`, because `0044` is pushed (`9ba2482`) and
-- AGENT-RULES rule 15 forbids rewriting published history — including history pushed minutes ago.

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_cancelled_shape_ck" CHECK (("order_items"."status" = 'cancelled') = ("order_items"."cancelled_from" is not null));--> statement-breakpoint

-- ══════════ HAND-CARRIED: the identity trigger gains the two ATTRIBUTION columns ══════════
--
-- CLOSE REVIEW (MAJOR 10). `0044`'s trigger froze `order_no`, `kind`, `encounter_no` and
-- `ordered_by_*`, and left `authority` and `external_referrer_id` mutable. Those two ARE the
-- commission ledger's attribution (02 §1), and they move together cleanly:
--
--     UPDATE orders SET authority = 'external_prescription',
--                       external_referrer_id = '<a partner I control>' WHERE id = …
--
-- satisfies `orders_external_referrer_ck`'s biconditional, satisfies `orders_authority_ck`, and was
-- refused by nothing — turning a completed clinician order into a referral fee after the fact, with
-- no audit row anywhere, because `order_item_transitions` records ITEM moves and never header edits.
--
-- `ordering_clinician_id` is deliberately NOT added: it is the responsible clinician and a genuine
-- correction (the wrong doctor was named) has to remain possible. That correction is visible in
-- `updated_by`-style provenance the header does not yet carry, and giving it one is a later plan's
-- decision rather than something to smuggle into a remediation.
CREATE OR REPLACE FUNCTION orders_forbid_identity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."order_no" IS DISTINCT FROM OLD."order_no" THEN
    RAISE EXCEPTION 'order_identity_immutable: orders.order_no cannot change after insert';
  END IF;
  IF NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION 'order_identity_immutable: orders.kind cannot change after insert';
  END IF;
  IF NEW."encounter_no" IS DISTINCT FROM OLD."encounter_no" THEN
    RAISE EXCEPTION 'order_identity_immutable: orders.encounter_no cannot change after insert';
  END IF;
  IF NEW."ordered_by_type" IS DISTINCT FROM OLD."ordered_by_type"
     OR NEW."ordered_by_id" IS DISTINCT FROM OLD."ordered_by_id" THEN
    RAISE EXCEPTION 'order_identity_immutable: orders.ordered_by_* cannot change after insert';
  END IF;
  IF NEW."authority" IS DISTINCT FROM OLD."authority"
     OR NEW."external_referrer_id" IS DISTINCT FROM OLD."external_referrer_id" THEN
    RAISE EXCEPTION 'order_identity_immutable: orders.authority and orders.external_referrer_id are the attribution and cannot change after insert';
  END IF;
  RETURN NEW;
END $$;
