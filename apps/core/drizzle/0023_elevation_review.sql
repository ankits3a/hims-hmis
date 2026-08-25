-- THE EMERGENCY-ELEVATION REVIEW QUEUE — the second half of "loudly evented + mandatory review".
--
-- `emergency_elevation.used` has been emitted since Plan 02; nothing has ever recorded that a
-- human looked at one. `break_glass_grants` carried reviewed_at/reviewed_by/review_note and a
-- pending queue from the same plan, and THIS table — the one that records a person handing
-- THEMSELVES a role — carried none of it.
--
-- ALL THREE COLUMNS ARE NULLABLE AND EVERY EXISTING ROW STAYS NULL, deliberately. A grant taken
-- before this migration genuinely has not been reviewed, so production's existing self-elevations
-- (if any) appear in the queue the moment the queue exists, rather than being back-stamped as
-- reviewed by nobody. There is no backfill and there must not be one.
--
-- The index carries `kind` because this table holds both grant kinds and the queue reads only
-- `kind = 'emergency' and reviewed_at is null` (`pendingElevationReviews`).

ALTER TABLE "temp_role_grants" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "temp_role_grants" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "temp_role_grants" ADD COLUMN "review_note" text;--> statement-breakpoint
CREATE INDEX "temp_role_grants_review_idx" ON "temp_role_grants" USING btree ("kind","reviewed_at");