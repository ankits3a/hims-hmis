-- PLAN 15 CLOSE REVIEW (MINOR 14) — the incident register gains the two kinds it was already
-- recording under a borrowed name.
--
-- The C-arm radiation dose log and an absconding were both written as `wrong_bay_score`, because the
-- CHECK admitted neither and the real kind was hidden in `detail.kind`. So the register was readable
-- only by opening every row's jsonb, and `select kind, count(*) from ot_incidents group by kind` —
-- the query a quality committee actually runs — reported a fiction. An incident register that cannot
-- be read by kind is not a register.
--
-- Additive: the constraint is widened, never narrowed, so no existing row can fall outside it.
ALTER TABLE "ot_incidents" DROP CONSTRAINT "ot_incidents_kind_ck";--> statement-breakpoint
ALTER TABLE "ot_incidents" ADD CONSTRAINT "ot_incidents_kind_ck" CHECK ("ot_incidents"."kind" in ('identity_mismatch', 'timeout_halted', 'count_mismatch', 'death_on_table', 'wrong_bay_score', 'dose_log', 'absconded'));
