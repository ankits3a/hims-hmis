import { and, desc, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { opdComplaintConcepts, opdComplaintTermUsage, opdComplaintTerms } from "../../kernel/db/schema";
import { OpdError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE COMPLAINT VOCABULARY — MAPPING, LEARNING, AND A WORKLIST THAT GROWS IT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-14, asked two questions: are different phrasings of one meaning mapped together,
 * and does the system learn the doctor's own vocabulary. Measured, both answers were no — 64 frozen
 * English strings, no synonyms, no Hindi, and nothing that ever wrote to them.
 *
 * ═══ THE DOCTOR'S WORDS ARE NEVER TOUCHED ═══
 *
 * Nothing here rewrites, normalises or replaces what was typed. `opd_encounters.chief_complaint`
 * still stores the exact string. What a concept buys is what a MACHINE may do with it: which
 * syndromes to consider, and which phrases to group on a worklist. Case is folded for LOOKUP only.
 */
export type ComplaintSuggestion = {
  term: string;
  /** Null when nobody has mapped this phrase yet — which is normal, not an error. */
  conceptKey: string | null;
  /** How often THIS doctor has committed it. The reason their own habits rise to the top. */
  mine: number;
  /** How often the whole hospital has. */
  hospital: number;
};

export const COMPLAINT_MIN_CHARS = 2;

/**
 * What to offer for what the doctor is typing.
 *
 * ═══ IT READS TWO SOURCES, AND THE SECOND ONE IS THE LEARNING ═══
 *
 * `opd_complaint_terms` is what somebody mapped. `opd_complaint_term_usage` is what this hospital
 * ACTUALLY TYPES, mapped or not — so a phrase a doctor invented last week is offered back to them
 * this week, with no concept, no model and nobody having curated anything. That is the whole of the
 * vocabulary learning the owner asked about, and it costs one union.
 *
 * ═══ HABIT RANKS ABOVE PREFIX, AND THAT ORDER WAS MEASURED RATHER THAN ASSUMED ═══
 *
 * An EXACT match is first — type `cough` in full and you get `cough`, whoever you are. After that
 * comes THIS DOCTOR'S own usage, and only then a prefix match.
 *
 * The first cut had prefix above habit, and it defeated the feature: a doctor who always writes
 * "dry cough" types `cou` and is offered "cough" — a phrase they have never used — because it
 * happens to start with those letters. Learning a doctor's vocabulary and then ranking it below an
 * alphabetical accident is not learning it.
 *
 * With no history the two are identical: every candidate scores zero on habit and prefix decides,
 * which is the behaviour a new doctor gets on their first day. The hospital's total breaks the
 * remaining ties, then brevity — a personal shorthand before a shared vocabulary, in that order.
 */
export async function suggestComplaints(
  db: Db, doctorId: string | null, query: string, limit = 8,
): Promise<ComplaintSuggestion[]> {
  const q = query.trim().toLowerCase();
  if (q.length < COMPLAINT_MIN_CHARS) return [];
  const capped = Math.min(Math.max(limit, 1), 20);
  const like = `%${q}%`;
  const starts = `${q}%`;
  const who = doctorId ?? "";

  const res = await db.execute(sql`
    with mapped as (
      select t.term, t.concept_key
        from opd_complaint_terms t
        join opd_complaint_concepts c on c.key = t.concept_key and c.active
       where lower(t.term) like ${like}
    ),
    used as (
      select u.term, null::text as concept_key
        from opd_complaint_term_usage u
       where lower(u.term) like ${like}
         and not exists (select 1 from opd_complaint_terms t where lower(t.term) = lower(u.term))
       group by u.term
    ),
    candidates as (
      select term, concept_key from mapped
      union
      select term, concept_key from used
    )
    select c.term,
           max(c.concept_key) as concept_key,
           coalesce((select sum(u.uses) from opd_complaint_term_usage u
                      where lower(u.term) = lower(c.term) and u.doctor_id = ${who}), 0) as mine,
           coalesce((select sum(u.uses) from opd_complaint_term_usage u
                      where lower(u.term) = lower(c.term)), 0) as hospital
      from candidates c
     group by c.term
     order by (lower(c.term) = ${q}) desc,
              mine desc,
              (lower(c.term) like ${starts}) desc,
              hospital desc,
              length(c.term) asc,
              c.term asc
     limit ${capped}
  `);

  return (res.rows as Record<string, unknown>[]).map((r) => ({
    term: String(r["term"]),
    conceptKey: r["concept_key"] === null || r["concept_key"] === undefined ? null : String(r["concept_key"]),
    mine: Number(r["mine"] ?? 0),
    hospital: Number(r["hospital"] ?? 0),
  }));
}

/**
 * Resolve committed phrases to concepts. Case-folded, exact — a surface form either IS a known
 * phrasing or it is not, and a fuzzy match here would silently file one complaint under another's
 * meaning. Fuzziness belongs in `proposeConceptFor`, where a human confirms it.
 */
export async function conceptsForTerms(db: Db, terms: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t !== ""))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ term: opdComplaintTerms.term, conceptKey: opdComplaintTerms.conceptKey })
    .from(opdComplaintTerms)
    .where(sql`lower(${opdComplaintTerms.term}) = any(${sql`array[${sql.join(wanted.map((w) => sql`${w}`), sql`, `)}]::text[]`})`);
  return new Map(rows.map((r) => [r.term.toLowerCase(), r.conceptKey]));
}

/**
 * Count what was actually written. Called ONCE per encounter, at completion — the note autosaves on
 * every blur, so counting there would score a phrase by how often the doctor tabbed out of the box.
 *
 * A term with no concept is counted too, and that is the point: the worklist is built from the
 * phrases this hospital uses and nobody has mapped.
 */
export async function recordComplaintUsage(
  tx: Tx, doctorId: string, terms: string[], now: Date = new Date(),
): Promise<void> {
  const seen = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t !== ""))];
  for (const term of seen) {
    await tx
      .insert(opdComplaintTermUsage)
      .values({ term, doctorId, uses: 1, lastUsedAt: now })
      .onConflictDoUpdate({
        target: [opdComplaintTermUsage.term, opdComplaintTermUsage.doctorId],
        set: { uses: sql`${opdComplaintTermUsage.uses} + 1`, lastUsedAt: now },
      });
  }
}

export type UnmappedTerm = { term: string; uses: number; lastUsedAt: Date };

/**
 * THE WORKLIST. The phrases this hospital types most that mean nothing to the machine yet, most
 * frequent first — the same shape as the formulary's `unresolvedTop`, and for the same reason: a
 * vocabulary grows along the path of actual use, not by somebody trying to imagine every phrasing.
 */
export async function unmappedComplaintTerms(db: Db, limit = 25): Promise<UnmappedTerm[]> {
  const rows = await db
    .select({
      term: opdComplaintTermUsage.term,
      uses: sql<number>`sum(${opdComplaintTermUsage.uses})::int`,
      lastUsedAt: sql<Date>`max(${opdComplaintTermUsage.lastUsedAt})`,
    })
    .from(opdComplaintTermUsage)
    .where(sql`not exists (select 1 from opd_complaint_terms t where lower(t.term) = ${opdComplaintTermUsage.term})`)
    .groupBy(opdComplaintTermUsage.term)
    .orderBy(desc(sql`sum(${opdComplaintTermUsage.uses})`))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map((r) => ({ term: r.term, uses: Number(r.uses), lastUsedAt: r.lastUsedAt }));
}

/** The separator `TagField` joins committed tags with. Split here so one reader owns the shape. */
const TAG_SEPARATOR = " · ";

/**
 * ═══ HOW A HINDI COMPLAINT REACHES AN ENGLISH SYNDROME, WITHOUT TOUCHING THE MATCHER ═══
 *
 * `rankSyndromes` matches the complaint's words against the eight syndromes' keywords, which are
 * English. `seene me dard` shares no word with any of them and never will.
 *
 * So the complaint is ENRICHED rather than the matcher changed: each committed tag is resolved to
 * its concept, and that concept's English surface forms are appended to what the matcher reads.
 * The doctor's own words are still first in the string and still the only thing stored; the matcher
 * stays a pure function over words, with no database and no notion of a concept; and a phrase
 * mapped next month starts matching for notes typed today, because resolution happens at read time.
 *
 * `khansi` therefore reaches SYN_URI_01 through `cough`, and `seene me dard` reaches nothing —
 * correctly, because no cardiac syndrome exists among the eight to reach.
 */
export async function expandComplaintForMatching(db: Db, complaint: string): Promise<string> {
  const tags = complaint.split(TAG_SEPARATOR).map((t) => t.trim()).filter((t) => t !== "");
  if (tags.length === 0) return complaint;
  const byTerm = await conceptsForTerms(db, tags);
  const keys = [...new Set([...byTerm.values()])];
  if (keys.length === 0) return complaint;

  const english = await db
    .select({ term: opdComplaintTerms.term })
    .from(opdComplaintTerms)
    .where(and(
      eq(opdComplaintTerms.script, "en"),
      sql`${opdComplaintTerms.conceptKey} = any(${sql`array[${sql.join(keys.map((k) => sql`${k}`), sql`, `)}]::text[]`})`,
    ));
  if (english.length === 0) return complaint;
  /* The doctor's words FIRST. Nothing downstream re-reads this string, but a log that showed the
     appended forms ahead of what was typed would read as though the system had rewritten it. */
  return `${complaint}${TAG_SEPARATOR}${english.map((e) => e.term).join(TAG_SEPARATOR)}`;
}

export type ConceptProposal = { conceptKey: string; label: string; score: number; because: string };

/**
 * ═══ PROPOSE A CONCEPT FOR AN UNMAPPED PHRASE — LOCALLY, AND IT NEVER DECIDES ═══
 *
 * The owner asked for model-assisted mapping. `kernel/inference/types.ts` is this tree's single
 * choke point for outbound AI and says in its own header that the text-completion half belongs to
 * Plan 12a and that *"a stub interface written a phase early is a guess about somebody else's
 * contract"*. So this phase does not open that door. It proposes with what is already on the box:
 *
 *   · `similarity()` over every known surface form — `pishab me jalan` reaches `peshab me jalan`
 *     without anyone having thought of that spelling.
 *   · a shared-word test, which is what carries `pain in chest` to `chest pain`.
 *
 * NO PATIENT TEXT LEAVES THIS MACHINE, which also keeps the DPDP question off the table entirely
 * until somebody decides it deliberately rather than as a side effect of a convenience feature.
 *
 * AND IT PROPOSES ONLY. `source` on an accepted row is `mapped`, never `proposed`: a mapping exists
 * because a human agreed with it, and the table cannot represent a machine's opinion as fact.
 * Swapping this for a model later changes this function and nothing that calls it.
 */
export async function proposeConceptFor(db: Db, term: string, limit = 3): Promise<ConceptProposal[]> {
  const t = term.trim().toLowerCase();
  if (t === "") return [];
  const res = await db.execute(sql`
    select tm.concept_key, c.label,
           max(similarity(lower(tm.term), ${t})) as sim,
           max(case when lower(tm.term) = ${t} then 1 else 0 end) as exact,
           max(case when exists (
                 select 1 from unnest(string_to_array(${t}, ' ')) w
                  where length(w) >= 4 and lower(tm.term) like '%' || w || '%'
               ) then 1 else 0 end) as shares_word
      from opd_complaint_terms tm
      join opd_complaint_concepts c on c.key = tm.concept_key and c.active
     group by tm.concept_key, c.label
    having max(similarity(lower(tm.term), ${t})) > 0.25
        or max(case when exists (
                 select 1 from unnest(string_to_array(${t}, ' ')) w
                  where length(w) >= 4 and lower(tm.term) like '%' || w || '%'
               ) then 1 else 0 end) = 1
     order by exact desc, shares_word desc, sim desc
     limit ${Math.min(Math.max(limit, 1), 10)}
  `);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    conceptKey: String(r["concept_key"]),
    label: String(r["label"]),
    score: Number(r["sim"] ?? 0),
    because: Number(r["shares_word"] ?? 0) === 1 ? "shares a word" : "spelt alike",
  }));
}

/** A human accepting a proposal, or mapping a phrase outright. `source` says a person did it. */
export async function mapComplaintTerm(
  tx: Tx, actor: Actor, term: string, conceptKey: string, script: "en" | "hi" | "hinglish",
): Promise<{ termId: string }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "mapping a phrase is a desk action");
  const t = term.trim();
  if (t === "") throw new OpdError("complaint_term_invalid", "a phrase cannot be empty");
  const concept = await tx.select().from(opdComplaintConcepts)
    .where(and(eq(opdComplaintConcepts.key, conceptKey), eq(opdComplaintConcepts.active, true)));
  if (concept.length === 0) throw new OpdError("unknown_complaint_concept", `unknown concept ${conceptKey}`);

  const id = newId();
  await tx.insert(opdComplaintTerms).values({
    id, conceptKey, term: t, script, source: "mapped", createdBy: actor.id,
  });
  return { termId: id };
}

export async function listComplaintConcepts(db: Db): Promise<{ key: string; label: string }[]> {
  return db
    .select({ key: opdComplaintConcepts.key, label: opdComplaintConcepts.label })
    .from(opdComplaintConcepts)
    .where(eq(opdComplaintConcepts.active, true))
    .orderBy(opdComplaintConcepts.label);
}
