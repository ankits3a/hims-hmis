-- PLAN 18c CLOSE REVIEW — two constraints that did not say what their comments said.
--
-- `aerb_licences_licence_no_unique` was a GLOBAL unique over every row, surrendered ones included,
-- and eLORA renewals routinely keep the licence number. So the ordinary act of renewing a CT's
-- licence hit the constraint and came back a 500, and the register had no route that could record a
-- renewal at all. The rule that was meant is *two machines cannot hold the same LIVE number*, which
-- is what the partial index replacing it says. A surrendered row may reuse its number, which is
-- what a renewal is.
--
-- `aerb_qa_records_block_ck` said `result <> 'pass'`, which is "not a pass" and not "a fail": it
-- admitted a `conditional` row claiming it had blocked a machine. `recordQa` never writes that
-- combination, so no existing row can violate the tightened CHECK — but the constraint is the half
-- that is supposed to hold if the writer is ever weakened, which is the reason the dose register's
-- own index gives for itself.

ALTER TABLE "aerb_licences" DROP CONSTRAINT "aerb_licences_licence_no_unique";--> statement-breakpoint
ALTER TABLE "aerb_qa_records" DROP CONSTRAINT "aerb_qa_records_block_ck";--> statement-breakpoint
CREATE UNIQUE INDEX "aerb_licences_no_active_ux" ON "aerb_licences" USING btree ("licence_no") WHERE "aerb_licences"."status" = 'active';--> statement-breakpoint
ALTER TABLE "aerb_qa_records" ADD CONSTRAINT "aerb_qa_records_block_ck" CHECK ("aerb_qa_records"."block_applied" = false or "aerb_qa_records"."result" = 'fail');