import {
  CODED_CATEGORIES, aspectsScore, codedLine, fleischnerRecommendation, isCodedValue, tiradsScore,
} from "@hmis/contracts";

/**
 * PLAN 18-S RS8a T1 — the calculators against the PUBLISHED examples. Each expectation names its
 * source; a calculator that drifts from its table fails here, not on a patient.
 */
describe("coded categories and their calculators (18-S RS8a T1)", () => {
  describe("ACR TI-RADS (Tessler et al., JACR 2017)", () => {
    it("the white paper's worked nodule: solid, hypoechoic, wider-than-tall, smooth, no foci = 4 points, TR4", () => {
      const r = tiradsScore({ composition: "solid", echogenicity: "hypo", shape: "wider_than_tall", margin: "smooth", foci: ["none"] });
      expect([r.points, r.level]).toEqual([4, "TR4"]);
    });

    it("TR4 size rule: FNA at 1.5 cm or more, follow-up at 1.0 cm or more, else nothing", () => {
      const at = (sizeCm: number) => tiradsScore({ composition: "solid", echogenicity: "hypo", shape: "wider_than_tall", margin: "smooth", foci: [], sizeCm }).advice;
      expect([at(1.6), at(1.5), at(1.2), at(1.0), at(0.8)]).toEqual(["fna", "fna", "follow_up", "follow_up", "no_further"]);
    });

    it("the highest-scoring nodule: solid, very hypoechoic, taller-than-wide, extrathyroidal, punctate = 14, TR5", () => {
      const r = tiradsScore({ composition: "solid", echogenicity: "very_hypo", shape: "taller_than_wide", margin: "extrathyroidal", foci: ["punctate"], sizeCm: 0.6 });
      expect([r.points, r.level, r.advice]).toEqual([14, "TR5", "follow_up"]);
    });

    it("echogenic foci SUM (choose all that apply): rim 2 + punctate 3", () => {
      const r = tiradsScore({ composition: "mixed", echogenicity: "hyper_iso", shape: "wider_than_tall", margin: "smooth", foci: ["rim", "punctate", "punctate"] });
      expect(r.points).toBe(1 + 1 + 0 + 0 + 2 + 3);
    });

    it("a spongiform nodule adds no further points (chart note) — TR1 whatever else is ticked", () => {
      const r = tiradsScore({ composition: "spongiform", echogenicity: "very_hypo", shape: "taller_than_wide", margin: "lobulated_irregular", foci: ["punctate"], sizeCm: 3 });
      expect([r.points, r.level, r.advice]).toEqual([0, "TR1", "no_further"]);
    });

    it("level boundaries: 2 → TR2, 3 → TR3 (mixed + isoechoic + macrocalcification), 7 → TR5", () => {
      expect(tiradsScore({ composition: "mixed", echogenicity: "hyper_iso", shape: "wider_than_tall", margin: "smooth", foci: [] }).level).toBe("TR2");
      expect(tiradsScore({ composition: "mixed", echogenicity: "hyper_iso", shape: "wider_than_tall", margin: "smooth", foci: ["macro"] }).level).toBe("TR3");
      expect(tiradsScore({ composition: "solid", echogenicity: "hypo", shape: "taller_than_wide", margin: "smooth", foci: [] }).level).toBe("TR5");
      /** 1 point (cystic + anechoic + macrocalcification) is TR1 — fewer points than TR2. */
      expect(tiradsScore({ composition: "cystic", echogenicity: "anechoic", shape: "wider_than_tall", margin: "smooth", foci: ["macro"] }).level).toBe("TR1");
    });
  });

  describe("ASPECTS (Barber et al., Lancet 2000)", () => {
    it("10 with no region, minus one per region with early ischaemic change", () => {
      expect(aspectsScore([])).toBe(10);
      /** The board's stroke case: insular ribbon and lentiform → 8. */
      expect(aspectsScore(["I", "L"])).toBe(8);
      expect(aspectsScore(["C", "L", "IC", "I", "M1", "M2", "M3", "M4", "M5", "M6"])).toBe(0);
    });

    it("a region counts once, and a word that is not a region counts not at all", () => {
      expect(aspectsScore(["M1", "M1", "X9", "insula"])).toBe(9);
    });
  });

  describe("Fleischner 2017 (MacMahon et al., Radiology 2017)", () => {
    it("single solid < 6 mm: low risk no follow-up; high risk optional CT at 12 months", () => {
      expect(fleischnerRecommendation({ type: "solid", count: "single", sizeMm: 5, risk: "low" }).firstCtMonths).toBeNull();
      expect(fleischnerRecommendation({ type: "solid", count: "single", sizeMm: 5, risk: "high" }).firstCtMonths).toEqual([12, 12]);
    });

    it("single solid 6–8 mm (the board's 6 mm nodule in a smoker): CT at 6–12 months, then 18–24", () => {
      const r = fleischnerRecommendation({ type: "solid", count: "single", sizeMm: 6, risk: "high" });
      expect(r.firstCtMonths).toEqual([6, 12]);
      expect(r.recommendation).toContain("18–24 months");
    });

    it("single solid > 8 mm: CT at 3 months, PET/CT or tissue sampling", () => {
      expect(fleischnerRecommendation({ type: "solid", count: "single", sizeMm: 9, risk: "low" }).recommendation)
        .toBe("Consider CT at 3 months, PET/CT, or tissue sampling.");
    });

    it("multiple solid 6–8 mm: CT at 3–6 months", () => {
      expect(fleischnerRecommendation({ type: "solid", count: "multiple", sizeMm: 7, risk: "low" }).firstCtMonths).toEqual([3, 6]);
    });

    it("subsolid: single GGN ≥ 6 mm CT at 6–12 months; part-solid with a 6 mm solid part is highly suspicious", () => {
      expect(fleischnerRecommendation({ type: "ground_glass", count: "single", sizeMm: 8, risk: "low" }).firstCtMonths).toEqual([6, 12]);
      expect(fleischnerRecommendation({ type: "part_solid", count: "single", sizeMm: 12, risk: "low", solidComponentMm: 6 }).recommendation)
        .toContain("highly suspicious");
      expect(fleischnerRecommendation({ type: "ground_glass", count: "multiple", sizeMm: 4, risk: "high" }).firstCtMonths).toEqual([3, 6]);
    });

    it("3 cm or more is a mass: Fleischner does not apply (the board's 3.8 cm RUL mass)", () => {
      expect(fleischnerRecommendation({ type: "solid", count: "single", sizeMm: 38, risk: "high" }).applies).toBe(false);
    });
  });

  describe("the enumerations", () => {
    it("carry the published category lists exactly", () => {
      expect(CODED_CATEGORIES.birads.map((c) => c.value)).toEqual(["0", "1", "2", "3", "4A", "4B", "4C", "5", "6"]);
      expect(CODED_CATEGORIES.lirads.map((c) => c.value)).toEqual(["LR-1", "LR-2", "LR-3", "LR-4", "LR-5", "LR-M", "LR-TIV"]);
      expect(CODED_CATEGORIES.pirads.map((c) => c.value)).toEqual(["1", "2", "3", "4", "5"]);
      expect(CODED_CATEGORIES.orads.map((c) => c.value)).toEqual(["0", "1", "2", "3", "4", "5"]);
    });

    it("membership and the printed line", () => {
      expect([isCodedValue("birads", "4A"), isCodedValue("birads", "4D"), isCodedValue("aspects", 8), isCodedValue("aspects", 11)])
        .toEqual([true, false, true, false]);
      expect(codedLine("birads", "4A")).toBe("BI-RADS 4A — Low suspicion for malignancy — tissue diagnosis");
      expect(codedLine("aspects", 8)).toBe("ASPECTS 8 / 10");
    });
  });
});
