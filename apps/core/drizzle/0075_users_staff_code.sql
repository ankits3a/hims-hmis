-- FD-29 — the staff id (owner, 2026-09-06: "We should have staff-ID in the schema").
--
-- Generated as a bare `ADD COLUMN "staff_code" text NOT NULL`, which is correct for an empty table
-- and FAILS on every database that already has a user in it — production has sixteen, and locking
-- every one of them out of a NOT NULL they cannot satisfy is not a migration, it is an outage.
-- Add nullable, number everyone, then make it required.
--
-- ORDERED BY `created_at`, tie-broken by `id`: the numbers then follow the order the hospital
-- actually onboarded its people, and a re-run cannot renumber them differently.
ALTER TABLE "users" ADD COLUMN "staff_code" text;--> statement-breakpoint

UPDATE "users" AS u
SET "staff_code" = n.assigned
FROM (
  SELECT "id", 'EMP-' || lpad(row_number() OVER (ORDER BY "created_at", "id")::text, 4, '0') AS assigned
  FROM "users"
) AS n
WHERE u."id" = n."id" AND u."staff_code" IS NULL;--> statement-breakpoint

ALTER TABLE "users" ALTER COLUMN "staff_code" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_staff_code_ux" ON "users" USING btree ("staff_code");
