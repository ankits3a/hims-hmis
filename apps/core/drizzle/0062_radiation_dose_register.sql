-- PLAN 18c T3 — THE PATIENT DOSE REGISTER, and the DRL book that gives its numbers a meaning.
--
-- 18a promised 18c "a projection of the dose columns". This is not one, and D5 says why: the cath
-- lab (63) records a fluoroscopy dose against a procedure and radiation oncology (64) against a
-- fraction, and a register that JOINED `imaging_studies` would have had one source for ever.
-- The SOURCES write it, through `recordDose`, inside their own transactions.
--
-- Three constraints carry the design:
--   · `radiation_dose_register_source_ux` — ONE row per source event. 18a's own comment on the
--     acquisition CAS says the mutant "counts the dose twice"; this index holds even if that guard
--     is ever weakened.
--   · `radiation_dose_register_dose_ck` — a register row with no number in it cannot answer the
--     question the register exists for. 18a says the same about the study, and says `dose_manual`
--     is provenance, not an excuse.
--   · `radiation_dose_register_drl_ck` — the comparison travels whole or not at all: quantity,
--     level and verdict together. `over_drl = true` with no level is a verdict nobody can check,
--     and NULL means "no published level", which is deliberately not the same as "under".
--
-- `imaging_definitions.kind` gains `dose_reference_levels`: the DRL book is governed like every
-- other definition (draft -> approval -> publish), and the comparison it drives is STORED with the
-- dose row so a level republished next year cannot retroactively change what an examination in
-- March was measured against.

CREATE TABLE "radiation_dose_register" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"patient_id" text NOT NULL,
	"device_resource_id" text,
	"modality" text NOT NULL,
	"procedure_code" text NOT NULL,
	"dose_ctdivol" numeric(10, 3),
	"dose_dlp" numeric(10, 3),
	"dose_dap" numeric(10, 3),
	"fluoro_seconds" integer,
	"dose_manual" boolean DEFAULT false NOT NULL,
	"drl_quantity" text,
	"drl_value" numeric(10, 3),
	"over_drl" boolean,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "radiation_dose_register_source_ck" CHECK ("radiation_dose_register"."source" in ('imaging', 'cath_lab', 'radiotherapy')),
	CONSTRAINT "radiation_dose_register_dose_ck" CHECK ("radiation_dose_register"."dose_ctdivol" is not null or "radiation_dose_register"."dose_dlp" is not null
          or "radiation_dose_register"."dose_dap" is not null or "radiation_dose_register"."fluoro_seconds" is not null),
	CONSTRAINT "radiation_dose_register_drl_ck" CHECK (("radiation_dose_register"."drl_quantity" is null and "radiation_dose_register"."drl_value" is null and "radiation_dose_register"."over_drl" is null)
          or ("radiation_dose_register"."drl_quantity" is not null and "radiation_dose_register"."drl_value" is not null and "radiation_dose_register"."over_drl" is not null))
);
--> statement-breakpoint
ALTER TABLE "imaging_definitions" DROP CONSTRAINT "imaging_definitions_kind_ck";--> statement-breakpoint
ALTER TABLE "radiation_dose_register" ADD CONSTRAINT "radiation_dose_register_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "radiation_dose_register" ADD CONSTRAINT "radiation_dose_register_device_resource_id_resources_id_fk" FOREIGN KEY ("device_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "radiation_dose_register_source_ux" ON "radiation_dose_register" USING btree ("source","source_ref");--> statement-breakpoint
CREATE INDEX "radiation_dose_register_patient_idx" ON "radiation_dose_register" USING btree ("patient_id","occurred_at");--> statement-breakpoint
CREATE INDEX "radiation_dose_register_occurred_idx" ON "radiation_dose_register" USING btree ("occurred_at");--> statement-breakpoint
ALTER TABLE "imaging_definitions" ADD CONSTRAINT "imaging_definitions_kind_ck" CHECK ("imaging_definitions"."kind" in ('study_types', 'pregnancy_policy', 'critical_categories', 'pacs_settings', 'dose_reference_levels'));