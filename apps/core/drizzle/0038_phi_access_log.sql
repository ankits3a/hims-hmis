-- PLAN 07a T2 — THE PHI ACCESS LOG: who READ a patient's record, and how they were connected to
-- that patient's care at the time. Reads were the one thing this system did not record: before
-- this table the only access ever written was a click-through from the command palette.
--
-- NOTE ON WHAT WAS REMOVED FROM THE GENERATED FILE. `drizzle-kit` also emitted a DROP and re-ADD
-- of `ot_incidents_kind_ck`. That is not this migration's business: `0037` widened that constraint
-- in hand-written SQL and did not regenerate its snapshot, so every generate since has re-proposed
-- DDL the database already has. The redundant statements are removed here — every database runs
-- `0037` before this file, so the constraint is already correct in all of them — while
-- `0038_snapshot.json` KEEPS the widened definition, which is what repairs the drift so the next
-- author does not meet it again. Nothing about `ot_incidents` changes when this migration runs.

CREATE TABLE "phi_access_log" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"actor_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"patient_id" text NOT NULL,
	"surface" text NOT NULL,
	"encounter_id" text,
	"context" text NOT NULL,
	"sealed" boolean DEFAULT false NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "phi_access_log_patient_at_idx" ON "phi_access_log" USING btree ("patient_id","at");
--> statement-breakpoint
CREATE INDEX "phi_access_log_actor_at_idx" ON "phi_access_log" USING btree ("actor_id","at");
--> statement-breakpoint
CREATE INDEX "phi_access_log_context_at_idx" ON "phi_access_log" USING btree ("context","at");
