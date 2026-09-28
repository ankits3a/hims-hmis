CREATE TABLE "pharmacy_adr_events" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"kind" text NOT NULL,
	"causality" text,
	"sent_on" date,
	"channel" text,
	"pvpi_ref" text,
	"note" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pharmacy_adr_events_kind_ck" CHECK (kind in ('causality_assessed', 'sent_to_pvpi', 'closed')),
	CONSTRAINT "pharmacy_adr_events_causality_ck" CHECK ((kind = 'causality_assessed') = (causality is not null) and (causality is null or causality in ('certain', 'probable', 'possible', 'unlikely', 'conditional', 'unclassifiable'))),
	CONSTRAINT "pharmacy_adr_events_sent_ck" CHECK ((kind = 'sent_to_pvpi') = (sent_on is not null and channel is not null) and (channel is null or channel in ('amc', 'pvpi_app', 'email')) and (kind = 'sent_to_pvpi' or pvpi_ref is null))
);
--> statement-breakpoint
CREATE TABLE "pharmacy_adr_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"patient_id" text NOT NULL,
	"reaction" text NOT NULL,
	"onset_date" date NOT NULL,
	"recovery_date" date,
	"seriousness" text NOT NULL,
	"outcome" text NOT NULL,
	"dechallenge" text NOT NULL,
	"rechallenge" text NOT NULL,
	"weight_kg" numeric(5, 1),
	"concomitants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"relevant_tests" text,
	"relevant_history" text,
	"reported_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pharmacy_adr_reports_seriousness_ck" CHECK (seriousness in ('death', 'life_threatening', 'hospitalisation', 'disability', 'congenital_anomaly', 'other_medically_important', 'not_serious')),
	CONSTRAINT "pharmacy_adr_reports_outcome_ck" CHECK (outcome in ('recovered', 'recovering', 'not_recovered', 'fatal', 'unknown')),
	CONSTRAINT "pharmacy_adr_reports_dechallenge_ck" CHECK (dechallenge in ('yes', 'no', 'unknown', 'na')),
	CONSTRAINT "pharmacy_adr_reports_rechallenge_ck" CHECK (rechallenge in ('yes', 'no', 'unknown', 'na')),
	CONSTRAINT "pharmacy_adr_reports_reaction_ck" CHECK (btrim("pharmacy_adr_reports"."reaction") <> ''),
	CONSTRAINT "pharmacy_adr_reports_recovery_ck" CHECK ("pharmacy_adr_reports"."recovery_date" is null or "pharmacy_adr_reports"."recovery_date" >= "pharmacy_adr_reports"."onset_date"),
	CONSTRAINT "pharmacy_adr_reports_concomitants_ck" CHECK (jsonb_typeof("pharmacy_adr_reports"."concomitants") = 'array')
);
--> statement-breakpoint
CREATE TABLE "pharmacy_adr_suspects" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"position" integer NOT NULL,
	"salt_id" text,
	"name" text NOT NULL,
	"item_id" text,
	"batch_no" text,
	"manufacturer" text,
	"dose" text,
	"route" text,
	"frequency" text,
	"indication" text,
	"start_date" date,
	"stop_date" date,
	"dispense_id" text,
	"allergy_id" text NOT NULL,
	CONSTRAINT "pharmacy_adr_suspects_name_ck" CHECK (btrim("pharmacy_adr_suspects"."name") <> ''),
	CONSTRAINT "pharmacy_adr_suspects_dates_ck" CHECK ("pharmacy_adr_suspects"."stop_date" is null or "pharmacy_adr_suspects"."start_date" is null or "pharmacy_adr_suspects"."stop_date" >= "pharmacy_adr_suspects"."start_date")
);
--> statement-breakpoint
ALTER TABLE "pharmacy_adr_events" ADD CONSTRAINT "pharmacy_adr_events_report_id_pharmacy_adr_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."pharmacy_adr_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_adr_events" ADD CONSTRAINT "pharmacy_adr_events_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_adr_reports" ADD CONSTRAINT "pharmacy_adr_reports_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_adr_reports" ADD CONSTRAINT "pharmacy_adr_reports_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_adr_suspects" ADD CONSTRAINT "pharmacy_adr_suspects_report_id_pharmacy_adr_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."pharmacy_adr_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_adr_suspects" ADD CONSTRAINT "pharmacy_adr_suspects_salt_id_formulary_salts_id_fk" FOREIGN KEY ("salt_id") REFERENCES "public"."formulary_salts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_adr_suspects" ADD CONSTRAINT "pharmacy_adr_suspects_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_adr_suspects" ADD CONSTRAINT "pharmacy_adr_suspects_dispense_id_pharmacy_dispenses_id_fk" FOREIGN KEY ("dispense_id") REFERENCES "public"."pharmacy_dispenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_adr_suspects" ADD CONSTRAINT "pharmacy_adr_suspects_allergy_id_patient_allergies_id_fk" FOREIGN KEY ("allergy_id") REFERENCES "public"."patient_allergies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pharmacy_adr_events_report_idx" ON "pharmacy_adr_events" USING btree ("report_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_adr_events_sent_ux" ON "pharmacy_adr_events" USING btree ("report_id") WHERE kind = 'sent_to_pvpi';--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_adr_events_closed_ux" ON "pharmacy_adr_events" USING btree ("report_id") WHERE kind = 'closed';--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_adr_reports_seq_ux" ON "pharmacy_adr_reports" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "pharmacy_adr_reports_patient_idx" ON "pharmacy_adr_reports" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "pharmacy_adr_reports_created_idx" ON "pharmacy_adr_reports" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_adr_suspects_position_ux" ON "pharmacy_adr_suspects" USING btree ("report_id","position");--> statement-breakpoint
-- ═══ PHARMACY STAGE D1 — THE ADR REGISTER IS APPEND-ONLY, HAND-CARRIED (drizzle-kit emits no triggers) ═══
--
-- NABH MOM and PvPI: a reported adverse drug reaction is a record, not a draft. A later act (causality,
-- sent to PvPI, closed) is a new `pharmacy_adr_events` row; a wrong report is answered by a further row,
-- never by an edit. The `pharmacy_reg_h1_immutable` shape (0056), one function for the three tables.
CREATE OR REPLACE FUNCTION pharmacy_adr_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy_adr_immutable: a % row may not be deleted (id %)', TG_TABLE_NAME, OLD.id;
  END IF;
  RAISE EXCEPTION 'pharmacy_adr_immutable: a % row may not be edited (id %) — a later act is a new event row, never an edit', TG_TABLE_NAME, OLD.id;
END $$;--> statement-breakpoint
CREATE TRIGGER pharmacy_adr_reports_immutable
  BEFORE UPDATE OR DELETE ON pharmacy_adr_reports
  FOR EACH ROW
  EXECUTE FUNCTION pharmacy_adr_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER pharmacy_adr_suspects_immutable
  BEFORE UPDATE OR DELETE ON pharmacy_adr_suspects
  FOR EACH ROW
  EXECUTE FUNCTION pharmacy_adr_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER pharmacy_adr_events_immutable
  BEFORE UPDATE OR DELETE ON pharmacy_adr_events
  FOR EACH ROW
  EXECUTE FUNCTION pharmacy_adr_forbid_mutation();
