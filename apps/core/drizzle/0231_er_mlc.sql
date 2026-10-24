CREATE TABLE "er_mlc_addenda" (
	"id" text PRIMARY KEY NOT NULL,
	"mlc_id" text NOT NULL,
	"text" text NOT NULL,
	"category" text,
	"examination_refused" boolean NOT NULL,
	"injuries" jsonb NOT NULL,
	"author_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "er_mlc_addenda_category_ck" CHECK ("er_mlc_addenda"."category" is null or "er_mlc_addenda"."category" in ('assault', 'road_accident', 'burns', 'acid_attack', 'poisoning', 'hanging', 'drowning', 'fall_from_height', 'bite_dispute', 'unknown_unconscious', 'sexual_assault', 'brought_dead', 'death_within_24h_injury', 'police_brought', 'other'))
);
--> statement-breakpoint
CREATE TABLE "er_mlc_custody" (
	"id" text PRIMARY KEY NOT NULL,
	"mlc_id" text NOT NULL,
	"link" integer NOT NULL,
	"kind" text NOT NULL,
	"evidence_kind" text,
	"description" text,
	"seal_no" text,
	"action" text NOT NULL,
	"items" jsonb,
	"kept_in" jsonb,
	"receiver" jsonb,
	"recorded_by" text NOT NULL,
	"witnessed_by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "er_mlc_custody_kind_ck" CHECK ("er_mlc_custody"."kind" in ('belongings', 'evidence')),
	CONSTRAINT "er_mlc_custody_action_ck" CHECK (("er_mlc_custody"."kind" = 'belongings' and "er_mlc_custody"."action" = 'listed') or ("er_mlc_custody"."kind" = 'evidence' and "er_mlc_custody"."action" in ('collected', 'stored', 'handed_over') and "er_mlc_custody"."seal_no" is not null)),
	CONSTRAINT "er_mlc_custody_receiver_ck" CHECK (("er_mlc_custody"."action" = 'handed_over') = ("er_mlc_custody"."receiver" is not null)),
	CONSTRAINT "er_mlc_custody_witness_ck" CHECK ("er_mlc_custody"."witnessed_by" <> "er_mlc_custody"."recorded_by")
);
--> statement-breakpoint
CREATE TABLE "er_mlc_intimations" (
	"id" text PRIMARY KEY NOT NULL,
	"mlc_id" text NOT NULL,
	"mode" text NOT NULL,
	"station" text NOT NULL,
	"receiver_name" text NOT NULL,
	"receiver_rank" text,
	"gd_entry_no" text,
	"intimated_at" timestamp with time zone NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "er_mlc_intimations_mode_ck" CHECK ("er_mlc_intimations"."mode" in ('written', 'phone_then_written', 'police_present'))
);
--> statement-breakpoint
CREATE TABLE "er_mlc_obligations" (
	"id" text PRIMARY KEY NOT NULL,
	"mlc_id" text NOT NULL,
	"kind" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"met_at" timestamp with time zone,
	"met_by" text,
	"task_id" text,
	"climbed_at" timestamp with time zone,
	"breached_at" timestamp with time zone,
	CONSTRAINT "er_mlc_obligations_kind_ck" CHECK ("er_mlc_obligations"."kind" in ('police_intimation', 'faculty_countersign')),
	CONSTRAINT "er_mlc_obligations_met_ck" CHECK (("er_mlc_obligations"."met_at" is null) = ("er_mlc_obligations"."met_by" is null))
);
--> statement-breakpoint
CREATE TABLE "er_mlcs" (
	"id" text PRIMARY KEY NOT NULL,
	"mlc_no" text NOT NULL,
	"mlc_year" integer NOT NULL,
	"mlc_serial" integer NOT NULL,
	"episode_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"category" text NOT NULL,
	"informant" jsonb,
	"injuries" jsonb NOT NULL,
	"pocso" boolean NOT NULL,
	"free_by_law" boolean NOT NULL,
	"opened_by" text NOT NULL,
	"opened_by_rule" boolean NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"late" boolean NOT NULL,
	"provenance" text NOT NULL,
	CONSTRAINT "er_mlcs_category_ck" CHECK ("er_mlcs"."category" in ('assault', 'road_accident', 'burns', 'acid_attack', 'poisoning', 'hanging', 'drowning', 'fall_from_height', 'bite_dispute', 'unknown_unconscious', 'sexual_assault', 'brought_dead', 'death_within_24h_injury', 'police_brought', 'other'))
);
--> statement-breakpoint
ALTER TABLE "roster_escalation_targets" DROP CONSTRAINT "roster_escalation_targets_kind_ck";--> statement-breakpoint
ALTER TABLE "ipd_mortuary_register" ALTER COLUMN "admission_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "death_kind" text;--> statement-breakpoint
ALTER TABLE "ipd_mortuary_register" ADD COLUMN "er_episode_id" text;--> statement-breakpoint
ALTER TABLE "er_mlc_addenda" ADD CONSTRAINT "er_mlc_addenda_mlc_id_er_mlcs_id_fk" FOREIGN KEY ("mlc_id") REFERENCES "public"."er_mlcs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_mlc_custody" ADD CONSTRAINT "er_mlc_custody_mlc_id_er_mlcs_id_fk" FOREIGN KEY ("mlc_id") REFERENCES "public"."er_mlcs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_mlc_intimations" ADD CONSTRAINT "er_mlc_intimations_mlc_id_er_mlcs_id_fk" FOREIGN KEY ("mlc_id") REFERENCES "public"."er_mlcs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_mlc_obligations" ADD CONSTRAINT "er_mlc_obligations_mlc_id_er_mlcs_id_fk" FOREIGN KEY ("mlc_id") REFERENCES "public"."er_mlcs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_mlcs" ADD CONSTRAINT "er_mlcs_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_mlcs" ADD CONSTRAINT "er_mlcs_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "er_mlc_addenda_mlc_idx" ON "er_mlc_addenda" USING btree ("mlc_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "er_mlc_custody_link_ux" ON "er_mlc_custody" USING btree ("mlc_id","link");--> statement-breakpoint
CREATE INDEX "er_mlc_custody_seal_idx" ON "er_mlc_custody" USING btree ("mlc_id","seal_no");--> statement-breakpoint
CREATE UNIQUE INDEX "er_mlc_intimations_mlc_ux" ON "er_mlc_intimations" USING btree ("mlc_id");--> statement-breakpoint
CREATE UNIQUE INDEX "er_mlc_obligations_kind_ux" ON "er_mlc_obligations" USING btree ("mlc_id","kind");--> statement-breakpoint
CREATE INDEX "er_mlc_obligations_owed_idx" ON "er_mlc_obligations" USING btree ("due_at") WHERE "er_mlc_obligations"."met_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "er_mlcs_no_ux" ON "er_mlcs" USING btree ("mlc_no");--> statement-breakpoint
CREATE UNIQUE INDEX "er_mlcs_serial_ux" ON "er_mlcs" USING btree ("mlc_year","mlc_serial");--> statement-breakpoint
CREATE UNIQUE INDEX "er_mlcs_episode_ux" ON "er_mlcs" USING btree ("episode_id");--> statement-breakpoint
CREATE INDEX "er_mlcs_opened_idx" ON "er_mlcs" USING btree ("opened_at");--> statement-breakpoint
ALTER TABLE "ipd_mortuary_register" ADD CONSTRAINT "ipd_mortuary_register_er_episode_id_er_episodes_id_fk" FOREIGN KEY ("er_episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_mortuary_register_er_episode_ux" ON "ipd_mortuary_register" USING btree ("er_episode_id");--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_death_kind_ck" CHECK ("patients"."death_kind" is null or ("patients"."death_kind" = 'brought_dead' and "patients"."deceased_at" is not null));--> statement-breakpoint
ALTER TABLE "roster_escalation_targets" ADD CONSTRAINT "roster_escalation_targets_kind_ck" CHECK ("roster_escalation_targets"."alert_kind" in ('escalation.triggered', 'notification.failed', 'ops.mode_changed', 'imaging.critical_overdue', 'imaging.report_unread', 'workflow.timer_rung', 'er_retriage', 'er_call', 'er_critical', 'mlc_intimation', 'mlc_countersign'));--> statement-breakpoint
ALTER TABLE "ipd_mortuary_register" ADD CONSTRAINT "ipd_mortuary_register_holder_ck" CHECK (("ipd_mortuary_register"."admission_id" is null) <> ("ipd_mortuary_register"."er_episode_id" is null));--> statement-breakpoint
CREATE FUNCTION er_mlc_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'er_mlc_append_only: % rows are never edited or deleted (% refused); a correction is an addendum', TG_TABLE_NAME, TG_OP; END $$;--> statement-breakpoint
CREATE TRIGGER er_mlcs_append_only BEFORE UPDATE OR DELETE ON er_mlcs FOR EACH ROW EXECUTE FUNCTION er_mlc_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER er_mlc_addenda_append_only BEFORE UPDATE OR DELETE ON er_mlc_addenda FOR EACH ROW EXECUTE FUNCTION er_mlc_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER er_mlc_intimations_append_only BEFORE UPDATE OR DELETE ON er_mlc_intimations FOR EACH ROW EXECUTE FUNCTION er_mlc_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER er_mlc_custody_append_only BEFORE UPDATE OR DELETE ON er_mlc_custody FOR EACH ROW EXECUTE FUNCTION er_mlc_forbid_mutation();--> statement-breakpoint
CREATE FUNCTION er_mlc_obligation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'er_mlc_append_only: er_mlc_obligations rows are never deleted'; END IF;
  IF NEW.mlc_id IS DISTINCT FROM OLD.mlc_id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.due_at IS DISTINCT FROM OLD.due_at
     OR (OLD.met_at IS NOT NULL AND NEW.met_at IS DISTINCT FROM OLD.met_at)
     OR (OLD.met_by IS NOT NULL AND NEW.met_by IS DISTINCT FROM OLD.met_by)
     OR (OLD.task_id IS NOT NULL AND NEW.task_id IS DISTINCT FROM OLD.task_id)
     OR (OLD.climbed_at IS NOT NULL AND NEW.climbed_at IS DISTINCT FROM OLD.climbed_at)
     OR (OLD.breached_at IS NOT NULL AND NEW.breached_at IS DISTINCT FROM OLD.breached_at) THEN
    RAISE EXCEPTION 'er_mlc_append_only: an obligation''s case, kind, due time and stamps are written once';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER er_mlc_obligations_write_once BEFORE UPDATE OR DELETE ON er_mlc_obligations FOR EACH ROW EXECUTE FUNCTION er_mlc_obligation_guard();
