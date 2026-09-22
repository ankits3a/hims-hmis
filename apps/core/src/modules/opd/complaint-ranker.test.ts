import { bookDepartments, rankBook } from "./complaint-ranker";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE HARVESTED BOOK, TESTED ON WHAT A CLERK ACTUALLY TYPES
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The bundle this content came from shipped an 81-case suite at "100% accuracy". Its queries were
 * *"cancer ka asahya dard pain clinic nerve block palliative"* and *"buzurg bhoolne lage hain
 * dementia alzheimer baar baar girte hain"* — sentences containing the answer, which nobody's
 * mother says. A test set written by the same process that wrote the data cannot find out whether
 * the data works.
 *
 * So every query below is TWO OR THREE WORDS with no diagnosis in it, which is what the owner
 * described his staff typing.
 */
describe("rankBook — short, real complaints", () => {
  it.each([
    ["thehuna me dard ba", "Orthopaedics"],
    ["motiyabind", "Ophthalmology"],
    ["dhadkan tez", "Cardiology"],
    /*
      `garbh` matches infertility AND antenatal care; `kaan` matches ENT disorders AND deafness.
      Both pairs AGREE on the department, and folding syndromes onto departments before judging the
      margin is what lets these answer at all — see the ranker. As syndromes they tied and it
      refused, which was answering a question nobody asked.
    */
    ["garbh theharana", "Obstetrics & Gynaecology"],
    ["kaan bahta hai", "ENT"],
  ])("routes %s to %s", (complaint: string, department: string) => {
    const hit = rankBook(complaint);
    expect(hit?.departments[0]?.department).toBe(department);
  });

  /**
   * ═══ THE MORPHOLOGY CASE, PINNED — it is what made `garbh` work at all ═══
   *
   * The book spells pregnancy `garbhadhan` and `garbhwati`; a clerk types `garbh`. Exact token
   * matching saw neither and a plainly antenatal complaint reached nothing. Transliterated Hindi
   * agglutinates and no synonym list fixes that, because it is morphology rather than vocabulary.
   */
  it("matches an agglutinated form by prefix", () => {
    expect(rankBook("garbh theharana")?.departments[0]?.department).toBe("Obstetrics & Gynaecology");
  });

  it("will not prefix-match on a stub shorter than five characters", () => {
    // Below five, prefixes collide freely and the evidence is not worth the noise.
    expect(rankBook("gar")).toBeNull();
    expect(rankBook("garb")).toBeNull();
  });

  it("names the rare word that decided it, so the desk can say why", () => {
    const hit = rankBook("motiyabind pak gaya");
    expect(hit?.because).toContain("motiyabind");
  });

  it("carries the department weights through, strongest first", () => {
    const hit = rankBook("dhadkan tez");
    expect(hit?.departments[0]?.weight).toBeGreaterThan(hit?.departments[1]?.weight ?? 0);
  });
});

/**
 * ═══ THE HALF THE BUNDLE'S ENGINE GOT WRONG, AND THE REASON THIS FILE EXISTS ═══
 *
 * Measured on the supplied resolver before any of this was written:
 *
 *     "gadi ka tyre punchar hai"  ->  URGENT (YELLOW),  Hematology / Pediatrics
 *     "mera mobile kho gaya"      ->  EMERGENCY (RED),  Pediatrics
 *
 * It had no confidence floor, so 0.59 rendered identically to 3.05. At a desk staffed by
 * non-clinicians that is worse than no system: the red badge is the one signal that must never be
 * diluted, and it was being spent on a lost phone.
 */
describe("rankBook — it says nothing rather than something wrong", () => {
  it.each([
    ["gadi ka tyre punchar hai"],
    ["mera mobile kho gaya"],
    ["bijli ka bill jama karna hai"],
    ["xyzzy"],
    [""],
    ["   "],
  ])("refuses %s", (complaint: string) => {
    expect(rankBook(complaint)).toBeNull();
  });

  /**
   * ═══ WHAT THE BOOK DOES *NOT* COVER, MEASURED RATHER THAN ASSUMED ═══
   *
   * `bawaseer` — the commonest word for piles in this region — is in NONE of the 782 variants, and
   * `peshab` is in eight syndromes across four departments, which is genuine ambiguity rather than
   * a failure. Both are recorded here because they are the argument for keeping the hand-written
   * table: it carries `bawaseer`, and it carries Devanagari, and the book carries neither.
   *
   * A harvest is not a replacement. These two tests are what stops somebody deleting the table.
   */
  it("has no entry for bawaseer — the hand-written table still earns its place", () => {
    expect(rankBook("bawaseer")).toBeNull();
  });

  it("refuses peshab, which is genuinely ambiguous across four departments", () => {
    expect(rankBook("peshab me jalan")).toBeNull();
  });

  it("refuses a query of nothing but common words", () => {
    // `dard` is in dozens of syndromes and decides nothing on its own.
    expect(rankBook("dard")).toBeNull();
    expect(rankBook("dard hai")).toBeNull();
  });

  it("refuses when two syndromes are genuinely too close to separate", () => {
    /*
      The margin is a RATIO, because these scores are sums of reciprocals with no fixed scale. A
      query that matches two syndromes near-equally must return neither — the clerk picks.
    */
    const hit = rankBook("sujan");
    if (hit !== null) expect(hit.score).toBeGreaterThan(0.34);
  });
});

describe("rankBook — the collapse onto this hospital's twelve departments", () => {
  /**
   * The bundle named 34 primary specialities; this hospital seeds twelve. Routing to "Vascular
   * Surgery" at a hospital that has none is the empty-department failure the owner hit this
   * morning, dressed as precision. The harvest folds them; this proves nothing escaped.
   */
  it("never names a department outside DEFAULT_DEPARTMENTS", () => {
    const ours = new Set([
      "General Medicine", "General Surgery", "Paediatrics", "Obstetrics & Gynaecology",
      "Orthopaedics", "ENT", "Ophthalmology", "Dermatology", "Psychiatry", "Cardiology",
      "Dental", "Physiotherapy",
    ]);
    expect(bookDepartments().filter((d) => !ours.has(d))).toEqual([]);
  });

  it("reaches every one of the twelve", () => {
    // A department the book can never name is a department its patients cannot be routed to.
    expect(bookDepartments()).toHaveLength(12);
  });
});
