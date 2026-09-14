CREATE TABLE "opd_encounter_diagnoses" (
	"encounter_id" text NOT NULL,
	"seq" integer NOT NULL,
	"text" text NOT NULL,
	"icd10_code" text,
	CONSTRAINT "opd_encounter_diagnoses_encounter_id_seq_pk" PRIMARY KEY("encounter_id","seq")
);
--> statement-breakpoint
ALTER TABLE "opd_encounter_diagnoses" ADD CONSTRAINT "opd_encounter_diagnoses_encounter_id_opd_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."opd_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opd_encounter_diagnoses_code_idx" ON "opd_encounter_diagnoses" USING btree ("icd10_code");