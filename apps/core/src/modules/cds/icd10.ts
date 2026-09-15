import { sql } from "drizzle-orm";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE DIAGNOSIS TYPEAHEAD — WHAT THE DOCTOR SEES AFTER TWO LETTERS ═══
 *
 * The consult screen's diagnosis box was free text and the `icd10Code` beside it was a bare input,
 * both typed from memory. The owner supplied the ICD-10-CM tabular list on 2026-09-14 and this is
 * what reads it.
 *
 * ═══ IT IS AUTOCOMPLETE, SO IT IS NOT GATED ON THE CO-PILOT ═══
 *
 * The owner's ruling of 2026-09-14 has two halves and they draw the line in different places:
 * *"Diagnosis, Advice and Advised investigations suggest only when the AI co-pilot is enabled"*,
 * and *"even though the doctor doesn't enable AI suggestion ... auto complete will work if doctor
 * starts to type drug name."*
 *
 * This route is the second kind. It completes WHAT THE DOCTOR IS TYPING against a published
 * catalogue — no model, no patient, no inference — exactly as the drug field does. What is gated on
 * the co-pilot is the other thing: proposing a diagnosis the doctor has NOT typed, from the
 * complaint, which is `rankSyndromes` and lives behind the co-pilot switch. Completing a word is
 * not suggesting a diagnosis.
 *
 * ═══ BILLABLE ONLY, AND THAT IS A CLINICAL-RECORDS DECISION ═══
 *
 * 23,252 of the 97,296 codes are category headers — "A01 Typhoid and paratyphoid fevers" — which
 * exist to group their children and may never be assigned to an encounter or a claim. Offering one
 * to a doctor means MRD finds it later and recodes it. The typeahead therefore searches the 74,044
 * ASSIGNABLE codes; the headers stay in the table for a hierarchy screen that wants them.
 *
 * ═══ TWO CHAPTERS ARE TWO THIRDS OF THE BOOK AND NEITHER IS A DIAGNOSIS ═══
 *
 * Chapter 19 (injury, 53,944 rows — almost every injury carries a 7th character for initial /
 * subsequent / sequela encounter) and chapter 20 (external causes, 10,573 rows — how it happened,
 * never what is wrong) are 66% of the catalogue between them. Ranked on similarity alone they bury
 * everything else: measured below, `fract` returned ten chapter-19 rows and nothing else. They are
 * RANKED DOWN rather than excluded, because an OPD that dresses a wound does sometimes want one.
 */
export type Icd10Hit = {
  code: string;
  /** The short description, which is what the field shows and what fills the diagnosis tag. */
  description: string;
  chapterNo: number;
  /** True when the CODE starts with what was typed — the screen shows those differently. */
  codeMatch: boolean;
};

/**
 * Chapter 20 (external causes, V00-Y99) sorts below every other chapter: it records how an injury
 * happened and is never itself a diagnosis. Chapter 19 was in this list in the first draft and came
 * OUT after measurement — with it demoted, `fract` returned "Fracture of skull due to birth injury"
 * and three dental-filling codes ahead of every real fracture. Chapter 19 is large, not wrong.
 */
const DEPRIORITISED_CHAPTERS = [20];

export const MIN_QUERY_CHARS = 2;

export async function searchIcd10(db: Db, query: string, limit = 10): Promise<Icd10Hit[]> {
  const q = query.trim().toLowerCase();
  if (q.length < MIN_QUERY_CHARS) return [];
  const capped = Math.min(Math.max(limit, 1), 25);
  const like = `%${q}%`;
  const starts = `${q}%`;
  /* A word-START match: `uri` should reach "Urinary tract infection" ahead of "pleurisy". */
  const wordStart = `(^|[^a-z])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;

  /*
    TWO INDEXED BRANCHES, UNIONED — NOT ONE `OR`. The drug field measured what an OR across a
    trigram match and a second predicate costs: Postgres drops the trigram index for the whole
    disjunction and sequentially scans. Each branch here takes its own index — `lower(code)` btree
    for a typed code, `lower(short_description) gin_trgm_ops` for typed prose.
  */
  const res = await db.execute(sql`
    with hits as (
      select c.code, c.short_description, c.chapter_no, c.generality, c.order_number, true as code_match
        from icd10_codes c
       where c.billable and lower(c.code) like ${starts}
      union
      select c.code, c.short_description, c.chapter_no, c.generality, c.order_number, false as code_match
        from icd10_codes c
       where c.billable and lower(c.short_description) like ${like}
    )
    select code, short_description, chapter_no,
           bool_or(code_match) as code_match
      from hits
     group by code, short_description, chapter_no, generality, order_number
     order by bool_or(code_match) desc,
              (lower(short_description) like ${starts}) desc,
              (lower(short_description) ~ ${wordStart}) desc,
              (chapter_no in (${sql.join(DEPRIORITISED_CHAPTERS.map((n) => sql`${n}`), sql`, `)})) asc,
              generality desc,
              order_number asc,
              code asc
     limit ${capped}
  `);

  return (res.rows as Record<string, unknown>[]).map((r) => ({
    code: String(r["code"]),
    description: String(r["short_description"]),
    chapterNo: Number(r["chapter_no"]),
    codeMatch: r["code_match"] === true,
  }));
}
