import { sql } from "drizzle-orm";
import type { Db } from "../../kernel/db/client";
import { escapeLike } from "../../kernel/search/text";

/**
 * ═══ CANDIDATES FOR A TERM NOTHING MATCHED (decision 0051, plan §7a step 1) ═══
 *
 * A doctor typed or said "pan forty" and the picker had no answer. The alias pipeline
 * (`modules/opd/alias-pipeline.ts`) asks this for the catalogue rows the term COULD mean: the rows
 * whose name starts with the term's words first (an exact name or brand), then the nearest by
 * trigram. It only ever reads names, forms, schedule flags and moieties — the catalogue's real
 * list. It never reads the clinical master's text, a monograph or a prescribing default.
 *
 * NOT A TYPEAHEAD. `searchMedicines` answers a keystroke in milliseconds and ranks for a person;
 * this runs offline, once per unmatched term, may sort a few thousand rows, and ranks for a model
 * that must be shown the competing strengths and forms side by side.
 *
 * Among rows equally near, the one with FEWER moieties comes first: "amlodipine 5" names the plain
 * medicine, and the catalogue holds dozens of combinations whose name starts the same way.
 *
 * `pool` is deliberately wider than the handful a chooser is shown: the pipeline's rules need to
 * see the OTHER strengths of the same medicine and the look-alike names around it.
 */
export type AliasCandidateRow = {
  id: string;
  /** The catalogue's full name: "Pan (pantoprazole sodium) 40 mg gastro-resistant oral tablet". */
  name: string;
  form: string;
  scheduleFlag: string | null;
  /** True for one of the hospital's coded generics, false for a brand row. */
  generic: boolean;
  /** Moiety names, lower-cased and sorted. */
  salts: string[];
  /** A moiety carries an NDPS class (`formulary_salts.ndps_class`). */
  ndps: boolean;
  /** 2 — the name IS the words ("pan (…", "paracetamol 650 …"); 1 — it starts with them; 0 — only near. */
  tier: 0 | 1 | 2;
  /** `word_similarity(words, name)`, 0..1. */
  similarity: number;
};

export const ALIAS_POOL_SIZE = 200;
/** Below pg_trgm's default 0.6 on purpose: a misspelt or misheard name ("pantaprazol") scores about 0.5. */
export const ALIAS_WORD_SIMILARITY = 0.45;

type Wire = { id: string; brand_name: string; form: string; schedule_flag: string | null; code: string | null; tier: number; sim: number; salts: { name: string; ndps: boolean }[] | null };

/**
 * `words` is the NAME part of the term, lower-cased ("pan", "dolo", "amoxyclav"); `numbers` are the
 * strengths it carried ("40", "650"), and a row that prints one of them comes before any that does not: a strength the
 * doctor stated is the one thing about the product that is not in doubt. An empty or one-letter `words` has no candidates.
 */
export async function aliasCandidatePool(db: Db, words: string, numbers: readonly string[] = [], pool = ALIAS_POOL_SIZE): Promise<AliasCandidateRow[]> {
  const w = words.trim().toLowerCase();
  if (w.length < 2) return [];
  const capped = Math.min(Math.max(pool, 1), 500);
  const safe = escapeLike(w);
  /* Digits and a dot only: these go into a regular expression, so nothing else may. */
  const clean = numbers.filter((n) => /^\d+(?:\.\d+)?$/.test(n)).slice(0, 4);
  const printed = clean.length === 0
    ? sql`false`
    : sql.join(clean.map((n) => sql`lower(m.brand_name) ~ ${`(^|[^0-9.])${n.replace(".", "\\.")} ?(mg|g|mcg|microgram|iu|ml|%)`}`), sql` or `);

  /*
    `<%` is the operator the trigram index on lower(brand_name) answers, and its line is a session
    setting — so the read runs in its own transaction and the setting dies with it (`set local`).
  */
  const res = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('pg_trgm.word_similarity_threshold', ${String(ALIAS_WORD_SIMILARITY)}, true)`);
    return tx.execute(sql`
      select t.*, (
        select json_agg(json_build_object('name', lower(s.name), 'ndps', s.ndps_class is not null))
        from formulary_medicine_salts ms join formulary_salts s on s.id = ms.salt_id
        where ms.medicine_id = t.id
      ) as salts
      from (
        select h.* from (
          select m.id, m.brand_name, m.form, m.schedule_flag, m.code, m.salt_rank,
            case
              when lower(m.brand_name) like ${`${safe} (%`} or lower(m.brand_name) ~ ('^' || ${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} || ' [0-9]') then 2
              when lower(m.brand_name) like ${`${safe} %`} then 1
              else 0
            end as tier,
            word_similarity(${w}, lower(m.brand_name)) as sim,
            (${printed}) as printed,
            (select count(*) from formulary_medicine_salts c where c.medicine_id = m.id) as moieties
          from formulary_medicines m
          where m.active and ${w} <% lower(m.brand_name)
        ) h
        order by h.printed desc, h.tier desc, h.sim desc, h.moieties asc, (h.code is not null) desc, h.salt_rank desc, length(h.brand_name) asc, h.id asc
        limit ${capped}
      ) t
    `);
  });

  return (res.rows as unknown as Wire[]).map((r) => {
    const salts = r.salts ?? [];
    return {
      id: r.id, name: r.brand_name, form: r.form, scheduleFlag: r.schedule_flag, generic: r.code !== null,
      salts: [...new Set(salts.map((s) => s.name))].sort(),
      ndps: salts.some((s) => s.ndps),
      tier: (r.tier === 2 ? 2 : r.tier === 1 ? 1 : 0),
      similarity: Number(r.sim),
    };
  });
}
