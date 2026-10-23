CREATE TABLE "opd_medicine_abbreviations" (
	"id" text PRIMARY KEY NOT NULL,
	"abbreviation" text NOT NULL,
	"moiety" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opd_medicine_abbreviations_lower_ck" CHECK ("opd_medicine_abbreviations"."abbreviation" = lower("opd_medicine_abbreviations"."abbreviation") and "opd_medicine_abbreviations"."moiety" = lower("opd_medicine_abbreviations"."moiety") and "opd_medicine_abbreviations"."abbreviation" <> "opd_medicine_abbreviations"."moiety"),
	CONSTRAINT "opd_medicine_abbreviations_reviewed_ck" CHECK (("opd_medicine_abbreviations"."reviewed_by" is null) = ("opd_medicine_abbreviations"."reviewed_at" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "opd_medicine_abbreviations_abbreviation_uq" ON "opd_medicine_abbreviations" USING btree ("abbreviation");--> statement-breakpoint
-- SPEC #613 — the proposed abbreviation list. NOT SIGNED: reviewed_by stays null, so the alias pipeline
-- uses none of these until this hospital's pharmacist signs each row. Error-prone abbreviations
-- (MTX, ASA, HCT, MS) are left out on purpose. Hand-written — regenerating this migration loses it.
INSERT INTO "opd_medicine_abbreviations" ("id", "abbreviation", "moiety") VALUES
	('abbr_std_01', 'amox', 'amoxicillin'),
	('abbr_std_02', 'azithro', 'azithromycin'),
	('abbr_std_03', 'cipro', 'ciprofloxacin'),
	('abbr_std_04', 'doxy', 'doxycycline'),
	('abbr_std_05', 'hctz', 'hydrochlorothiazide'),
	('abbr_std_06', 'metro', 'metronidazole'),
	('abbr_std_07', 'pcm', 'paracetamol')
ON CONFLICT DO NOTHING;
