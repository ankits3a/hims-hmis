import { LOCKOUT_LEXICON, findLockoutHits, isLockedOut } from "./lockout";

/**
 * PLAN 18a T6 — Assertion Book row **A5**. Pure: no database, no fixture, no clock.
 *
 * A5's mutant is a SUBSTRING match, and the harm it names is the one that matters more than any
 * leak this lexicon could catch: *"every beta-blocker report is unsignable, and the clinic disables
 * the lockout."* A control the floor switches off protects nobody, so the negatives below carry as
 * much weight as the positives.
 */
describe("the lexical lockout (18a T6 A5)", () => {
  const terms = (text: string) => findLockoutHits(text).map((h) => h.term);

  /* ═══════════════════════ A5's four positives ═══════════════════════ */

  it("A5: finds `boy`, `ladki`, `बेटा` and `Beti` — case-insensitively and in both scripts", () => {
    expect(terms("it is a boy")).toContain("boy");
    expect(terms("ladki hai")).toContain("ladki");
    expect(terms("बेटा है")).toContain("बेटा");
    /** Case-insensitive, which is what a romanised lexicon needs to be worth having. */
    expect(terms("Beti")).toContain("beti");
    expect(terms("BETI")).toContain("beti");
  });

  /* ═══════════════════════ A5's three negatives ═══════════════════════ */

  /**
   * `boycott` and `beta-blocker` are the two that DISCRIMINATE against the substring mutant, and
   * they fail for two DIFFERENT reasons — which is why both are needed:
   *
   *   · `boycott` is ordinary word-boundary work: `boy` is followed by a letter.
   *   · `beta-blocker` is NOT. A hyphen is a non-word character in every regex flavour, so a plain
   *     `\b` matcher sees `beta` as a whole word here and trips. Only the hyphen-binds rule saves it.
   */
  it("A5: `boycott` and `beta-blocker` do NOT trip — and they fail for two different reasons", () => {
    expect(findLockoutHits("the residents called for a boycott of the meeting")).toEqual([]);
    expect(findLockoutHits("continue beta-blocker therapy")).toEqual([]);
    expect(findLockoutHits("Patient on beta-blockers and a statin.")).toEqual([]);
  });

  /**
   * ═══ A5's THIRD NEGATIVE IS A TRIVIAL ONE, AND SAYING SO IS THE HONEST MOVE (finding F26) ═══
   *
   * `Mumbai` is in the plan's list, and it passes — but it passes against the SUBSTRING mutant too,
   * because no term in the shipped lexicon is a substring of it (`mum`, `umb`, `mba`, `bai` are
   * none of them sex-determination language). It is a negative CONTROL rather than a discriminating
   * case, and it is asserted because the plan names it, not because it does work.
   *
   * The two rows above are the ones that would fail against the mutant. Recorded rather than
   * quietly dropped: AGENT-RULES §3 asks for an assertion that cannot discriminate to be reported.
   */
  it("A5: `Mumbai` does not trip — the plan's third negative, and it is a trivial one (F26)", () => {
    expect(findLockoutHits("referred from a clinic in Mumbai")).toEqual([]);
    expect(LOCKOUT_LEXICON.some((t) => "mumbai".includes(t.toLowerCase()))).toBe(false);
  });

  /* ═══════════════════════ the boundary rule, both directions ═══════════════════════ */

  it("a term inside a longer word never trips, in either script", () => {
    for (const clean of [
      "cowboys rode in", "girlish handwriting is not a finding", "the malefactor absconded",
      "sonography of the abdomen", "personnel", "बेटाओं",
    ]) {
      expect([clean, findLockoutHits(clean).length]).toEqual([clean, 0]);
    }
  });

  it("a term at a sentence edge, or against punctuation, DOES trip", () => {
    for (const dirty of ["boy", "Boy.", "(boy)", "a boy, clearly", "…beti?", "male/female"]) {
      expect([dirty, isLockedOut(dirty)]).toEqual([dirty, true]);
    }
  });

  /**
   * THE HYPHEN'S COST, ASSERTED RATHER THAN LEFT IMPLICIT. `boy-child` does not trip, and the file
   * header argues why that trade is the right way round. A test that only asserted the benefit
   * would let somebody "fix" the hyphen rule without seeing what they were breaking.
   */
  it("the hyphen binds BOTH ways — `boy-child` is not a hit, and that cost is deliberate", () => {
    expect(findLockoutHits("boy-child")).toEqual([]);
    expect(findLockoutHits("boy child")).toHaveLength(1);
  });

  /* ═══════════════════════ the coded language, which is the point ═══════════════════════ */

  /**
   * The literal words are the easy half. These are the recorded phrasings PCPNDT prosecutions
   * actually turn on, and a lexicon holding only "boy" and "girl" would catch the careless and miss
   * the practised.
   */
  it("catches the documented CODES, not only the literal words", () => {
    expect(terms("distribute mithai to the family")).toContain("mithai");
    expect(terms("जय माता दी")).toContain("जय माता दी");
    expect(terms("advised to paint the blue room")).toContain("blue room");
    expect(terms("sex determination is not performed here")).toContain("sex determination");
  });

  it("reports WHERE it tripped and what matched, so a screen can point at the word", () => {
    const hits = findLockoutHits("Impression: normal study. It is a boy.");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.matched.toLowerCase()).toBe("boy");
    expect("Impression: normal study. It is a boy.".slice(hits[0]!.index, hits[0]!.index + 3)).toBe("boy");
  });

  it("finds every hit in a text, ordered by position, not just the first", () => {
    const hits = findLockoutHits("beta today, beti tomorrow");
    expect(hits.map((h) => h.term)).toEqual(["beta", "beti"]);
    expect(hits[0]!.index).toBeLessThan(hits[1]!.index);
  });

  /** A clean impression is the common case and must cost nothing and trip nothing. */
  it("an ordinary radiology impression does not trip", () => {
    expect(findLockoutHits(
      "Single live intrauterine gestation corresponding to 19 weeks. Liquor adequate. "
      + "No gross structural anomaly. Placenta anterior, upper segment. Continue beta-blocker.",
    )).toEqual([]);
  });

  /** The lexicon is a list a medical superintendent signs off — so it is asserted to be one. */
  it("the lexicon carries both scripts and is free of blanks and duplicates", () => {
    expect(new Set(LOCKOUT_LEXICON).size).toBe(LOCKOUT_LEXICON.length);
    expect(LOCKOUT_LEXICON.every((t) => t.trim() === t && t.length > 0)).toBe(true);
    expect(LOCKOUT_LEXICON.some((t) => /[ऀ-ॿ]/.test(t))).toBe(true);
  });
});
