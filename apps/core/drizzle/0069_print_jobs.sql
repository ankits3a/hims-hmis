-- FD-24 T1 / OWNER RULING R1 (2026-09-04): printing is SERVER-SIDE.
--
-- The server cannot reach a printer — production is in Helsinki, the printers are on a LAN in
-- Hajipur — so it records an INTENTION to print and a relay inside the hospital claims the row,
-- submits to the local CUPS queue and reports back. This table is that queue.
--
-- Shaped after `notifications`: a unique dedupe key so a double-click or a redelivered event
-- inserts one row, `status` + `next_attempt_at` as the claim predicate, and a separate
-- `(status, updated_at)` index for the retention prune because one index cannot lead on both.
--
-- ADDITIVE. New table, no column touched, nothing dropped.
CREATE TABLE IF NOT EXISTS "print_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "document" text NOT NULL,
  "destination" text NOT NULL,
  "params" jsonb NOT NULL,
  "dedupe_key" text NOT NULL,
  "patient_id" text REFERENCES "patients"("id"),
  "encounter_id" text,
  -- NO FK, deliberately: the enqueue rides the visit's transaction, so a `users` FK here can fail
  -- a VISIT because of a print-audit column. Owner ruling R7 forbids printing blocking the counter.
  -- Caught by test/perf-opd-queue.test.ts before this shipped.
  "requested_by" text,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "next_attempt_at" timestamp with time zone,
  "claimed_at" timestamp with time zone,
  "claimed_by" text,
  "lease_expires_at" timestamp with time zone,
  "printed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "print_jobs_dedupe_key_ux" ON "print_jobs" ("dedupe_key");
CREATE INDEX IF NOT EXISTS "print_jobs_status_next_attempt_idx" ON "print_jobs" ("status", "next_attempt_at");
CREATE INDEX IF NOT EXISTS "print_jobs_lease_idx" ON "print_jobs" ("status", "lease_expires_at");
CREATE INDEX IF NOT EXISTS "print_jobs_status_updated_at_idx" ON "print_jobs" ("status", "updated_at");
CREATE INDEX IF NOT EXISTS "print_jobs_patient_idx" ON "print_jobs" ("patient_id");
