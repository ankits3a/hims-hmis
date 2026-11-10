-- #1036 (owner 2026-11-06): a positive Widal read as negative. S. typhi O and H carried the range "Negative" and
-- Paratyphi AH and BH "<1:80"; all four Widal antigens now share "Up to 1:80", the text the quick bench flags a
-- titre against (1:160 and above is abnormal). Data only: the four range rows are corrected in place and their
-- source restamped. Reports already saved keep the range they were reported against (it is copied onto each line).
UPDATE "lab_reference_ranges" SET "text" = 'Up to 1:80', "low" = NULL, "high" = NULL,
  "source" = 'Corrected 2026-11-06 per owner (#1036): Widal significant at 1:160 and above'
WHERE "analyte_id" IN (SELECT "id" FROM "lab_analytes" WHERE "code" IN ('WIDAL_TO', 'WIDAL_TH', 'WIDAL_AH', 'WIDAL_BH'));
