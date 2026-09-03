-- PLAN 17d T1 — THE VALUE THAT IS IMPOSSIBLE FOR THIS PATIENT.
--
-- Design board EdgeCases #15: *"A man's tube shows a pregnancy hormone: tubes swapped at the
-- chair."* The bench accepts it today, and the reason is structural rather than an oversight —
-- `outsideAbsurdEnvelope` reads the NUMBER (`results.ts`), and a beta-hCG of 4200 mIU/mL is a
-- perfectly ordinary number. The only thing wrong with it is the PATIENT it is standing next to,
-- and nothing in the entry path was looking at the patient.
--
-- `lab_reference_ranges` already carries a `sex` column, but it cannot answer this question. A
-- range book expresses "not applicable to men" as an ABSENT ROW, and `pickBySex` reads an absent
-- row as a gap in curation: it falls back to the `any` row or footnotes
-- `"reference range: unspecified sex"` and reports the value anyway (`ranges.ts:82-94`). That
-- fallback is right for a potassium, whose range is the same for everybody. It is the wrong answer
-- exactly once — when the analyte is not merely unranged for this patient but MEANINGLESS for them.
--
-- So applicability is declared on the ANALYTE, where it is a property of the test rather than a hole
-- in a table. All three columns are NULL for every analyte that exists today, and NULL means
-- "applies to everybody" — which is why this migration changes no behaviour on its own.

ALTER TABLE "lab_analytes" ADD COLUMN "applies_to_sex" text;--> statement-breakpoint
ALTER TABLE "lab_analytes" ADD COLUMN "applies_min_age_days" integer;--> statement-breakpoint
ALTER TABLE "lab_analytes" ADD COLUMN "applies_max_age_days" integer;--> statement-breakpoint

-- `male` and `female` only. `other` and `unknown` are administrative genders a PATIENT may carry,
-- never a claim an analyte makes about who it is for: an analyte declared "for `unknown` patients"
-- is not a sentence about physiology. A patient whose record says `other` or `unknown` is therefore
-- never refused by the sex rule (`applicabilityBreach` in ranges.ts says so in code) — the record
-- does not support the refusal, and a laboratory that blocked those patients' results would be
-- refusing care on a data-entry default.
ALTER TABLE "lab_analytes" ADD CONSTRAINT "lab_analytes_applies_sex_ck"
  CHECK ("applies_to_sex" is null or "applies_to_sex" in ('male', 'female'));--> statement-breakpoint

-- Half-open [min, max) in DAYS, matching `lab_reference_ranges`'s own age banding so one reader
-- (`ageInDaysIst`, taken at COLLECTION, not at entry) answers both questions the same way.
ALTER TABLE "lab_analytes" ADD CONSTRAINT "lab_analytes_applies_age_ck"
  CHECK ("applies_min_age_days" is null or "applies_max_age_days" is null
         or "applies_min_age_days" < "applies_max_age_days");--> statement-breakpoint

-- ═══ AND WHO VOUCHED, WHEN THE RULE WAS OVERRIDDEN ═══
--
-- The twin of `absurd_overridden_by` (02 H1) and it exists for the same reason: an envelope one
-- person can wave through is not an envelope. NULL means the rule never fired for this row — not
-- that somebody declined to override it, which is a state that leaves no row at all.
ALTER TABLE "lab_results" ADD COLUMN "impossible_overridden_by" text;
