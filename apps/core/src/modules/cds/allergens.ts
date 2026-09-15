import { sql } from "drizzle-orm";
import { rulesOf } from "./knowledge";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE ALLERGY FIELD — AUTOCOMPLETE, AUTOCORRECT, AND WHY IT IS A SAFETY FEATURE ═══
 *
 * The doctor can already type an allergy in the room (`source: "consult"`). What they could not do
 * was pick one, and that is not a convenience gap — it is a hole in a guard.
 *
 * `blockedBy` (regimen.ts) matches the patient's allergy TEXT against each rule's allergen and
 * `blocked_classes`, on tokens of five letters or more. So `pencilin` — a real thing to type at a
 * busy desk — matches nothing at all, and the penicillin block goes SILENT for the rest of that
 * patient's life on the record. No error. No warning. A guard with nothing to say.
 *
 * A PICKED allergen carries its class, and the rule is then found by identity rather than by
 * spelling. That is the whole point of this file.
 *
 * ═══ TWO TIERS, AND THE CLASS COMES FIRST ═══
 *
 * The bundle ships six allergen CLASSES, each with the list of molecules it blocks — Penicillins /
 * Beta-Lactams blocks amoxicillin, ampicillin, co-amoxiclav, piperacillin, cloxacillin, cephalexin
 * and cefadroxil. Recording the class is strictly better than recording one member of it: a patient
 * allergic to penicillin is protected from all seven either way, and the record says what was
 * actually meant. So classes rank above moieties.
 *
 * Below them are the 3,283 imported moieties, for an allergy the six classes do not cover.
 *
 * ═══ AUTOCORRECT IS `pg_trgm`, NOT A MODEL ═══
 *
 * `similarity()` over the moiety names turns `pencilin` into `Penicillin` in microseconds, with the
 * trigram index that the drug typeahead already added. The owner asked for autocorrect on this
 * field; this is it, and nothing here rewrites what the doctor typed — it OFFERS, and Enter still
 * commits the doctor's own words (16a design law 1, the same law the drug and diagnosis fields keep).
 */
export type AllergenHit = {
  /** What to show and what to store as the substance. */
  term: string;
  /** "class" outranks "moiety"; the screen says which so a doctor can see what they are choosing. */
  kind: "class" | "moiety";
  /** The rule class this hit records, when it is one. Null for a bare moiety. */
  allergenClass: string | null;
  /** `formulary_salts.id` when the hit is a moiety, so the record can name one thing exactly. */
  saltId: string | null;
  /** What this choice will block, for the line under the name — empty for a moiety with no rule. */
  blocks: string[];
};

export const ALLERGEN_MIN_CHARS = 3;

/** The six classes, read out of the knowledge base once. */
function classes(): AllergenHit[] {
  return rulesOf("allergy_rules").map((r) => {
    const p = r.payload as { allergen?: string; allergen_class?: string; blocked_classes?: string[] };
    return {
      term: p.allergen_class ?? p.allergen ?? "",
      kind: "class" as const,
      allergenClass: p.allergen_class ?? null,
      saltId: null,
      blocks: p.blocked_classes ?? [],
    };
  }).filter((c) => c.term !== "");
}

/**
 * A class matches on its own name OR on any molecule it blocks OR on the allergen that names it —
 * a doctor typing `amoxicillin` means the beta-lactam class, and typing `augmentin`'s moiety should
 * reach it too. Without the `blocked_classes` arm, the commonest way to say "penicillin allergy" in
 * an Indian OPD — naming the drug the patient actually reacted to — would not find the class.
 */
function classMatches(c: AllergenHit, needle: string, rawAllergen: string): boolean {
  if (c.term.toLowerCase().includes(needle)) return true;
  if (rawAllergen.toLowerCase().includes(needle)) return true;
  return c.blocks.some((b) => b.toLowerCase().includes(needle));
}

export async function searchAllergens(db: Db, query: string, limit = 8): Promise<AllergenHit[]> {
  const q = query.trim().toLowerCase();
  if (q.length < ALLERGEN_MIN_CHARS) return [];
  const capped = Math.min(Math.max(limit, 1), 20);

  const rawByClass = new Map(rulesOf("allergy_rules").map((r) => {
    const p = r.payload as { allergen?: string; allergen_class?: string };
    return [p.allergen_class ?? "", p.allergen ?? ""] as const;
  }));
  const hits = classes().filter((c) => classMatches(c, q, rawByClass.get(c.allergenClass ?? "") ?? ""));

  /*
    THE MOIETIES, AND THE AUTOCORRECT LIVES HERE. `similarity` is the fuzzy arm — `pencilin` scores
    high against `Penicillin` — and the `like` arm keeps an exact substring first. A threshold of
    0.3 is pg_trgm's own default and is what stops `ace` returning a third of the catalogue.
  */
  const rest = capped - hits.length;
  if (rest > 0) {
    const res = await db.execute(sql`
      select s.id, s.name, similarity(lower(s.name), ${q}) as sim
        from formulary_salts s
       where s.active
         and (lower(s.name) like ${`%${q}%`} or similarity(lower(s.name), ${q}) > 0.3)
       order by (lower(s.name) like ${`${q}%`}) desc,
                (lower(s.name) like ${`%${q}%`}) desc,
                sim desc,
                s.product_count desc,
                length(s.name) asc
       limit ${rest}
    `);
    for (const r of res.rows as Record<string, unknown>[]) {
      const name = String(r["name"]);
      /* A moiety already offered as a class member is not offered twice under its own name. */
      if (hits.some((h) => h.term.toLowerCase() === name.toLowerCase())) continue;
      hits.push({ term: name, kind: "moiety", allergenClass: null, saltId: String(r["id"]), blocks: [] });
    }
  }
  return hits.slice(0, capped);
}

/**
 * Does this free text reach any rule at all? The field warns when it does not — it never refuses.
 *
 * This is the reader's half of the silent-guard problem: a doctor who types `pencilin` and gets no
 * warning has no way to know the block will never fire. The same token rule `rulesForAllergies`
 * uses, so the answer is the truth about what the guard will actually do rather than a second
 * opinion about it.
 */
export function matchesAKnownAllergen(substance: string): boolean {
  const toks = substance.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 5);
  if (toks.length === 0) return false;
  for (const r of rulesOf("allergy_rules")) {
    const p = r.payload as { allergen?: string; allergen_class?: string; blocked_classes?: string[] };
    const names = `${p.allergen ?? ""} ${p.allergen_class ?? ""} ${(p.blocked_classes ?? []).join(" ")}`
      .toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 5);
    if (toks.some((t) => names.includes(t))) return true;
  }
  return false;
}
