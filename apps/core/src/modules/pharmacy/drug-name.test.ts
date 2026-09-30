import { registerDrugName } from "./drug-name";

/**
 * WALK FINDING 2026-09-29 — the Schedule H1 register named the drug "Azee 500 500 mg tablet": the
 * brand already says its strength, and the strength was appended again. The register's drug name
 * says the strength ONCE.
 */
describe("the drug as the registers name it", () => {
  it("does not repeat a strength the brand name already carries", () => {
    expect(registerDrugName({ brandName: "Azee 500", strengthLabel: "500 mg", form: "tablet" }, "x")).toBe("Azee 500 tablet");
    expect(registerDrugName({ brandName: "Dolo 650", strengthLabel: "650mg", form: "tablet" }, "x")).toBe("Dolo 650 tablet");
    expect(registerDrugName({ brandName: "Pan 40mg", strengthLabel: "40 mg", form: "tablet" }, "x")).toBe("Pan 40mg tablet");
  });
  it("keeps a strength the brand does not say, and falls back to the doctor's words", () => {
    expect(registerDrugName({ brandName: "Crocin", strengthLabel: "500 mg", form: "tablet" }, "x")).toBe("Crocin 500 mg tablet");
    expect(registerDrugName({ brandName: "Augmentin 625 Duo", strengthLabel: "500 mg + 125 mg", form: "tablet" }, "x")).toBe("Augmentin 625 Duo 500 mg + 125 mg tablet");
    expect(registerDrugName({ brandName: "Azithral", strengthLabel: null, form: "syrup" }, "x")).toBe("Azithral syrup");
    // "5" is not "500": the brand's number must be the strength's whole number
    expect(registerDrugName({ brandName: "Telma 40", strengthLabel: "4 mg", form: "tablet" }, "x")).toBe("Telma 40 4 mg tablet");
    expect(registerDrugName(undefined, "Amoxicillin 500")).toBe("Amoxicillin 500");
  });
});
