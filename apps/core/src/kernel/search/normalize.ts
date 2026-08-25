/**
 * PLAN 11h T7 — MAKING INDIAN NAMES FINDABLE.
 *
 * A desk types what it hears. "Asha" is registered as Asha, Aasha or Aashaa depending on who was
 * at the counter that morning, and the same person's relatives will spell it a fourth way. Strict
 * prefix matching (Plan 05) finds none of those variants, and staff work around a search that
 * cannot find people — they keep a paper register, which is the outcome this whole plan exists to
 * prevent.
 *
 * Two mechanisms, and they are deliberately separate:
 *   - THIS FILE normalises a query to a comparable form — case, diacritics, whitespace, and
 *     Devanagari script.
 *   - THE DATABASE does the fuzzy part, with `pg_trgm` similarity over a GIN index. Approximate
 *     string matching belongs where the data is, not in a loop over rows.
 */

/** Independent vowels: they carry their sound with no inherent-vowel rule. */
const VOWELS: Record<string, string> = {
  "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u",
  "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
};

/** Matras — a vowel sign attached to the consonant BEFORE it, replacing that consonant's inherent 'a'. */
const MATRAS: Record<string, string> = {
  "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "ृ": "ri",
  "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
};

const CONSONANTS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n",
  "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
  "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh", "ष": "sh",
  "स": "s", "ह": "h", "ळ": "l", "क़": "q", "ख़": "kh", "ग़": "g",
  "ज़": "z", "ड़": "r", "ढ़": "rh", "फ़": "f",
};

/** Any character this transliterator has an opinion about — the end of a Devanagari run is where
 * the inherent vowel stops being pronounced. */
function isDevanagari(c: string): boolean {
  return (
    VOWELS[c] !== undefined || MATRAS[c] !== undefined || CONSONANTS[c] !== undefined ||
    c === HALANT || c === ANUSVARA || c === VISARGA || c === CHANDRABINDU
  );
}

const HALANT = "्";
const ANUSVARA = "ं"; // nasalisation — 'n' is the reading a desk would type
const VISARGA = "ः";
const CHANDRABINDU = "ँ";

/**
 * Devanagari → Latin, good enough for SEARCH rather than for scholarship.
 *
 * The one rule that makes or breaks it is the INHERENT VOWEL: a bare consonant carries an 'a'
 * unless a matra or a halant follows it, so `कमल` is "kamal" and not "kml". The trailing inherent
 * 'a' is then dropped — Hindi's schwa deletion — which is why `कमल` ends "mal" and not "mala".
 *
 * It is deliberately approximate. Trigram similarity is doing the tolerant part downstream, so a
 * transliteration that lands within an edit or two of what somebody typed is worth far more than
 * one that is exact for the cases it covers and absent for the rest.
 */
export function transliterateDevanagari(input: string): string {
  const chars = [...input];
  let out = "";
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i]!;
    if (VOWELS[c] !== undefined) { out += VOWELS[c]; continue; }
    if (MATRAS[c] !== undefined) { out += MATRAS[c]; continue; } // a stray matra: emit its vowel
    if (c === ANUSVARA || c === CHANDRABINDU) { out += "n"; continue; }
    if (c === VISARGA) { out += "h"; continue; }
    if (c === HALANT) continue; // handled by the consonant branch below
    const base = CONSONANTS[c];
    if (base === undefined) { out += c; continue; } // Latin, digits, spaces pass through untouched
    out += base;
    const next = chars[i + 1];
    if (next !== undefined && MATRAS[next] !== undefined) { out += MATRAS[next]; i += 1; continue; }
    if (next === HALANT) { i += 1; continue; } // halant kills the inherent vowel
    if (next === ANUSVARA || next === CHANDRABINDU) { out += "an"; i += 1; continue; }
    /**
     * SCHWA DELETION, AT THE POINT OF EMISSION — `कमल` is Kamal, not Kamala.
     *
     * It is decided HERE rather than by a regex over the finished string, and the first draft got
     * that wrong in both directions: a trailing sweep ate the matra-supplied 'a' of `आशा` (giving
     * "ash") and the final 'a' of the Latin text "Asha Devi" that never passed through this
     * function at all. Only an INHERENT vowel is droppable, and only at the end of a Devanagari
     * run — which is exactly what this branch knows and a regex downstream does not.
     */
    if (next === undefined || !isDevanagari(next)) continue;
    out += "a";
  }
  return out;
}

/**
 * The comparable form of a name or a query: script-folded, diacritic-stripped, lowercased, and
 * with runs of whitespace collapsed.
 *
 * `NFKD` + stripping combining marks is what turns "Ashã" into "asha" — it is the same job
 * Postgres' `unaccent` does, done here so the QUERY is folded before it reaches the database. The
 * stored side is folded by the index expression, and the two must stay in step: that is why the
 * migration's index and this function are named in each other's comments.
 */
export function normalizeForSearch(input: string): string {
  return transliterateDevanagari(input)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
