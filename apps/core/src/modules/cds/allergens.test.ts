import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { formularySalts } from "../../kernel/db/schema";
import { ALLERGEN_MIN_CHARS, matchesAKnownAllergen, searchAllergens } from "./allergens";
import { buildRegimen } from "./regimen";
import type { Db } from "../../kernel/db/client";
import type { PatientFacts } from "./regimen";

/**
 * ═══ THE TYPO THAT SILENCES A GUARD ═══
 *
 * `blockedBy` matches a patient's allergy TEXT against each rule's allergen and `blocked_classes`
 * on tokens of five letters or more. `pencilin` — one letter short, a real thing to type at a busy
 * desk — matches nothing, and the penicillin block never fires again for that patient. No error, no
 * warning: a guard with nothing to say.
 *
 * A1 is that failure, written down. A2 is the fix. Everything else is the field that makes the fix
 * reachable without asking a doctor to spell a molecule under time pressure.
 */
const AUDIT = { createdBy: "t", updatedBy: "t" };
const facts = (over: Partial<PatientFacts> = {}): PatientFacts => ({
  ageYears: 34, weightKg: 62, allergies: [], allergenClasses: [], pregnant: false, ...over,
});

/** SYN_URI_01's adult first line is a beta-lactam, which is what a penicillin allergy must displace. */
const URI = "SYN_URI_01";

describe("the allergy a doctor records in the room", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function seedSalts(): Promise<void> {
    await db.insert(formularySalts).values([
      { id: "S1", name: "Penicillin", productCount: 400, ...AUDIT },
      { id: "S2", name: "Amoxicillin", productCount: 3830, ...AUDIT },
      { id: "S3", name: "Iodinated contrast media", productCount: 12, ...AUDIT },
      { id: "S4", name: "Peanut protein", productCount: 1, ...AUDIT },
    ]);
  }

  it("A1: a MISSPELT allergy matches no rule — the defect this work exists for", async () => {
    const spelt = buildRegimen(URI, facts({ allergies: ["Penicillin"] }));
    const typo = buildRegimen(URI, facts({ allergies: ["pencilin"] }));

    const blocked = (r: typeof spelt): boolean => (r?.lines ?? []).some((l) => l.dose.state === "blocked" || l.substitutedFor !== undefined);
    expect(blocked(spelt)).toBe(true);
    // The record LOOKS the same to a human reading the chart and is silent to the guard.
    expect(blocked(typo)).toBe(false);
    expect(matchesAKnownAllergen("pencilin")).toBe(false);
    expect(matchesAKnownAllergen("Penicillin")).toBe(true);
  });

  it("A2: the CODED class fires the rule even when the words are misspelt", async () => {
    const typoButPicked = buildRegimen(URI, facts({
      allergies: ["pencilin"],
      allergenClasses: ["Penicillins / Beta-Lactams"],
    }));
    expect((typoButPicked?.lines ?? []).some((l) => l.dose.state === "blocked" || l.substitutedFor !== undefined)).toBe(true);
  });

  it("A3: a class outranks a moiety, and says what it will block", async () => {
    await seedSalts();
    const hits = await searchAllergens(db, "penicillin");
    expect(hits[0]!.kind).toBe("class");
    expect(hits[0]!.allergenClass).toBe("Penicillins / Beta-Lactams");
    // Recording the class protects against all seven members, which is what was actually meant.
    expect(hits[0]!.blocks).toContain("Amoxicillin");
    expect(hits[0]!.blocks).toContain("Cephalexin");
  });

  it("A4: AUTOCORRECT — `pencilin` reaches Penicillin without a model", async () => {
    await seedSalts();
    const hits = await searchAllergens(db, "pencilin");
    // pg_trgm similarity, off the index the drug typeahead already added.
    expect(hits.map((h) => h.term.toLowerCase())).toContain("penicillin");
  });

  it("A5: naming the DRUG the patient reacted to reaches its class", async () => {
    await seedSalts();
    /* The commonest way to say "penicillin allergy" at an Indian OPD is to name the drug taken.
       Without the blocked_classes arm of the match, this found the bare moiety and no class. */
    const hits = await searchAllergens(db, "amoxicillin");
    expect(hits[0]!.allergenClass).toBe("Penicillins / Beta-Lactams");
  });

  it("A6: a moiety with no rule is still offered — the six classes are not the whole world", async () => {
    await seedSalts();
    const hits = await searchAllergens(db, "peanut");
    expect(hits.map((h) => h.term)).toContain("Peanut protein");
    expect(hits[0]).toMatchObject({ kind: "moiety", allergenClass: null, saltId: "S4" });
  });

  it("A7: under the floor it answers nothing rather than the catalogue", async () => {
    await seedSalts();
    expect(ALLERGEN_MIN_CHARS).toBe(3);
    expect(await searchAllergens(db, "pe")).toEqual([]);
  });

  it("A8: `known` is the truth about the GUARD, not a second opinion", async () => {
    /* It uses the guard's own token rule, so a warning appears exactly when the block would be
       silent — never when the block would have fired anyway. */
    expect(matchesAKnownAllergen("Amoxicillin")).toBe(true);
    expect(matchesAKnownAllergen("the red syrup")).toBe(false);
    expect(matchesAKnownAllergen("dust")).toBe(false); // under the five-letter token floor
  });
});
