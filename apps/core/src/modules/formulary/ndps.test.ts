import { ndpsClassOfMoieties, ndpsListEntryOf } from "./ndps";

/**
 * #613 — the formulary's own answer to "is this moiety on the NDPS list?", read by the learned
 * nicknames (decision 0051: never a controlled medicine) instead of a word in a product's name.
 */
describe("the cited NDPS list, asked by moiety", () => {
  it.each([
    ["morphine", "morphine"],
    ["Morphine Sulfate", "morphine"],
    ["codeine phosphate", "codeine"],
    ["tramadol hydrochloride", "tramadol"],
    ["ethylmorphine", "ethylmorphine"],
    ["  Fentanyl   citrate ", "fentanyl"],
  ])("%s is the cited entry %s", (moiety, entry) => {
    expect(ndpsListEntryOf(moiety)?.moiety).toBe(entry);
  });

  it.each(["paracetamol", "morphinan", "pantoprazole sodium", "", "alprazolam"])("%p is not on the list (which is not the same as 'not controlled')", (moiety) => {
    expect(ndpsListEntryOf(moiety)).toBeNull();
  });

  it("a medicine takes the strictest class of its moieties: a stored class first, else the list", () => {
    expect(ndpsClassOfMoieties([{ name: "paracetamol", ndpsClass: null }, { name: "tramadol hydrochloride", ndpsClass: null }])).toBe("psychotropic");
    expect(ndpsClassOfMoieties([{ name: "tramadol", ndpsClass: null }, { name: "codeine", ndpsClass: null }])).toBe("narcotic");
    // The pharmacy's stored class counts for a moiety the list does not name.
    expect(ndpsClassOfMoieties([{ name: "alprazolam", ndpsClass: "psychotropic" }])).toBe("psychotropic");
    expect(ndpsClassOfMoieties([{ name: "paracetamol", ndpsClass: null }])).toBeNull();
    expect(ndpsClassOfMoieties([])).toBeNull();
  });
});
