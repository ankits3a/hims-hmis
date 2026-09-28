CREATE TABLE "pharmacy_medication_incident_events" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"kind" text NOT NULL,
	"root_cause" text,
	"action_taken" text,
	"note" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pharmacy_medication_incident_events_kind_ck" CHECK (kind in ('reviewed', 'closed')),
	CONSTRAINT "pharmacy_medication_incident_events_review_ck" CHECK ((kind = 'reviewed') = (root_cause is not null and btrim(root_cause) <> '' and action_taken is not null and btrim(action_taken) <> '')
        and (kind = 'reviewed' or (root_cause is null and action_taken is null)))
);
--> statement-breakpoint
CREATE TABLE "pharmacy_medication_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"kind" text NOT NULL,
	"stage" text NOT NULL,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"patient_id" text,
	"dispense_line_id" text,
	"item_id" text,
	"factors" text[] DEFAULT '{}'::text[] NOT NULL,
	"what_happened" text NOT NULL,
	"reported_by" text NOT NULL,
	"reporter_role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pharmacy_medication_incidents_kind_ck" CHECK (kind in ('near_miss', 'error')),
	CONSTRAINT "pharmacy_medication_incidents_stage_ck" CHECK (stage in ('prescribing', 'transcribing', 'dispensing', 'administration', 'monitoring')),
	CONSTRAINT "pharmacy_medication_incidents_type_ck" CHECK (type in ('wrong_drug', 'wrong_strength', 'wrong_dose', 'wrong_quantity', 'wrong_patient', 'wrong_route', 'expired', 'lasa_mixup', 'omission', 'other')),
	CONSTRAINT "pharmacy_medication_incidents_category_ck" CHECK (category in ('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I')),
	CONSTRAINT "pharmacy_medication_incidents_kind_category_ck" CHECK ((kind = 'near_miss') = (category in ('A', 'B'))),
	CONSTRAINT "pharmacy_medication_incidents_factors_ck" CHECK (factors <@ array['lasa', 'look_alike_packaging', 'illegible_rx', 'workload', 'interruption', 'other']::text[]),
	CONSTRAINT "pharmacy_medication_incidents_what_ck" CHECK (btrim("pharmacy_medication_incidents"."what_happened") <> '')
);
--> statement-breakpoint
ALTER TABLE "pharmacy_medication_incident_events" ADD CONSTRAINT "pharmacy_medication_incident_events_incident_id_pharmacy_medication_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."pharmacy_medication_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_medication_incident_events" ADD CONSTRAINT "pharmacy_medication_incident_events_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_medication_incidents" ADD CONSTRAINT "pharmacy_medication_incidents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_medication_incidents" ADD CONSTRAINT "pharmacy_medication_incidents_dispense_line_id_pharmacy_dispense_lines_id_fk" FOREIGN KEY ("dispense_line_id") REFERENCES "public"."pharmacy_dispense_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_medication_incidents" ADD CONSTRAINT "pharmacy_medication_incidents_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_medication_incidents" ADD CONSTRAINT "pharmacy_medication_incidents_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_medication_incidents" ADD CONSTRAINT "pharmacy_medication_incidents_reporter_role_roles_key_fk" FOREIGN KEY ("reporter_role") REFERENCES "public"."roles"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pharmacy_medication_incident_events_incident_idx" ON "pharmacy_medication_incident_events" USING btree ("incident_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_medication_incident_events_closed_ux" ON "pharmacy_medication_incident_events" USING btree ("incident_id") WHERE kind = 'closed';--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_medication_incidents_seq_ux" ON "pharmacy_medication_incidents" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "pharmacy_medication_incidents_created_idx" ON "pharmacy_medication_incidents" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "pharmacy_medication_incidents_patient_idx" ON "pharmacy_medication_incidents" USING btree ("patient_id");--> statement-breakpoint
-- ═══ PHARMACY STAGE D2 — THE MEDICATION INCIDENT LOG IS APPEND-ONLY, HAND-CARRIED (drizzle-kit emits no triggers) ═══
--
-- NABH MOM: a medication error or near miss, once reported, is a record. A review (root cause, action
-- taken) and the close are new `pharmacy_medication_incident_events` rows; a wrong report is answered by
-- a further row, never by an edit. The D1 ADR register's shape, one function for the two tables.
CREATE OR REPLACE FUNCTION pharmacy_medication_incident_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy_medication_incident_immutable: a % row may not be deleted (id %)', TG_TABLE_NAME, OLD.id;
  END IF;
  RAISE EXCEPTION 'pharmacy_medication_incident_immutable: a % row may not be edited (id %) — a later act is a new event row, never an edit', TG_TABLE_NAME, OLD.id;
END $$;--> statement-breakpoint
CREATE TRIGGER pharmacy_medication_incidents_immutable
  BEFORE UPDATE OR DELETE ON pharmacy_medication_incidents
  FOR EACH ROW
  EXECUTE FUNCTION pharmacy_medication_incident_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER pharmacy_medication_incident_events_immutable
  BEFORE UPDATE OR DELETE ON pharmacy_medication_incident_events
  FOR EACH ROW
  EXECUTE FUNCTION pharmacy_medication_incident_forbid_mutation();
