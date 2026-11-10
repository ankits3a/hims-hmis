-- Owner 2026-11-10, from a reference Widal report: the significant titre differs by antigen. S. typhi O and
-- S. Paratyphi AH and BH are significant at 1:80 or more, S. typhi H at 1:160 or more. The flag reads its limit from
-- the range text ("Up to 1:N" means above 1:N is abnormal), so O, AH and BH read "Up to 1:40" and H keeps
-- "Up to 1:80". Data only. Reports already saved keep the range they were reported against.
UPDATE "lab_reference_ranges" SET "text" = 'Up to 1:40', "low" = NULL, "high" = NULL,
  "source" = 'Corrected 2026-11-10 per owner reference: significant at 1:80 and above'
WHERE "analyte_id" IN (SELECT "id" FROM "lab_analytes" WHERE "code" IN ('WIDAL_TO', 'WIDAL_AH', 'WIDAL_BH'));
UPDATE "lab_reference_ranges" SET "text" = 'Up to 1:80', "low" = NULL, "high" = NULL,
  "source" = 'Corrected 2026-11-10 per owner reference: significant at 1:160 and above'
WHERE "analyte_id" IN (SELECT "id" FROM "lab_analytes" WHERE "code" = 'WIDAL_TH');
