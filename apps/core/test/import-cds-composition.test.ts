import { DROP_BUDGET, assertDropRate, verdictFor } from "../scripts/import-cds-catalogue";
import type { Verdict } from "../scripts/import-cds-catalogue";

/**
 * ═══ A COMPOSITION IS WRITTEN WHOLE OR NOT AT ALL ═══
 *
 * The catalogue importer used to emit composition rows with
 * `if (saltId !== undefined) links.push(...)` — it silently dropped any component whose substance
 * ref did not resolve, with no count and no refusal. A product that is really amoxicillin +
 * clavulanic acid could be stored as amoxicillin alone, and nothing downstream could tell: every
 * guard in the prescribing and dispensing path tests for an EMPTY salt list and none tests for an
 * INCOMPLETE one, so a short list reads as a complete one all the way to `allergyHits: 0` in a
 * permanent dispense record.
 *
 * ═══ AND THIS SUITE IS THE FIRST THING THAT COMPILES THAT FILE AT ALL ═══
 *
 * Worth stating, because it is the reason the ruling behind this change was half wrong. Dropping
 * `source`'s column default was argued safe on the grounds that "`$inferInsert` makes the field
 * required and `tsc` names every insert site". It does — for files `tsc` actually reads.
 * `apps/core/tsconfig.json` includes `["src", "test", "drizzle.config.ts"]`, so a script under
 * `scripts/` is compiled ONLY if something under `src` or `test` imports it. Ten scripts are
 * imported by a test; `import-cds-catalogue.ts` was not one of them, so the compiler could not have
 * named the very writer this change is about. Importing it here fixes that as a side effect of
 * testing it, and the side effect is the more durable half.
 *
 * No database and no bundle: `verdictFor` is a pure function of a product and the set of substance
 * refs the bundle carries, which is exactly why the whole report can print on a dry run.
 */
const product = (refs: string[], orphanGeneric = false): Parameters<typeof verdictFor>[0] => ({
  sourceRef: "sctid-1", name: "Augmentin 625", form: "tablet", strength: "500 mg + 125 mg",
  route: "oral", code: null, substanceRefs: refs, orphanGeneric,
});

/** Real: Augmentin IS amoxicillin + clavulanic acid, and the bundle keys them by SNOMED id. */
const AMOXICILLIN = "372687004";
const CLAVULANIC = "372632007";
const KNOWN = new Set([AMOXICILLIN, CLAVULANIC]);

describe("the catalogue importer's composition plan", () => {
  it("passes a product whose every component resolves", () => {
    expect(verdictFor(product([AMOXICILLIN, CLAVULANIC]), KNOWN)).toBe<Verdict>("whole");
  });

  /**
   * THE CASE THIS CHANGE EXISTS FOR. Under the old loader this product was WRITTEN, carrying
   * amoxicillin alone — a real two-moiety antibiotic stored as a one-moiety one, indistinguishable
   * from a correct single-moiety product to every guard that reads it.
   */
  it("refuses a product whose components only PARTLY resolve", () => {
    expect(verdictFor(product([AMOXICILLIN, "not-in-this-bundle"]), KNOWN)).toBe<Verdict>("partial_refs");
  });

  /**
   * Separate from `partial_refs` and separately named, because the two mean different things to an
   * operator reading the report: some components unknown suggests an untidy release, NONE of them
   * known suggests the substances table was not parsed at all. Both are refused.
   */
  it("distinguishes a product where NO component resolves", () => {
    expect(verdictFor(product(["nope-1", "nope-2"]), KNOWN)).toBe<Verdict>("dangling_refs");
  });

  /**
   * An EMPTY composition is not a partial one. It is written, and every downstream guard already
   * handles it honestly — such a product is invisible to `searchMedicines` (both its branches
   * require a composition row), cannot be substituted (`equivalence.ts` refuses an empty `want`),
   * and renders as "not in formulary — advanced checks unavailable".
   */
  it("passes a product that names no components at all", () => {
    expect(verdictFor(product([]), KNOWN)).toBe<Verdict>("no_refs");
  });

  /**
   * Measured on the real bundle: this is what the 8 uncomposed medicines on the loaded catalogue
   * actually are — brands whose `generic_sctid` names no generic in the bundle. Their composition
   * is UNKNOWN rather than empty, which is why it is counted apart even though its fate is the same.
   */
  it("names a brand whose generic is missing, rather than calling it empty", () => {
    expect(verdictFor(product([], true), KNOWN)).toBe<Verdict>("orphan_generic");
    // and the orphan verdict wins even when the brand inherited refs from somewhere
    expect(verdictFor(product([AMOXICILLIN], true), KNOWN)).toBe<Verdict>("orphan_generic");
  });

  describe("the drop-rate fuse", () => {
    it("passes a release with a few unresolvable products", () => {
      expect(() => { assertDropRate(5, 100_000, 0); }).not.toThrow();
    });

    /**
     * A PARSE-SANITY CHECK, NOT A QUALITY BAR. Thousands of unresolvable products means the
     * substance list and the composition list were not read from the same bundle, or a column
     * moved — and importing a catalogue with a tenth of its compositions missing is the same silent
     * partial this change prevents, one level up.
     */
    it("refuses a release where a tenth of the catalogue cannot be resolved", () => {
      expect(() => { assertDropRate(10_000, 100_000, 0); })
        .toThrow(/over the 1\.00% budget/);
    });

    /** The refusal must TELL the operator the flag, or the only way past it is editing the source. */
    it("names the flag and the figure that would let the run through", () => {
      expect(() => { assertDropRate(10_000, 100_000, 0); })
        .toThrow(/--accept-drop-rate 0\.1/);
    });

    it("lets an operator raise the budget deliberately, for one run", () => {
      expect(() => { assertDropRate(10_000, 100_000, 0.2); }).not.toThrow();
    });

    /**
     * The flag RAISES the budget and cannot lower it below the default. A run that passed yesterday
     * must not fail today because somebody typed a smaller number, and the constant is the floor.
     */
    it("cannot be used to lower the budget below the default", () => {
      expect(DROP_BUDGET).toBe(0.01);
      expect(() => { assertDropRate(50, 100_000, 0.0001); }).not.toThrow();
    });

    it("says nothing about an empty bundle rather than dividing by zero", () => {
      expect(() => { assertDropRate(0, 0, 0); }).not.toThrow();
    });
  });
});
