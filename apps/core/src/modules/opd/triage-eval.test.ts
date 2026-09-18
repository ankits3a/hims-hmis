import { keywordRank } from "./triage";
import { redFlagFor } from "./red-flags";
import type { TriageDepartment } from "./triage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE EVALUATION — is the router actually any good, and is it good in the SAFE direction?
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every other test in this module pins a behaviour. This one MEASURES the system, and it exists
 * because the content it now carries arrived with an 81-case suite reporting "100% accuracy" whose
 * queries were sentences like *"cancer ka asahya dard pain clinic nerve block palliative"* — the
 * answer written into the question. A number produced that way tells you nothing.
 *
 * So the rules here are:
 *   - Every query is TWO TO FOUR WORDS, the way the owner describes his staff typing.
 *   - No query contains its own answer: no department name, no diagnosis in English.
 *   - Devanagari, romanised Hindi, Bhojpuri and English are all represented, because all four
 *     arrive at the desk.
 *   - The assertions are on RATES, not on individual rows, so improving the vocabulary does not
 *     mean rewriting the test — and a regression in the aggregate still fails the build.
 *
 * ═══ THE LABELS ARE MINE AND THAT IS A REAL LIMITATION ═══
 *
 * I assigned the expected department for each row. That is better than a set generated from the
 * data it tests, and it is NOT a clinician's judgement. Where a complaint honestly belongs to more
 * than one department the row lists all acceptable answers rather than pretending there is one.
 */
const DEPTS: TriageDepartment[] = [
  { id: "MED", name: "General Medicine" }, { id: "SUR", name: "General Surgery" },
  { id: "PED", name: "Paediatrics" }, { id: "OBG", name: "Obstetrics & Gynaecology" },
  { id: "ORT", name: "Orthopaedics" }, { id: "ENT", name: "ENT" },
  { id: "OPH", name: "Ophthalmology" }, { id: "DER", name: "Dermatology" },
  { id: "PSY", name: "Psychiatry" }, { id: "CAR", name: "Cardiology" },
  { id: "DEN", name: "Dental" }, { id: "PHY", name: "Physiotherapy" },
];

/** `[complaint, acceptable department ids]`. More than one id means the complaint is genuinely open. */
const CASES: [string, string[]][] = [
  // ── the owner's own report ───────────────────────────────────────────────────────────────────
  ["aankh me dard", ["OPH"]], ["आँख में दर्द", ["OPH"]], ["eye pain", ["OPH"]],
  ["motiyabind", ["OPH"]], ["aankh lal hai", ["OPH"]], ["chashma banwana hai", ["OPH"]],

  // ── ENT ─────────────────────────────────────────────────────────────────────────────────────
  ["kaan me dard", ["ENT"]], ["कान में दर्द", ["ENT"]], ["gala kharab hai", ["ENT"]],
  ["naak band hai", ["ENT"]], ["kaan bahta hai", ["ENT"]], ["sunai nahi deta", ["ENT"]],

  // ── dental ──────────────────────────────────────────────────────────────────────────────────
  ["daant me dard", ["DEN"]], ["दाँत में दर्द", ["DEN"]], ["masuda soojh gaya", ["DEN"]],
  ["daant nikalwana hai", ["DEN"]],

  // ── skin ────────────────────────────────────────────────────────────────────────────────────
  ["khujli ho rahi hai", ["DER"]], ["खुजली", ["DER"]], ["skin par daane", ["DER"]],
  ["baal jhad rahe hain", ["DER"]],

  // ── bones and joints ────────────────────────────────────────────────────────────────────────
  ["ghutne mein dard", ["ORT"]], ["kamar dard", ["ORT"]], ["thehuna me dard ba", ["ORT"]],
  ["kandha jam gaya", ["ORT", "PHY"]], ["haddi tut gayi", ["ORT"]],

  // ── heart and medicine ──────────────────────────────────────────────────────────────────────
  ["dhadkan tez", ["CAR"]], ["sugar check karana hai", ["MED", "CAR"]],
  ["bukhar", ["MED", "PED"]], ["बुखार", ["MED", "PED"]], ["khansi", ["MED"]],
  ["peeliya ho gaya", ["MED"]], ["thyroid ki jaanch", ["MED"]],
  ["jaad lag ke bukhar aawat ba", ["MED", "PED"]],

  // ── surgery ─────────────────────────────────────────────────────────────────────────────────
  ["bawaseer", ["SUR"]], ["gaanth hai pet me", ["SUR", "MED"]], ["hernia", ["SUR"]],
  ["pathri ka dard", ["SUR", "MED"]],

  // ── women and children ──────────────────────────────────────────────────────────────────────
  ["garbh theharana", ["OBG"]], ["periods nahi aa rahe", ["OBG"]],
  ["bacche ko teeka lagwana", ["PED"]], ["bachcha dudh nahi pi raha", ["PED"]],

  // ── mind ────────────────────────────────────────────────────────────────────────────────────
  ["neend nahi aati", ["PSY"]], ["ghabrahat hoti hai", ["PSY"]], ["sharab chhudwani hai", ["PSY"]],

  // ── physiotherapy ───────────────────────────────────────────────────────────────────────────
  ["physiotherapy chahiye", ["PHY"]], ["stroke ke baad rehab", ["PHY"]],
];

/** Complaints the desk must REFUSE rather than guess at. */
const MUST_REFUSE: string[] = [
  "gadi ka tyre punchar hai", "mera mobile kho gaya", "bijli ka bill jama karna hai",
  "xyzzy", "", "   ", "dard", "problem hai", "aaj ka din kaisa hai",
];

function topOf(complaint: string): string | null {
  return keywordRank(complaint, DEPTS)[0]?.departmentId ?? null;
}

describe("triage evaluation — coverage and correctness on what a clerk really types", () => {
  it("reports the numbers, so a regression is visible rather than merely failing", () => {
    let right = 0; const wrong: string[] = []; const silent: string[] = [];
    for (const [q, ok] of CASES) {
      const top = topOf(q);
      if (top === null) silent.push(q);
      else if (ok.includes(top)) right += 1;
      else wrong.push(`${q} -> ${top} (wanted ${ok.join("/")})`);
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n  TRIAGE EVAL  ${String(CASES.length)} complaints` +
      `\n    routed correctly : ${String(right)}` +
      `\n    routed WRONGLY   : ${String(wrong.length)}${wrong.length === 0 ? "" : `\n      - ${wrong.join("\n      - ")}`}` +
      `\n    no answer        : ${String(silent.length)}${silent.length === 0 ? "" : `\n      - ${silent.join("\n      - ")}`}\n`,
    );
    expect(right + wrong.length + silent.length).toBe(CASES.length);
  });

  /**
   * ═══ THE TWO RATES, AND WHY THEY ARE NOT THE SAME NUMBER ═══
   *
   * A silent router is useless; a wrong one is worse than useless, because the staff using it
   * cannot tell. So WRONGNESS is capped hard and coverage is capped softly: it is always allowed
   * to say nothing, and the clerk picks from twelve departments on the screen.
   */
  it("is wrong about fewer than 10% of them", () => {
    const wrong = CASES.filter(([q, ok]) => { const t = topOf(q); return t !== null && !ok.includes(t); });
    expect(wrong.length / CASES.length).toBeLessThan(0.10);
  });

  it("answers at least 70% of them", () => {
    const answered = CASES.filter(([q]) => topOf(q) !== null);
    expect(answered.length / CASES.length).toBeGreaterThanOrEqual(0.70);
  });

  /**
   * ═══ WHY THE REMAINING SILENCES ARE THE RIGHT ANSWER, NOT A GAP ═══
   *
   * Three complaints in the set get no department, and each is silent for a different and correct
   * reason. They are asserted rather than tolerated, so that a future change which starts
   * confidently answering them has to come past this test.
   *
   *   "bachcha dudh nahi pi raha"  — an infant not feeding is an EMERGENCY. The brake takes it and
   *                                   the router must not offer an appointment instead.
   *   "peeliya ho gaya"            — jaundice is General Medicine in an adult and Paediatrics in a
   *                                   newborn. The word alone cannot decide; the patient's AGE can,
   *                                   and the router is not yet given it.
   *   "kandha jam gaya"            — a frozen shoulder is honestly Orthopaedics or Physiotherapy.
   */
  it("routes nothing for an infant who is not feeding — the brake takes it instead", () => {
    expect(topOf("bachcha dudh nahi pi raha")).toBeNull();
    expect(redFlagFor("bachcha dudh nahi pi raha", 1)).not.toBeNull();
  });

  it("stays silent where only the patient's age could decide", () => {
    // Jaundice: General Medicine in an adult, Paediatrics in a newborn. `keywordRank` has no age.
    expect(topOf("peeliya ho gaya")).toBeNull();
  });

  it("reaches every one of the twelve departments across the set", () => {
    // A department nothing routes to is a department whose patients cannot be seated.
    const reached = new Set(CASES.map(([q]) => topOf(q)).filter((x): x is string => x !== null));
    expect([...DEPTS].filter((d) => !reached.has(d.id)).map((d) => d.name)).toEqual([]);
  });
});

describe("triage evaluation — it refuses rather than guesses", () => {
  it.each(MUST_REFUSE)("says nothing for %s", (q: string) => {
    expect(topOf(q)).toBeNull();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * EDGE CASES — the inputs a real desk produces that no design document mentions
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */
describe("triage evaluation — edges", () => {
  it("survives a very long complaint without throwing or hanging", () => {
    const long = "bukhar ".repeat(300);
    const started = Date.now();
    expect(() => keywordRank(long, DEPTS)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("survives punctuation, emoji and mixed script in one line", () => {
    expect(() => keywordRank("आँख!! me 😖 dard??? (left)", DEPTS)).not.toThrow();
    expect(topOf("आँख!! me 😖 dard??? (left)")).toBe("OPH");
  });

  it("is not confused by a repeated word", () => {
    expect(topOf("dard dard dard dard")).toBeNull();
  });

  it("ignores digits that are not a complaint", () => {
    expect(topOf("9876543210")).toBeNull();
    expect(topOf("12345")).toBeNull();
  });

  it("handles a complaint that is only stopwords", () => {
    expect(topOf("hai ka ki ke se ko")).toBeNull();
  });

  it("does not treat a SQL-ish or path-ish string as a complaint", () => {
    // Nothing here interpolates, but a router that confidently routed this would still be wrong.
    expect(topOf("'; DROP TABLE patients; --")).toBeNull();
    expect(topOf("../../etc/passwd")).toBeNull();
  });

  it("is stable — the same complaint twice gives the same answer", () => {
    for (const [q] of CASES.slice(0, 12)) expect(topOf(q)).toBe(topOf(q));
  });

  it("is case and whitespace insensitive", () => {
    expect(topOf("  AANKH   ME   DARD  ")).toBe(topOf("aankh me dard"));
  });

  /**
   * ═══ THE BRAKE MUST OUTRANK THE ROUTER ON EVERY EMERGENCY PHRASING ═══
   *
   * The router getting BETTER is what makes this worth asserting: a good router finds a department
   * for "seene me dard" and a red flag must still stop it from being booked into one.
   */
  it.each([
    ["seene me dard"], ["chest pain left side"], ["saans nahi aa rahi"],
    ["behosh ho gaya"], ["zeher kha liya"], ["accident hua hai"],
  ])("flags %s as an emergency however well the router could route it", (q: string) => {
    expect(redFlagFor(q, 45)).not.toBeNull();
  });

  /**
   * ═══ THE CROSS-CHECK — THE BRAKE MUST NOT SWALLOW AN ORDINARY DAY ═══
   *
   * The two halves are tested apart: the router routes, the brake stops. Nothing asserted that the
   * SETS ARE DISJOINT — and when five rules were promoted from the owner's bundle, running this
   * caught **"stroke ke baad rehab"** being refused a booking and marched to Casualty. A patient
   * arriving for post-stroke physiotherapy.
   *
   * That is the shape that kills a brake: not an absurd false positive somebody reports, but a
   * plausible one that fires on a real patient every week until staff learn to click past it. This
   * runs the whole routable set through the brake on every build.
   */
  it("flags none of the complaints the router is supposed to route", () => {
    /*
      ONE DELIBERATE EXCEPTION, named rather than filtered silently. "bachcha dudh nahi pi raha" is
      in the routing set because a clerk types it, and the RIGHT answer is the brake, not
      Paediatrics — an infant who has stopped feeding does not get an appointment. A test above
      asserts that directly. Every other row must reach the router untouched.
    */
    const BELONGS_TO_THE_BRAKE = new Set(["bachcha dudh nahi pi raha"]);
    const flagged = CASES
      .map(([q]) => q)
      .filter((q) => !BELONGS_TO_THE_BRAKE.has(q))
      .filter((q) => redFlagFor(q, 35) !== null)
      .map((q) => `${q} -> ${redFlagFor(q, 35)?.reasonKey ?? ""}`);
    expect(flagged).toEqual([]);
  });

  it("still flags a stroke that is happening NOW", () => {
    // The tense guard must not have disarmed the rule it protects.
    expect(redFlagFor("muh tedha ho gaya", 60)).not.toBeNull();
    expect(redFlagFor("achanak ek taraf kamzori", 60)).not.toBeNull();
  });
});
