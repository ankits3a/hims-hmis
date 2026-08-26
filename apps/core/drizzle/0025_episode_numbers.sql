-- EPISODE NUMBERS — the V/A/L/S/R/P grammar (owner ruling 2026-08-25).
--
-- `<letter><YYMMDD><4-digit daily serial>`: V2608250147 for a visit, A2608250042 for an
-- appointment. The reasoning lives in kernel/db/schema/episodes.ts and kernel/episodes/series.ts.
-- Only `visit` and `appointment` are ALLOCATED here; L/S/R/P are reserved in the code vocabulary
-- so that the lab, radiology and pharmacy plans inherit this grammar instead of inventing one
-- each. They need no schema until those modules exist — the series table is keyed by string.
--
-- DRIZZLE'S GENERATED DDL WAS NOT USABLE AS-IS and the difference is the whole migration:
-- `ADD COLUMN ... NOT NULL` with no default fails outright on any table that already holds rows,
-- and both of these do (production is carrying synthetic OPD history). The column therefore
-- arrives nullable, is backfilled deterministically, and only then takes its constraints.

CREATE TABLE "episode_series" (
	"series_key" text NOT NULL,
	"service_date" date NOT NULL,
	"next_no" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "episode_series_series_key_service_date_pk" PRIMARY KEY("series_key","service_date")
);--> statement-breakpoint

ALTER TABLE "opd_appointments" ADD COLUMN "appointment_no" text;--> statement-breakpoint
ALTER TABLE "opd_encounters" ADD COLUMN "visit_no" text;--> statement-breakpoint

-- The backfill cannot express a 10,000th document in one day, and neither can the format. Refuse
-- the migration rather than write a five-digit serial that `formatEpisodeNo` would then reject
-- for the life of the row — the same guard the allocator carries, applied to history.
DO $$
DECLARE worst integer;
BEGIN
  SELECT max(c) INTO worst FROM (SELECT count(*) AS c FROM opd_encounters GROUP BY service_date) s;
  IF coalesce(worst, 0) > 9999 THEN
    RAISE EXCEPTION 'opd_encounters has % rows on a single service_date; the 4-digit daily serial cannot number them', worst;
  END IF;
  SELECT max(c) INTO worst FROM (SELECT count(*) AS c FROM opd_appointments GROUP BY service_date) s;
  IF coalesce(worst, 0) > 9999 THEN
    RAISE EXCEPTION 'opd_appointments has % rows on a single service_date; the 4-digit daily serial cannot number them', worst;
  END IF;
END $$;--> statement-breakpoint

-- Deterministic and computable in pure SQL — unlike the UHID re-mint next door, which needed a
-- script because a Verhoeff check digit is not something to transcribe into plpgsql. There is no
-- check digit here: an episode number is read off a form beside its patient's UHID, and the UHID
-- is the identifier a typo must not be allowed to land on someone else.
-- Ordered by the row's own creation instant so the backfilled numbers agree with the order the
-- desk actually worked that day; `id` breaks ties (ULIDs are monotonic, so this is stable).
UPDATE opd_encounters e
   SET visit_no = 'V' || to_char(e.service_date, 'YYMMDD') || lpad(r.rn::text, 4, '0')
  FROM (SELECT id, row_number() OVER (PARTITION BY service_date ORDER BY opened_at, id) AS rn
          FROM opd_encounters) r
 WHERE r.id = e.id;--> statement-breakpoint

UPDATE opd_appointments a
   SET appointment_no = 'A' || to_char(a.service_date, 'YYMMDD') || lpad(r.rn::text, 4, '0')
  FROM (SELECT id, row_number() OVER (PARTITION BY service_date ORDER BY booked_at, id) AS rn
          FROM opd_appointments) r
 WHERE r.id = a.id;--> statement-breakpoint

-- AND THE COUNTERS MUST BE MOVED PAST THE BACKFILL, or the first visit opened on a date that
-- already has history collides with it on the unique index below and registration fails at the
-- counter. `count(*) + 1` is exactly right against the allocator's post-increment RETURNING:
-- next_no = N+1 means the next number handed out is N+1.
INSERT INTO episode_series (series_key, service_date, next_no)
SELECT 'visit', service_date, count(*) + 1 FROM opd_encounters GROUP BY service_date
ON CONFLICT (series_key, service_date) DO NOTHING;--> statement-breakpoint

INSERT INTO episode_series (series_key, service_date, next_no)
SELECT 'appointment', service_date, count(*) + 1 FROM opd_appointments GROUP BY service_date
ON CONFLICT (series_key, service_date) DO NOTHING;--> statement-breakpoint

ALTER TABLE "opd_appointments" ALTER COLUMN "appointment_no" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "opd_encounters" ALTER COLUMN "visit_no" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "opd_appointments_appointment_no_ux" ON "opd_appointments" USING btree ("appointment_no");--> statement-breakpoint
CREATE UNIQUE INDEX "opd_encounters_visit_no_ux" ON "opd_encounters" USING btree ("visit_no");
