import { sql } from "drizzle-orm";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ CONSULT V2 PR 3 — THE DOCTOR'S OWN WORDS, OFFERED BACK (owner, 2026-09-23, round 4) ═══
 *
 * "Text autocomplete / autocomplete chips should appear when typing characters everywhere." The
 * complaint, diagnosis and allergy fields already had it. This adds the doctor's own history for
 * the Consult v2 fields that store words: examination findings (per group) and treatment.
 *
 * ═══ NO NEW TABLE — THE HISTORY IS ALREADY THE ENCOUNTERS ═══
 *
 * The complaint field keeps a usage table because its words are mapped to concepts. These fields are
 * not mapped to anything, so a usage table would be a second copy of what `opd_encounters` already
 * holds. The read is bounded by `opd_encounters_doctor_completed_idx`: one doctor's completed visits.
 *
 * ═══ ONE DOCTOR'S WORDS STAY THAT DOCTOR'S (D4) ═══
 *
 * A free-text finding is private to the doctor who typed it until a curator promotes it. This read
 * filters on `doctor_id` and can never return another doctor's words. The hospital's own lists (the
 * examination and treatment chips) are merged in on the screen, not here.
 */

export type TermField = "exam_general" | "exam_systemic" | "exam_local" | "treatment";
export type TermHit = { term: string; uses: number };

export const TERM_MIN_CHARS = 1;

export async function myTerms(db: Db, doctorId: string, field: TermField, query: string, limit = 8): Promise<TermHit[]> {
  const q = query.trim().toLowerCase();
  if (q.length < TERM_MIN_CHARS) return [];
  const capped = Math.min(Math.max(limit, 1), 20);
  const like = `%${q}%`;
  const starts = `${q}%`;
  const res = field === "treatment"
    ? await db.execute(sql`
        select x.term, count(*)::int as uses
          from opd_encounters e
          cross join lateral jsonb_array_elements_text(
            case when jsonb_typeof(e.treatment) = 'array' then e.treatment else '[]'::jsonb end) as x(term)
         where e.doctor_id = ${doctorId} and e.consult_completed_at is not null
           and lower(x.term) like ${like}
         group by x.term
         order by (lower(x.term) like ${starts}) desc, uses desc, length(x.term) asc, x.term asc
         limit ${capped}`)
    : await db.execute(sql`
        select f->>'text' as term, count(*)::int as uses
          from opd_encounters e
          cross join lateral jsonb_array_elements(
            case when jsonb_typeof(e.examination) = 'array' then e.examination else '[]'::jsonb end) as f
         where e.doctor_id = ${doctorId} and e.consult_completed_at is not null
           and f->>'group' = ${field.slice("exam_".length)}
           and lower(f->>'text') like ${like}
         group by f->>'text'
         order by (lower(f->>'text') like ${starts}) desc, uses desc, length(f->>'text') asc, f->>'text' asc
         limit ${capped}`);
  return (res.rows as Record<string, unknown>[])
    .filter((r) => typeof r["term"] === "string" && r["term"] !== "")
    .map((r) => ({ term: String(r["term"]), uses: Number(r["uses"] ?? 0) }));
}

export type TestHit = { serviceId: string; code: string; name: string; pricePaise: number; mine: number; hospital: number };

/**
 * ═══ TESTS FOR COMPLAINTS + DIAGNOSIS — WHAT THIS HOSPITAL ADVISED BEFORE FOR THE SAME DIAGNOSIS ═══
 *
 * The clinical bundle has regimens (drugs) but no investigation sets, so the honest source is
 * practice. It uses the tests advised on completed visits that carried the same diagnosis, matched by
 * ICD-10 code when the doctor picked one and by the exact words otherwise. The doctor's own habit
 * ranks first; the hospital's comes next. The result is a list of counts, not a recommendation, and
 * the chips on the screen say so. No patient data leaves the aggregate.
 */
export async function testsForDiagnosis(
  db: Db, doctorId: string | null, diagnoses: { text: string; icd10: string | null }[], limit = 6,
): Promise<TestHit[]> {
  const codes = diagnoses.map((d) => d.icd10).filter((c): c is string => typeof c === "string" && c !== "");
  const words = diagnoses.map((d) => d.text.trim().toLowerCase()).filter((w) => w !== "");
  if (codes.length === 0 && words.length === 0) return [];
  const capped = Math.min(Math.max(limit, 1), 12);
  const who = doctorId ?? "";
  const codeArr = codes.length === 0 ? sql`array[]::text[]` : sql`array[${sql.join(codes.map((c) => sql`${c}`), sql`, `)}]::text[]`;
  const wordArr = words.length === 0 ? sql`array[]::text[]` : sql`array[${sql.join(words.map((w) => sql`${w}`), sql`, `)}]::text[]`;
  const res = await db.execute(sql`
    with visits as (
      select distinct e.id, e.doctor_id, e.advised_tests
        from opd_encounters e
        join opd_encounter_diagnoses d on d.encounter_id = e.id
       where e.consult_completed_at is not null
         and jsonb_typeof(e.advised_tests) = 'array'
         and (d.icd10_code = any(${codeArr}) or lower(d.text) = any(${wordArr}))
    )
    select t->>'serviceId' as service_id,
           max(t->>'code') as code, max(t->>'name') as name,
           max((t->>'pricePaise')::int) as price_paise,
           count(*) filter (where v.doctor_id = ${who})::int as mine,
           count(*)::int as hospital
      from visits v
      cross join lateral jsonb_array_elements(v.advised_tests) as t
     where t->>'serviceId' is not null
     group by t->>'serviceId'
     order by mine desc, hospital desc, max(t->>'name') asc
     limit ${capped}`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    serviceId: String(r["service_id"]),
    code: String(r["code"] ?? ""),
    name: String(r["name"] ?? ""),
    pricePaise: Number(r["price_paise"] ?? 0),
    mine: Number(r["mine"] ?? 0),
    hospital: Number(r["hospital"] ?? 0),
  }));
}
