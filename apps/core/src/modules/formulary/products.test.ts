import { amountsInName, formClassOf, isModifiedRelease, parseStrengthLabel, sameAmount, strengthAgrees } from "./products";

/** The pure half of `matchProducts`: the strings the national catalogue actually writes. */
describe("formulary product matching — forms and strengths as the catalogue writes them", () => {
  it("reads the catalogue's strength labels, masses and concentrations", () => {
    expect(parseStrengthLabel("650 mg/")).toEqual({ mg: 650, perMl: null });
    expect(parseStrengthLabel("1 g/")).toEqual({ mg: 1000, perMl: null });
    expect(parseStrengthLabel("200/5 mg/ml")).toEqual({ mg: 200, perMl: 5 });
    expect(parseStrengthLabel("40 mg/ml")).toEqual({ mg: 40, perMl: 1 });
    expect(parseStrengthLabel("500 mg/Vial")).toEqual({ mg: 500, perMl: null });
    expect(parseStrengthLabel(null)).toBeNull();
    expect(parseStrengthLabel("as directed")).toBeNull();
  });

  it("a concentration equals its own scaling, and never a mass", () => {
    expect(sameAmount({ mg: 250, perMl: 5 }, { mg: 50, perMl: 1 })).toBe(true);
    expect(sameAmount({ mg: 250, perMl: 5 }, { mg: 250, perMl: null })).toBe(false);
  });

  it("classes dose forms and release the way the spec states them", () => {
    expect(formClassOf("Oral tablet")).toBe("tablet");
    expect(formClassOf("Gastro-resistant oral tablet")).toBe("tablet");
    expect(formClassOf("Chewable tablet")).toBe("chewable_tablet");
    expect(formClassOf("Dispersible oral tablet")).toBe("dispersible_tablet");
    expect(formClassOf("Powder for oral suspension")).toBe("oral_liquid");
    expect(formClassOf("Rectal suppository")).toBeNull();
    expect(isModifiedRelease("Conventional release and prolonged-release oral tablet")).toBe(true);
    expect(isModifiedRelease("Gastro-resistant oral tablet")).toBe(false);
  });

  it("a combination must carry EVERY component strength its name states — 500/125 is not 500/62.5", () => {
    const coAmox = { form: "tablet" as const, components: [{ moiety: "amoxicillin", mg: 500 }, { moiety: "clavulanic acid", mg: 125 }] };
    expect(strengthAgrees(coAmox, "Amoxicillin 500 mg and clavulanic acid (as clavulanate potassium) 125 mg oral tablet", "500 mg/")).toBe(true);
    expect(strengthAgrees(coAmox, "Product containing precisely amoxicillin 500 milligram and clavulanic acid 62.5 milligram/1 each oral tablet", "500 mg/")).toBe(false);
    expect(strengthAgrees(coAmox, "Amoxicillin 875 mg and clavulanic acid 125 mg oral tablet", "875 mg/")).toBe(false);
    /* A brand name states no strength; the label is then all there is, and it must agree. */
    expect(strengthAgrees(coAmox, "Augmentin 625 Duo", "500 mg")).toBe(true);
    expect(strengthAgrees(coAmox, "Augmentin 625 Duo", null)).toBe(false);
    expect(amountsInName("30 milligram/5 milliliter and 2.5 mg/5 mL")).toEqual([{ mg: 30, perMl: 5 }, { mg: 2.5, perMl: 5 }]);
  });
});
