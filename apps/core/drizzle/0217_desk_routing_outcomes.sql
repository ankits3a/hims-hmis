CREATE TABLE "cds_desk_routing_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"triage_id" text NOT NULL,
	"encounter_id" text,
	"appointment_id" text,
	"concept_key" text,
	"band" text NOT NULL,
	"holdout" boolean NOT NULL,
	"suggested" jsonb NOT NULL,
	"source" text NOT NULL,
	"picked_department_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cds_desk_routing_outcomes_band_ck" CHECK ("cds_desk_routing_outcomes"."band" in ('adult', 'pediatric', 'unknown')),
	CONSTRAINT "cds_desk_routing_outcomes_source_ck" CHECK ("cds_desk_routing_outcomes"."source" in ('keywords', 'model', 'prior')),
	CONSTRAINT "cds_desk_routing_outcomes_link_ck" CHECK ("cds_desk_routing_outcomes"."encounter_id" is not null or "cds_desk_routing_outcomes"."appointment_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "cds_desk_routing_outcomes" ADD CONSTRAINT "cds_desk_routing_outcomes_encounter_id_opd_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."opd_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cds_desk_routing_outcomes" ADD CONSTRAINT "cds_desk_routing_outcomes_appointment_id_opd_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."opd_appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cds_desk_routing_outcomes_triage_uq" ON "cds_desk_routing_outcomes" USING btree ("triage_id");--> statement-breakpoint
CREATE INDEX "cds_desk_routing_outcomes_concept_idx" ON "cds_desk_routing_outcomes" USING btree ("concept_key");