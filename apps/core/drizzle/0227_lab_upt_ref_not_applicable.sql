-- Owner 2026-11-10: a positive urine pregnancy test printed "Negative" in the Biological ref. interval column,
-- which reads as a contradiction. Pregnancy is not an abnormal finding, so a reference interval does not apply.
-- The range row cannot be blank (lab_reference_ranges_value_ck) or deleted (results point at it, and no row
-- would add an "unspecified sex" note), so its text becomes "Not applicable". Data only: reports already saved
-- keep the range they were reported against (it is copied onto each line).
UPDATE "lab_reference_ranges" SET "text" = 'Not applicable', "low" = NULL, "high" = NULL,
  "source" = 'Corrected 2026-11-10 per owner: reference interval does not apply to a pregnancy test'
WHERE "analyte_id" IN (SELECT "id" FROM "lab_analytes" WHERE "code" = 'UPT');
