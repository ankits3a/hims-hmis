/**
 * PLAN 18a T6 / A5 — **THE LEXICAL LOCKOUT: the words a radiology report may not carry.**
 *
 * ═══ WHAT THIS IS FOR, AND WHY IT IS A LEXICON RATHER THAN A JUDGEMENT ═══
 *
 * Section 5(2) of the PCPNDT Act forbids communicating the sex of a foetus "in any manner". In
 * practice that communication is never the word "female" — it is a code, and the codes are
 * well documented in the Act's own prosecutions: *"distribute sweets"*, *"paint the room blue"*,
 * *"Jai Mata Di"*, a plain **beta** or **beti**. So the lockout is a WORD LIST checked at signing
 * time, and it blocks the signature rather than silently editing the text: a radiologist who meant
 * something innocent must be able to see what tripped and rephrase it, and a radiologist who did
 * not must be stopped by a person rather than by a filter.
 *
 * **It is a tripwire and not a classifier.** It cannot read intent, it will never catch a
 * determined evader, and that is not the claim. The claim is that the ORDINARY leak — a sonologist
 * typing "beta" into an impression out of habit — cannot reach a signed report by accident.
 *
 * ═══ A HYPHEN BINDS, AND `beta-blocker` IS WHY (A5) ═══
 *
 * A5 names three strings that must NOT trip: `boycott`, `Mumbai`, `beta-blocker`. The first is
 * ordinary word-boundary matching. **The third is not**, and it is the one that decides the design:
 * `-` is not a word character in any regex flavour, so a plain word-boundary matcher sees `beta`
 * in `beta-blocker` as a whole word and trips on every cardiology report in the building.
 *
 * A5's mutant states the harm exactly — *"substring match → every beta-blocker report is
 * unsignable, and the clinic disables the lockout"* — and a lockout that is switched off protects
 * nobody. **So a hyphen counts as a word character for boundary purposes.** The cost is disclosed
 * rather than hidden: `boy-child` does not trip either. The Act's harm model puts a control the
 * floor turns off well above a phrasing the control misses, and §5 T6 A5 names `beta-blocker`
 * explicitly while naming no hyphenated positive.
 *
 * ═══ DEVANAGARI IS FIRST-CLASS, AND JAVASCRIPT'S `\b` CANNOT DO IT ═══
 *
 * `\b` is defined against `\w`, which is `[A-Za-z0-9_]`. Every Devanagari letter is therefore a
 * NON-word character to it, so `\bबेटा\b` matches nothing at all — silently, and in the direction
 * that fails open. The boundaries below are Unicode property escapes under the `u` flag
 * (`\p{L}`, `\p{N}`, `\p{M}`), with `\p{M}` included so a trailing vowel sign does not read as the
 * end of a word.
 */

/**
 * The lexicon. Romanised and Devanagari forms are BOTH listed rather than transliterated at match
 * time: transliteration is lossy in both directions and a statutory control should be a list a
 * medical superintendent can read, amend and sign off — not the output of an algorithm.
 *
 * Grouped by why each entry is here, because a reviewer's first question about a word list is
 * always "who decided this".
 */
/**
 * ═══ TWO TIERS, AND FINDING F66 (CLOSE REVIEW, OWNER RULING 2026-09-01) IS WHY ═══
 *
 * The first version was ONE list applied to EVERY report in the department, and the list contains
 * `male`, `female` and `beta`. **`"45-year-old male, chest PA view. No focal consolidation."` could
 * not be signed.** Neither could `"correlate with serum beta hCG"`. There was no waiver, no
 * override and no medical-superintendent lane — while the refusal text told the radiologist to go
 * and see the medical superintendent, who had no route that could let anything through.
 *
 * This file's own header names the harm that produces: *"a lockout that is switched off protects
 * nobody"*, and a control that refuses the demographic line of an ordinary chest X-ray is a control
 * a department disables in its first week. The tripwire was catching the whole building instead of
 * the leak.
 *
 * **DEMOGRAPHIC** — the plain words for a sex. They are what a §5(2) disclosure says, and they are
 * ALSO what every radiology report says in its first line about a living patient. Applied only in an
 * obstetric context (see `reports.ts`'s `lockoutTierFor`).
 *
 * **CODED** — the euphemisms and the karyotype. `mithai`, `laddu`, `Jai Mata Di`, blue and pink
 * rooms, `XX`/`XY`, and the naming of the act itself. **None of these has an innocent use in a
 * radiology report**, which is exactly why they are the entries the Act's prosecutions turn on.
 * Applied to EVERY report, always, with no exception lane — the strengthening the first version was
 * reaching for, kept where it costs nothing.
 */
export const LOCKOUT_LEXICON_DEMOGRAPHIC: readonly string[] = [
  // ── the sex itself, plainly. These have ordinary uses in an ordinary report. ──
  "boy", "girl", "male", "female", "son", "daughter",
  "लड़का", "लड़की", "बेटा", "बेटी", "पुत्र", "पुत्री",
  "ladka", "ladki", "beta", "beti", "putra", "putri",
  "chhora", "chhori", "छोरा", "छोरी",
];

export const LOCKOUT_LEXICON_CODED: readonly string[] = [
  // ── the karyotype, which is the same statement in a lab coat ──
  "xx", "xy",
  /**
   * ── the documented CODES, and these are the entries the Act's prosecutions actually turn on ──
   *
   * "Distribute sweets" and "Jai Mata Di" are not euphemisms a filter would guess; they are the
   * recorded phrasings from PCPNDT case law and from the appropriate authorities' own advisories.
   * A lexicon holding only the literal words would catch the careless and miss the practised.
   */
  "मिठाई", "mithai", "laddu", "लड्डू",
  "जय माता दी", "jai mata di",
  "नीला", "गुलाबी", "blue room", "pink room",
  // ── the question, which is as forbidden to answer as it is to record ──
  "sex determination", "gender determination", "लिंग परीक्षण", "ling parikshan",
];

/** Both tiers, for an obstetric-context report and for anything that wants the whole list. */
export const LOCKOUT_LEXICON: readonly string[] = [
  ...LOCKOUT_LEXICON_DEMOGRAPHIC,
  ...LOCKOUT_LEXICON_CODED,
];

/** Which words a given report is checked against. `coded` is the floor and applies to everything. */
export type LockoutTier = "coded" | "full";

/** A hit: the lexicon term, and where in the text it was found, so a screen can point at it. */
export type LockoutHit = { term: string; index: number; matched: string };

/**
 * The boundary class. A term must not be preceded or followed by a letter, a digit, a combining
 * mark, an underscore or a HYPHEN — see the header for why the hyphen is in this list and what it
 * costs.
 */
const BOUND = "[\\p{L}\\p{N}\\p{M}_-]";

/** Escapes a lexicon entry for use in a pattern. The list is code-owned, but a future one may not be. */
function escapeTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiled once. Each term gets its own pattern rather than one alternation, so a hit can name
 * WHICH term tripped — a report refused with "this text is not signable" and no word is a report
 * whose author has to guess, and guessing is how a control becomes something people route around.
 */
function compile(terms: readonly string[]): { term: string; re: RegExp }[] {
  return terms.map((term) => ({
    term,
    re: new RegExp(`(?<!${BOUND})${escapeTerm(term)}(?!${BOUND})`, "giu"),
  }));
}

const PATTERNS_CODED: readonly { term: string; re: RegExp }[] = compile(LOCKOUT_LEXICON_CODED);
const PATTERNS_FULL: readonly { term: string; re: RegExp }[] = compile(LOCKOUT_LEXICON);

/**
 * A5 — every lexicon term present in `text`, as whole words, case-insensitively, in both scripts.
 *
 * PURE: no database, no clock, no actor. That is deliberate and is the same argument
 * `applicability.ts` makes — a rule with a criminal statute behind it should be walkable at every
 * boundary for the cost of a string, so that nobody is tempted to prove it with one e2e that
 * happens to use the word "boy".
 */
export function findLockoutHits(text: string, tier: LockoutTier = "full"): LockoutHit[] {
  const hits: LockoutHit[] = [];
  for (const { term, re } of tier === "full" ? PATTERNS_FULL : PATTERNS_CODED) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      hits.push({ term, index: m.index, matched: m[0] });
      m = re.exec(text);
    }
  }
  return hits.sort((a, b) => a.index - b.index || a.term.localeCompare(b.term));
}

/** The one-line answer a signing path wants. */
export function isLockedOut(text: string, tier: LockoutTier = "full"): boolean {
  return findLockoutHits(text, tier).length > 0;
}
