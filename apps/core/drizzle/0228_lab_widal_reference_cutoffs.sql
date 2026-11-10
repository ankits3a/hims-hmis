-- Owner 2026-11-10, from two reference Widal reports (tube and slide): every Widal antigen's reference interval reads
-- "Non-Reactive". The significant titre differs by antigen (S. typhi O, S. Paratyphi AH and BH at 1:80 or more,
-- S. typhi H at 1:160 or more) and now lives in packages/contracts/src/lab-titre.ts, not in the range text.
-- Data only. Reports already saved keep the range they were reported against.
UPDATE "lab_reference_ranges" SET "text" = 'Non-Reactive', "low" = NULL, "high" = NULL,
  "source" = 'Corrected 2026-11-10 per owner reference reports: Non-Reactive; significance per antigen in code'
WHERE "analyte_id" IN (SELECT "id" FROM "lab_analytes" WHERE "code" IN ('WIDAL_TO', 'WIDAL_TH', 'WIDAL_AH', 'WIDAL_BH'));
