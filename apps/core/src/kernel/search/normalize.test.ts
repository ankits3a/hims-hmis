import { normalizeForSearch, transliterateDevanagari } from "./normalize";

describe("transliterateDevanagari", () => {
  it("applies the inherent vowel — a bare consonant is not a bare letter", () => {
    expect(transliterateDevanagari("कमल")).toBe("kamal"); // not "kml", not "kamala"
    expect(transliterateDevanagari("रमन")).toBe("raman");
  });

  it("a matra replaces the inherent vowel", () => {
    expect(transliterateDevanagari("आशा")).toBe("asha");
    expect(transliterateDevanagari("देवी")).toBe("devi");
    expect(transliterateDevanagari("अशोक")).toBe("ashok");
  });

  it("a halant kills the inherent vowel", () => {
    expect(transliterateDevanagari("प्रेम")).toBe("prem");
  });

  it("nasalisation reads as an n, which is what a desk types", () => {
    expect(transliterateDevanagari("संजय")).toBe("sanjay");
  });

  it("Latin text passes through untouched", () => {
    expect(transliterateDevanagari("Asha Devi")).toBe("Asha Devi");
    expect(transliterateDevanagari("9876543210")).toBe("9876543210");
  });
});

describe("normalizeForSearch", () => {
  it("folds case, diacritics and whitespace into one comparable form", () => {
    expect(normalizeForSearch("  Ashā   Devi ")).toBe("asha devi");
    expect(normalizeForSearch("ASHA DEVI")).toBe("asha devi");
  });

  it("A DEVANAGARI QUERY AND ITS LATIN SPELLING FOLD TO THE SAME STRING", () => {
    // The property the whole file exists for: a desk typing Hindi and a record stored in Latin
    // must meet somewhere, and this is where.
    expect(normalizeForSearch("आशा")).toBe(normalizeForSearch("Asha"));
    expect(normalizeForSearch("देवी")).toBe(normalizeForSearch("Devi"));
  });

  it("leaves digits alone — a phone number is not a name", () => {
    expect(normalizeForSearch("98765 43210")).toBe("98765 43210");
  });
});
