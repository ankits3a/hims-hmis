import { KNOWLEDGE } from "./knowledge";
import { SPECIFIED_LABELS, UNSPECIFIED, productSpecFor } from "./products";

/**
 * ═══ EVERY REGIMEN DRUG IS EITHER A COMPOSITION OR A STATED REFUSAL ═══
 *
 * A bundle label with neither fills as free text again, silently, which is the production defect
 * of 2026-09-23. This census fails on a new label until somebody decides which it is.
 */
describe("cds product specs cover the bundle", () => {
  const labels = [...new Set(KNOWLEDGE.syndromes.flatMap((s) => s.lines.map((l) => l.drugLabel)))];

  it("every drug label in knowledge.json is specified or refused with a reason — never neither, never both", () => {
    expect(labels.length).toBe(41);
    const neither = labels.filter((l) => productSpecFor(l) === null && UNSPECIFIED[l] === undefined);
    const both = labels.filter((l) => productSpecFor(l) !== null && UNSPECIFIED[l] !== undefined);
    expect(neither).toEqual([]);
    expect(both).toEqual([]);
    expect(labels.filter((l) => productSpecFor(l) !== null)).toHaveLength(28);
    expect(Object.keys(UNSPECIFIED)).toHaveLength(13);
  });

  it("the four lines of prescription 01M36QQXMD7DKKHZ7MF2ZC1N8W are compositions, and 625 is 500 + 125", () => {
    expect(productSpecFor("Amoxicillin and Clavulanic Acid 625mg")).toEqual({
      form: "tablet", components: [{ moiety: "amoxicillin", mg: 500 }, { moiety: "clavulanic acid", mg: 125 }],
    });
    for (const l of ["Paracetamol Tablets 650mg", "Levocetirizine 5mg + Ambroxol 60mg", "Pantoprazole 40mg"]) {
      expect(productSpecFor(l)).not.toBeNull();
    }
  });

  it("every spec names at least one moiety at a positive strength", () => {
    for (const l of SPECIFIED_LABELS) {
      const s = productSpecFor(l)!;
      expect(s.components.length).toBeGreaterThan(0);
      expect(s.components.every((c) => c.moiety.trim() !== "" && c.mg > 0)).toBe(true);
    }
  });
});
