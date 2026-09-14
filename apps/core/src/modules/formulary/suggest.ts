import { and, eq, sql } from "drizzle-orm";
import { formularyGenerics } from "../../kernel/db/schema";
import type { Db } from "../../kernel/db/client";

/**
 * THE PRESCRIBER'S DRUG SEARCH — molecule and strength, with no brand in it.
 *
 * === WHAT THIS IS FOR, AND WHAT IT DELIBERATELY IS NOT ===
 *
 * Today a doctor types a drug name into a free-text box (`opd-consult.tsx:1150`) with nothing
 * behind it, and the `<select>` beside it is fed by `listMedicines`, which returns EVERY branded
 * medicine unpaginated. That control works only because `formulary_medicines` is empty. This route
 * lets the doctor prescribe from the CLINICAL DRUG tier instead — "Amlodipine 5 mg oral tablet" —
 * which needs no brand, no pack, no price and no pharmacy.
 *
 * **It searches generics ONLY, and it returns no branded product.** That is the point rather than a
 * limitation: brands can be loaded later without changing one line here.
 *
 * === WHY IT RETURNS NO `medicineId`, AND WHY THAT IS THE SAFE CHOICE ===
 *
 * A prescription line's `medicineId` is what turns the line into a CHECKED one. Setting it on a
 * catalogue that is 97.7% uncurated would be actively harmful, and the harm is measured: coverage
 * (`curation.ts:81`) counts a line as resolved whenever `resolveMedicines` returns an entry, which
 * it does for every existing medicine — including one with no composition — while
 * `prescriptions.ts:268` counts that same line UNRESOLVED. Picks alone would push coverage past
 * `COVERAGE_NOTICE_THRESHOLD` and report a formulary that is working while nothing is checked, and
 * a picked-but-uncurated line would never enter `unresolvedTop` — starving the very worklist by
 * which coverage grows.
 *
 * So this fills the drug NAME and nothing else. Every safety guard sees exactly what it sees for a
 * free-typed line, the "advanced checks unavailable" notice keeps telling the truth, and the doctor
 * gets what was actually asked for: a real vocabulary instead of a blank box. The checks switch on
 * when moieties are curated, not when a search box ships.
 *
 * === THE TWO LANES, AND WHY RANKING COUNTS COMPONENTS ===
 *
 * Lane 1 is a PREFIX match on `name_normalized`; lane 2 is a CONTAINS match, and lane 1 always
 * outranks lane 2. Within a lane the FEWEST COMPONENTS wins — a doctor typing a molecule wants that
 * molecule, and on the real release `amlodipine` prefix-matches 92 generics of which all but a
 * handful are combinations.
 *
 * **Name length was the first rule here and it was wrong**, caught by its own test. The plain drug
 * is often the LONGER string, because it carries the salt-form parenthetical the release writes
 * into it: "amlodipine (as amlodipine besylate) 5 mg oral tablet" is 51 characters, while the
 * two-drug combination "amlodipine 5 mg and atorvastatin 10 mg oral tablet" is 49. Sorting by
 * length puts the combination first, which is the opposite of the intent.
 *
 * So components are COUNTED, from the `+` separators in `composition_summary` — a column the
 * release populates for 100% of its 10,303 rows. Length survives only as a tie-break.
 *
 * `dose_form` and `route_of_administration` live on the row, and dose form is NOT decoration:
 * 774 groups of generics share an identical
 * `composition_summary` and dose form resolves 97.7% of those collisions, so a list that renders a
 * composition without its form shows the doctor two rows it claims are the same drug.
 */

/** Below this the result set is the catalogue, and the doctor is reading rather than choosing. */
export const MIN_QUERY_CHARS = 3;
export const MAX_SUGGESTIONS = 25;

export interface DrugSuggestion {
  /** `formulary_generics.id`. Carried for a future task; it is NOT written to a prescription line. */
  genericId: string;
  /** What fills the drug field and what the doctor reads. */
  name: string;
  doseForm: string;
  route: string;
  /** The release's own composition line, or null. Never rendered without `doseForm`. */
  composition: string | null;
  /** Which lane matched — the caller renders prefix hits differently, and tests assert on it. */
  matchedOn: "prefix" | "contains";
}

/**
 * `%` and `_` are LIKE wildcards, and a doctor typing a drug name has no reason to mean them.
 * Escaping rather than stripping keeps a literal search honest; `\\` is escaped first or it would
 * re-escape the escapes.
 */
function escapeLike(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export async function suggestDrugs(
  db: Db,
  query: string,
  opts: { limit?: number } = {},
): Promise<DrugSuggestion[]> {
  const q = query.trim().toLowerCase();
  // An empty answer to a too-short query, never the whole catalogue.
  if (q.length < MIN_QUERY_CHARS) return [];
  const limit = Math.min(Math.max(opts.limit ?? MAX_SUGGESTIONS, 1), MAX_SUGGESTIONS);
  const needle = escapeLike(q);

  const rows = await db
    .select({
      genericId: formularyGenerics.id,
      name: formularyGenerics.nameNormalized,
      doseForm: formularyGenerics.doseForm,
      route: formularyGenerics.routeOfAdministration,
      composition: formularyGenerics.compositionSummary,
      isPrefix: sql<boolean>`lower(${formularyGenerics.nameNormalized}) like ${needle + "%"} escape '\\'`,
    })
    .from(formularyGenerics)
    .where(and(
      eq(formularyGenerics.active, true),
      sql`lower(${formularyGenerics.nameNormalized}) like ${"%" + needle + "%"} escape '\\'`,
    ))
    .orderBy(
      // Lane 1 before lane 2.
      sql`(lower(${formularyGenerics.nameNormalized}) like ${needle + "%"} escape '\\') desc`,
      // Then the fewest components: the number of `+` separators in the release's own composition
      // line. A null composition sorts as a single component rather than as zero, so a row missing
      // the column is never promoted above a genuine single-molecule drug.
      sql`coalesce(length(${formularyGenerics.compositionSummary}) - length(replace(${formularyGenerics.compositionSummary}, '+', '')), 0) asc`,
      // Then shortest, then alphabetical — a stable tie-break, so the same query never reorders
      // itself between keystrokes and the row under the doctor's cursor does not move.
      sql`length(${formularyGenerics.nameNormalized}) asc`,
      formularyGenerics.nameNormalized,
    )
    .limit(limit);

  return rows.map((r) => ({
    genericId: r.genericId,
    name: r.name,
    doseForm: r.doseForm,
    route: r.route,
    composition: r.composition,
    matchedOn: r.isPrefix ? "prefix" : "contains",
  }));
}
