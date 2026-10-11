CREATE TABLE "copilot_acts" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text NOT NULL,
	"tool" text NOT NULL,
	"subject_patient_id" text,
	"args_hash" text NOT NULL,
	"proposal_id" text NOT NULL,
	"confirm_id" text NOT NULL,
	"result_module" text,
	"result_row_id" text,
	CONSTRAINT "copilot_acts_confirm_ck" CHECK (length("copilot_acts"."confirm_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "copilot_asks" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"outcome" text NOT NULL,
	"route" text NOT NULL,
	"intent" text,
	"answer_key" text,
	"ms" integer NOT NULL,
	"masked_question" text,
	"screen" text,
	"source" text,
	CONSTRAINT "copilot_asks_outcome_ck" CHECK ("copilot_asks"."outcome" in ('answered', 'notUnderstood', 'noTool', 'notPermitted', 'needSubject', 'failed', 'identifierLeak', 'refusedActor', 'badRequest', 'error', 'halted')),
	CONSTRAINT "copilot_asks_route_ck" CHECK ("copilot_asks"."route" in ('phrasebook', 'chooser', 'model', 'none')),
	CONSTRAINT "copilot_asks_source_ck" CHECK ("copilot_asks"."source" is null or "copilot_asks"."source" in ('chip', 'typed')),
	CONSTRAINT "copilot_asks_ms_ck" CHECK ("copilot_asks"."ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "copilot_notice_acks" (
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copilot_notice_acks_pkey" PRIMARY KEY("user_id","version")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "copilot_acts_confirm_ux" ON "copilot_acts" USING btree ("confirm_id");--> statement-breakpoint
CREATE INDEX "copilot_acts_at_idx" ON "copilot_acts" USING btree ("at");--> statement-breakpoint
CREATE INDEX "copilot_asks_at_idx" ON "copilot_asks" USING btree ("at");--> statement-breakpoint
-- E0.1 — `copilot_acts` is kept as long as the record it changed: no UPDATE, no DELETE, ever (G6b).
CREATE OR REPLACE FUNCTION copilot_acts_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_append_only: copilot_acts rows are append-only (% refused, id %)', TG_OP, OLD.id;
END $$;--> statement-breakpoint
CREATE TRIGGER copilot_acts_append_only
  BEFORE UPDATE OR DELETE ON "copilot_acts"
  FOR EACH ROW EXECUTE FUNCTION copilot_acts_forbid_mutation();--> statement-breakpoint
-- E0.1 — `copilot_asks` keeps 180 days. UPDATE is refused; DELETE only from the retention prune
-- (`hmis.retention_prune = 'copilot_asks'`, transaction-local) and only for rows older than 179 days
-- by the database's clock — the `phi_access_log` door (migration 0139), one day of skew margin.
CREATE OR REPLACE FUNCTION copilot_asks_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('hmis.retention_prune', true) = 'copilot_asks'
     AND OLD."at" < now() - interval '179 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_append_only: copilot_asks rows are append-only (% refused, id %) — only the retention prune deletes, and only rows older than 179 days', TG_OP, OLD.id;
END $$;--> statement-breakpoint
CREATE TRIGGER copilot_asks_append_only
  BEFORE UPDATE OR DELETE ON "copilot_asks"
  FOR EACH ROW EXECUTE FUNCTION copilot_asks_forbid_mutation();
