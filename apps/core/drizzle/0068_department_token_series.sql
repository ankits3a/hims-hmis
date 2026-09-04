-- FD-20 / OWNER RULING (2026-09-04): the token series belongs to the DEPARTMENT, not the doctor.
--
-- *"the token number should be not according to the doctor but Department. For Example it should be
-- 'MED - 4', 'PED - 290'."*
--
-- This is what `opd_departments.code` was always for. Its own schema comment has read "short stable
-- code, e.g. 'MED', 'PED' — printed on token slips" since the column was written, and nothing ever
-- printed one.
--
-- WHY THE COUNTER MOVES. `opd_queue_sessions.next_token` is a DOCTOR-DAY counter, so three doctors
-- sitting in Medicine each issued a token 1: the hall heard "number four" called three times, for
-- three different people, and a patient holding a slip could not tell which was theirs. The series
-- has to be counted where it is issued — one per department per day.
--
-- ADDITIVE. `opd_queue_sessions.next_token` is left exactly where it is: every existing row keeps
-- the number it was given and keeps meaning what it meant. Nothing reads that column after this
-- change, and dropping it would rewrite history for no gain.
--
-- NOT BACKFILLED, DELIBERATELY. Today's already-issued tokens were doctor-scoped and re-numbering
-- them would change a number a patient is physically holding on a slip. The series starts fresh:
-- rows created from here take department numbers, and yesterday's stay as they were.
CREATE TABLE IF NOT EXISTS "opd_department_tokens" (
  "department_id" text NOT NULL REFERENCES "opd_departments"("id"),
  "service_date" date NOT NULL,
  "next_token" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "opd_department_tokens_pk" PRIMARY KEY ("department_id", "service_date")
);
