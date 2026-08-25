-- PLAN 11h T7 — trigram matching, so that spelling variance stops hiding patients.
--
-- Strict prefix matching (Plan 05) cannot find "Aasha" from "Asha", and an Indian desk spells the
-- same name three ways before lunch. `pg_trgm` gives similarity matching; the GIN indexes below are
-- what make it affordable, and `unaccent` folds diacritics for anything that needs it in SQL.
--
-- BOTH EXTENSIONS WERE MEASURED AS AVAILABLE in the running production image (plan §3 Q3:
-- pg_trgm 1.6, unaccent 1.1, on PostgreSQL 16.14). No image change, no new dependency.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint

-- The index expression is `lower(<column>)`, and it must stay in step with what the QUERY side
-- sends: `normalizeForSearch` (kernel/search/normalize.ts) lowercases, folds diacritics and
-- transliterates Devanagari before the string ever reaches Postgres. If one side changes, the
-- other stops using the index — silently, because a sequential scan still returns correct rows.
--
-- `unaccent()` is deliberately NOT in the index expression: it is STABLE rather than IMMUTABLE, so
-- Postgres refuses it in an index without an IMMUTABLE wrapper function, and wrapping it would put
-- a hand-written function into the migration history for a fold the application already does.
CREATE INDEX IF NOT EXISTS patients_name_trgm_idx ON patients USING gin (lower(name) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS opd_doctors_display_name_trgm_idx ON opd_doctors USING gin (lower(display_name) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS opd_departments_name_trgm_idx ON opd_departments USING gin (lower(name) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS services_name_trgm_idx ON services USING gin (lower(name) gin_trgm_ops);
