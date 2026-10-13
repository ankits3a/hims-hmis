CREATE TABLE "pass_admission_flags" (
	"admission_id" text PRIMARY KEY NOT NULL,
	"police_custody" boolean DEFAULT false NOT NULL,
	"custody_note" text,
	"visitor_ban_reason" text,
	"visitor_ban_by" text,
	"visitor_ban_at" timestamp with time zone,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pass_events" (
	"id" text PRIMARY KEY NOT NULL,
	"pass_id" text,
	"admission_id" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text,
	"detail" jsonb,
	"actor_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "pass_events_kind_ck" CHECK ("pass_events"."kind" in ('issued', 'revoked', 'expired', 'paused', 'resumed', 'moved', 'custody_set', 'custody_cleared'))
);
--> statement-breakpoint
CREATE TABLE "pass_scans" (
	"id" text PRIMARY KEY NOT NULL,
	"pass_id" text,
	"result" text NOT NULL,
	"ward_id" text,
	"gate" text,
	"scanned_by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "pass_scans_result_ck" CHECK ("pass_scans"."result" in ('valid', 'wrong_ward', 'outside_hours', 'expired', 'revoked', 'paused', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "passes" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"linked_admission_id" text,
	"kind" text NOT NULL,
	"holder_name" text NOT NULL,
	"holder_phone" text,
	"holder_relation" text NOT NULL,
	"token" text NOT NULL,
	"ward_id" text,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"state" text NOT NULL,
	"end_reason" text,
	"ended_at" timestamp with time zone,
	"ended_by" text,
	"pause_reason" text,
	"replaced_by" text,
	"replaces" text,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	CONSTRAINT "passes_kind_ck" CHECK ("passes"."kind" in ('attendant', 'visitor', 'parent_stay', 'nicu_mother', 'police_guard', 'lounge')),
	CONSTRAINT "passes_state_ck" CHECK ("passes"."state" in ('active', 'revoked', 'expired', 'paused')),
	CONSTRAINT "passes_ended_ck" CHECK (("passes"."state" in ('revoked', 'expired')) = ("passes"."ended_at" is not null)),
	CONSTRAINT "passes_token_len_ck" CHECK (length("passes"."token") >= 20)
);
--> statement-breakpoint
ALTER TABLE "pass_admission_flags" ADD CONSTRAINT "pass_admission_flags_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_events" ADD CONSTRAINT "pass_events_pass_id_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass_scans" ADD CONSTRAINT "pass_scans_pass_id_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passes" ADD CONSTRAINT "passes_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passes" ADD CONSTRAINT "passes_linked_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("linked_admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passes" ADD CONSTRAINT "passes_ward_id_resources_id_fk" FOREIGN KEY ("ward_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pass_events_pass_idx" ON "pass_events" USING btree ("pass_id");--> statement-breakpoint
CREATE INDEX "pass_events_admission_idx" ON "pass_events" USING btree ("admission_id","at");--> statement-breakpoint
CREATE INDEX "pass_scans_pass_idx" ON "pass_scans" USING btree ("pass_id","at");--> statement-breakpoint
CREATE INDEX "pass_scans_at_idx" ON "pass_scans" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "passes_token_ux" ON "passes" USING btree ("token");--> statement-breakpoint
CREATE INDEX "passes_admission_idx" ON "passes" USING btree ("admission_id","state");--> statement-breakpoint
CREATE INDEX "passes_linked_admission_idx" ON "passes" USING btree ("linked_admission_id") WHERE "passes"."linked_admission_id" is not null;--> statement-breakpoint
-- E1.3 — a pass's story and every scan at a door are kept as written: no UPDATE, no DELETE, ever.
CREATE OR REPLACE FUNCTION pass_log_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_append_only: % rows are append-only (% refused, id %)', TG_TABLE_NAME, TG_OP, OLD.id;
END $$;--> statement-breakpoint
CREATE TRIGGER pass_events_append_only
  BEFORE UPDATE OR DELETE ON "pass_events"
  FOR EACH ROW EXECUTE FUNCTION pass_log_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER pass_scans_append_only
  BEFORE UPDATE OR DELETE ON "pass_scans"
  FOR EACH ROW EXECUTE FUNCTION pass_log_forbid_mutation();
