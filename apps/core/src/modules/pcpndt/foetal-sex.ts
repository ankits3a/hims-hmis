/**
 * PLAN 18-S RS7 T1 — **THE FOETAL-SEX DISCLOSURE GUARD: a sentence that states the sex of a foetus
 * is never signed, never saved as a prelim, never published, and nobody can approve it.**
 *
 * ═══ WHY A SECOND CHECK BESIDE THE LEXICAL LOCKOUT ═══
 *
 * `pcpndt/lockout.ts` is a WORD list, and F66 split it in two: the coded euphemisms (refused
 * everywhere, by nobody approvable) and the demographic words `male`, `female`, `boy`, `beta` …
 * (refused in an obstetric context, **liftable by the medical superintendent** — because
 * "45-year-old male" is the first line of every chest film). That lane is right for a word that has
 * an innocent use. It is wrong for a SENTENCE whose only reading is a disclosure: *"single live
 * male foetus"* is not a phrasing the MS may let through, and under F66 it was one approval away
 * from a signed report. §5(2) has no exception, so this guard has no lane.
 *
 * So this file reads PHRASES, narrowly, and its refusal (`foetal_sex_disclosure`) is checked
 * BEFORE the lexical lockout and never consults `lockoutOverride`.
 *
 * ═══ THE RULE, IN FOUR PARTS ═══
 *
 *   1. **A sex word beside a foetal noun** — "male foetus", "female single live intrauterine
 *      fetus", "fetal gender: male", "the foetus appears to be female". Only fixed filler
 *      words may stand between them (`single`, `live`, `is`, `appears`, `to`, `be` …); an ordinary
 *      word breaks the phrase, so "female with a single live foetus" — the mother — passes.
 *      Strictly foetal nouns (foetus, fetus, foetal, fetal, embryo) apply on EVERY report: the
 *      pregnant trauma patient's CT abdomen can disclose as easily as an anomaly scan (N9).
 *      "baby", "twin", "genitalia" count as foetal only in an obstetric context — a neonatal head
 *      scan of "a female baby, 3 days old" is a born child, and that is not this Act.
 *   2. **A sex stated as a value** in an obstetric context — "sex: male", "gender – F", "लिंग: पुरुष".
 *   3. **A word with no innocent reading on an obstetric scan** — boy, girl, लड़का, लड़की, ladka,
 *      ladki, bare `male`/`masculine` (the only male a pregnant woman's scan can describe is the
 *      foetus), the foetal genital anatomy (scrotum, penis, testes, labia, clitoris, vulva, phallus)
 *      and the sonographers' own signs for it ("turtle sign", "hamburger sign").
 *   4. **Nothing else.** "female patient", "28-year-old female", "maternal", "the mother", "beta
 *      hCG", "sex of the foetus not disclosed" all pass THIS guard. (The F66 demographic tier still
 *      asks for a rephrase or the MS for a bare "female" on an obstetric report — that rule is
 *      unchanged here.)
 *
 * ═══ HOW TEXT IS COMPARED ═══
 *
 * Case-insensitive; Latin diacritics folded (NFKD, combining marks removed, `œ` → `oe`, so "fœtus"
 * and "Fötus" are foetuses); the Devanagari nukta folded (लड़का and लडका are one word); whole
 * words only, with Unicode letter boundaries — JavaScript's `\b` does not know Devanagari (see
 * `lockout.ts`). **Nothing is ever edited.** The guard refuses and names the words; the sonologist
 * rephrases. A filter that silently deleted "male" would leave "single live foetus" and hide what
 * was typed from the only person who can say why it was typed.
 *
 * **It is a tripwire, not a classifier** (the lockout's own words). It catches the habitual leak;
 * it cannot catch a determined one, and negation is not an escape: "the foetus is not male" is a
 * disclosure, so it is refused.
 */

export type FoetalSexRule = "sex_beside_foetus" | "sex_as_value" | "obstetric_term";
export type FoetalSexHit = { rule: FoetalSexRule; matched: string; index: number };

/** Case, Latin diacritics and the Devanagari nukta folded; nothing else changed, lengths kept close. */
export function foldForGuard(text: string): string {
  return text
    .replace(/[œŒ]/g, "oe")
    .normalize("NFKD")
    .replace(/[̀-़ͯ]/g, "")
    .toLowerCase();
}

const B = "[\\p{L}\\p{N}\\p{M}_]";
const alt = (xs: readonly string[]): string => xs.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const word = (xs: readonly string[]): string => `(?<!${B})(?:${alt(xs)})(?!${B})`;

/** The words for a sex. Devanagari after nukta folding. */
const SEX = ["male", "female", "masculine", "feminine", "नर", "मादा", "पुरुष", "स्त्री"];
/** Nouns that can only mean the foetus, on any report. */
const FOETAL_STRICT = [
  "foetus", "fetus", "foetuses", "fetuses", "foetal", "fetal", "foeti", "feti", "embryo", "embryos",
  "भ्रूण", "गर्भस्थ",
];
/** Nouns that mean the foetus on an obstetric report (and may mean a born child elsewhere). */
const FOETAL_OBSTETRIC = [
  "baby", "babies", "twin", "twins", "triplet", "triplets", "genitalia", "genitals", "genital",
  "sex", "gender", "शिशु", "बच्चा", "बच्चे", "लिंग",
];
/** Words allowed between a sex word and a foetal noun without breaking the phrase. */
const FILLER = [
  "single", "live", "living", "viable", "intrauterine", "healthy", "normal", "normally", "growing",
  "developed", "the", "a", "an", "is", "are", "was", "appears", "appear", "seems", "looks", "likely",
  "probably", "possibly", "most", "to", "be", "of", "sex", "gender", "first", "second", "one",
  "b", "c", "d", "1", "2", "3", "है", "का", "की", "के",
];
/** Words with no innocent reading on an obstetric scan. */
const OBSTETRIC_TERMS = [
  "boy", "boys", "girl", "girls", "male", "males", "masculine",
  "लडका", "लडकी", "लडके", "लडकियां", "लडकियाँ", "ladka", "ladki", "ladke", "ladkiyan",
  "scrotum", "scrotal", "penis", "penile", "phallus", "testis", "testes", "testicle", "testicles",
  "labia", "labial", "clitoris", "vulva", "vulval",
  "turtle sign", "hamburger sign",
];

/**
 * Between the two words: spaces, a colon, a dash or an equals sign, and filler words. A comma and a
 * full stop BREAK the phrase — "28 y, female, single live intrauterine foetus" is the mother, then
 * the foetus, and must pass.
 */
const GAP = `(?:[\\s:=\\-–—]+(?:${alt(FILLER)})(?!${B}))*[\\s:=\\-–—]+`;

function compile(nouns: readonly string[]): { sexThenNoun: RegExp; nounThenSex: RegExp } {
  return {
    sexThenNoun: new RegExp(`${word(SEX)}${GAP}${word(nouns)}`, "gu"),
    nounThenSex: new RegExp(`${word(nouns)}${GAP}${word(SEX)}`, "gu"),
  };
}

const STRICT = compile(FOETAL_STRICT);
const OBSTETRIC = compile([...FOETAL_STRICT, ...FOETAL_OBSTETRIC]);
const AS_VALUE = new RegExp(
  `${word(["sex", "gender", "लिंग"])}\\s*[:=\\-–—]\\s*${word([...SEX, "m", "f", "boy", "girl", "लडका", "लडकी"])}`,
  "gu",
);
const TERMS = new RegExp(word(OBSTETRIC_TERMS), "gu");

function collect(re: RegExp, text: string, folded: string, rule: FoetalSexRule, out: FoetalSexHit[]): void {
  re.lastIndex = 0;
  let m = re.exec(folded);
  while (m !== null) {
    // Folding can shorten a string (a stripped mark), so the ORIGINAL words are quoted where they line up.
    const original = folded.length === text.length ? text.slice(m.index, m.index + m[0].length) : m[0];
    out.push({ rule, matched: original.replace(/\s+/g, " ").trim(), index: m.index });
    m = re.exec(folded);
  }
}

/**
 * Every phrase in `text` that states the sex of a foetus. `obstetric` widens the nouns and adds
 * rules 2 and 3 (see the header). Deterministic, pure, and never edits the text.
 */
export function findFoetalSexDisclosures(text: string, opts: { obstetric: boolean }): FoetalSexHit[] {
  const folded = foldForGuard(text);
  const out: FoetalSexHit[] = [];
  const nouns = opts.obstetric ? OBSTETRIC : STRICT;
  collect(nouns.sexThenNoun, text, folded, "sex_beside_foetus", out);
  collect(nouns.nounThenSex, text, folded, "sex_beside_foetus", out);
  if (opts.obstetric) {
    collect(AS_VALUE, text, folded, "sex_as_value", out);
    collect(TERMS, text, folded, "obstetric_term", out);
  }
  // One phrase can match two rules ("male foetus" is also a bare "male"): keep the widest per start.
  out.sort((a, b) => a.index - b.index || b.matched.length - a.matched.length);
  const seen: FoetalSexHit[] = [];
  for (const h of out) {
    const last = seen[seen.length - 1];
    if (last && h.index < last.index + last.matched.length) continue;
    seen.push(h);
  }
  return seen;
}
