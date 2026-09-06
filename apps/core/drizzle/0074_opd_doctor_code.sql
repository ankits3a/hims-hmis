-- FD-29 — the doctor id the prescription prints (owner, 2026-09-06).
--
-- Generated as a bare `ADD COLUMN "code" text NOT NULL`, which is correct for an empty table and
-- FAILS on every database that already has a doctor in it — production has sixteen. The three
-- statements below are the same change made survivable: add it nullable, give every existing row a
-- number, and only then make it required. Additive, and it drops nothing.
--
-- THE BACKFILL ORDERS BY `created_at`, so the numbers follow the order the hospital actually
-- registered its doctors rather than a ULID's or a name's. `id` breaks a tie, because two doctors
-- created in the same transaction share a timestamp and `row_number()` must still be deterministic —
-- a backfill that numbers differently on a re-run is a backfill nobody can reconcile against paper.
ALTER TABLE "opd_doctors" ADD COLUMN "code" text;--> statement-breakpoint

UPDATE "opd_doctors" AS d
SET "code" = n.assigned
FROM (
  SELECT "id", 'DR-' || lpad(row_number() OVER (ORDER BY "created_at", "id")::text, 4, '0') AS assigned
  FROM "opd_doctors"
) AS n
WHERE d."id" = n."id" AND d."code" IS NULL;--> statement-breakpoint

ALTER TABLE "opd_doctors" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "opd_doctors_code_ux" ON "opd_doctors" USING btree ("code");
