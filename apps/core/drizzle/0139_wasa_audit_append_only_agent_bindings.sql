-- WASA wave 3b — M-07 (audit tables append-only), M-10 (print claim bound to the relay's own
-- destinations), L-08 (an interface heartbeat bound to the device's own agent).
--
-- THE FIRST THREE STATEMENTS ARE drizzle-kit's; EVERYTHING AFTER THEM IS HAND-WRITTEN. A renumber
-- that REGENERATES this file reproduces only the three ALTERs — the backfill and the four trigger
-- statements are not schema state and cannot come back from a snapshot diff. Copy them across.
--
-- Additive only: two defaulted/nullable columns, one FK, one backfill, two functions, two triggers.
ALTER TABLE "agents" ADD COLUMN "print_destinations" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "interfaces" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "interfaces" ADD CONSTRAINT "interfaces_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ═══ WASA M-10 BACKFILL — WHO KEEPS PRINTING THE MORNING THIS DEPLOYS ═══
--
-- Until now any agent key could claim any destination. The new column defaults to NO destinations,
-- which is right for every future agent and wrong for the relay already printing at the counter.
-- DECIDED (the least surprising default): an agent that has CLAIMED at least one job still on
-- record (`print_jobs.claimed_by`; printed rows keep it for the 90-day print-job window) is a
-- working relay, and keeps being served everything it could be served yesterday — every
-- destination declared today (`PRINT_DESTINATIONS`: front_desk_a4, front_desk_thermal,
-- pharmacy_thermal, vitals_thermal) plus any older destination its history shows. An agent with no
-- claim on record gets NOTHING: that is exactly the lab-bridge / leaked-key case the finding is
-- about, and a relay installed but never yet run is told so loudly (403
-- `print_relay_not_registered`) on its first poll.
--
-- WHY NOT "ONLY THE DESTINATIONS IN ITS HISTORY": history is pruned at 90 days, so a destination
-- printed rarely (the A4 glasses sheet) could be missing, and that relay would silently stop
-- printing it after the deploy. Narrowing is an operator act with the relay's config in hand:
-- `scripts/set-agent-print-destinations.ts` (docs/runbooks/wasa-database-roles.md §4).
--
-- Idempotent (the UNION recomputes the same set), so re-running it is harmless.
UPDATE "agents" AS a
SET "print_destinations" = (
  SELECT array_agg(g.d ORDER BY g.d)
  FROM (
    SELECT unnest(ARRAY['front_desk_a4', 'front_desk_thermal', 'pharmacy_thermal', 'vitals_thermal']::text[]) AS d
    UNION
    SELECT pj."destination" FROM "print_jobs" AS pj WHERE pj."claimed_by" = a."id"
  ) AS g
)
WHERE EXISTS (SELECT 1 FROM "print_jobs" AS pj WHERE pj."claimed_by" = a."id");--> statement-breakpoint

-- ═══ WASA M-07 — `events` IS APPEND-ONLY ═══
--
-- The `0012` / `0044` / `0135` pattern: a BEFORE UPDATE OR DELETE row trigger that raises. On the
-- partitioned parent, Postgres (13+) clones it onto every partition — the months that exist now,
-- `events_default`, and every month `createEventPartitions` creates later.
--
-- NO EXCEPTION IS NEEDED FOR RETENTION: the retention sweep removes events ONLY by dropping a whole
-- month (`DROP TABLE events_YYYY_MM`, `kernel/retention/sweep.ts`), and DDL fires no row trigger.
-- No UPDATE or DELETE of `events` exists anywhere in src/, scripts/ or test/. TRUNCATE (the test
-- harness's `truncateAll`) fires no row trigger either. Neither DROP nor TRUNCATE is stopped by
-- this — that is the job of the non-owner `hmis_app` role (docs/runbooks/wasa-database-roles.md).
CREATE OR REPLACE FUNCTION audit_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_append_only: % rows are append-only (% refused) — the audit trail is corrected by a further row, never by an edit', TG_TABLE_NAME, TG_OP;
END $$;--> statement-breakpoint
CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON "events"
  FOR EACH ROW EXECUTE FUNCTION audit_forbid_mutation();--> statement-breakpoint

-- ═══ WASA M-07 — `phi_access_log` IS APPEND-ONLY, WITH ONE DOOR: THE RETENTION PRUNE ═══
--
-- `prunePhiAccessLog` (kernel/phi/audit.ts) deletes rows older than PHI_ACCESS_RETAIN_DAYS (1095),
-- legal-hold clamped, from the worker's daily retention sweep. That is the ONLY legitimate
-- UPDATE/DELETE of this table in the codebase. The exception is two conditions, BOTH required:
--
--   1. `hmis.retention_prune = 'phi_access_log'` — a TRANSACTION-LOCAL setting the prune sets with
--      `set_config(…, true)` in the same transaction as its DELETE, so it dies at COMMIT/ROLLBACK
--      and never leaks onto a pooled connection. It makes the prune an explicit, named act: a stray
--      `DELETE FROM phi_access_log` is refused even for rows past the window.
--   2. The row is older than 1094 days BY THE DATABASE'S CLOCK. This is the actual protection —
--      any session can set a custom GUC, but nobody below superuser can delete a row younger than
--      three years (less ONE day of margin, so skew between the worker's clock and the database's
--      can never turn a routine prune into a refused statement). Lowering the window is therefore a
--      migration, not a config change.
--
-- UPDATE is refused unconditionally. Under the role split the API role additionally holds no DELETE
-- on this table at all; the prune runs in the worker, as the owner role.
CREATE OR REPLACE FUNCTION phi_access_log_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('hmis.retention_prune', true) = 'phi_access_log'
     AND OLD."at" < now() - interval '1094 days' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_append_only: phi_access_log rows are append-only (DELETE refused, id %) — only the retention prune deletes, and only rows older than 1094 days', OLD.id;
  END IF;
  RAISE EXCEPTION 'audit_append_only: phi_access_log rows are append-only (UPDATE refused, id %)', OLD.id;
END $$;--> statement-breakpoint
CREATE TRIGGER phi_access_log_append_only
  BEFORE UPDATE OR DELETE ON "phi_access_log"
  FOR EACH ROW EXECUTE FUNCTION phi_access_log_forbid_mutation();
