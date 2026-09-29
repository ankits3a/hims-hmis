import {
  CREATININE_UMOL_PER_MG_DL, EGFR_HOLD_BELOW, EGFR_HYDRATE_BELOW, assessEgfr, ckdEpi2021, renalBand,
} from "./egfr";

/**
 * 18-S RS5 T1 — CKD-EPI 2021 against PUBLISHED reference values, and the three lanes at their edges.
 *
 * The first row is the NKF's own worked example (60-year-old woman, creatinine 1.0 mg/dL → 64); the
 * rest are the 2021 equation's outputs for the inputs shown, rounded as a calculator prints them,
 * checked within one unit. A mutant that
 * swaps κ or α between the sexes, drops the 1.012 female factor, or keeps the 2009 constant (141)
 * moves at least one of these by more than one unit.
 */
describe("CKD-EPI 2021 (18-S RS5 T1)", () => {
  it.each([
    // [creatinine mg/dL, age, sex, published eGFR]
    [1.0, 60, "female", 64],
    [1.0, 40, "male", 98],
    [0.7, 30, "female", 119],
    [1.2, 50, "male", 74],
    [2.0, 70, "female", 26],
    [1.5, 65, "male", 51],
    [0.5, 25, "female", 133],
  ] as const)("Scr %s mg/dL, %s y %s → %s mL/min/1.73m²", (scr, age, sex, expected) => {
    expect(Math.abs(Math.round(ckdEpi2021(scr, age, sex)) - expected)).toBeLessThanOrEqual(1);
  });

  it("is monotone: a higher creatinine never gives a higher eGFR", () => {
    let last = Infinity;
    for (let scr = 0.3; scr <= 6; scr += 0.1) {
      const e = ckdEpi2021(scr, 55, "male");
      expect(e).toBeLessThan(last);
      last = e;
    }
  });

  it("the bands: < 30 hold, 30–44 hydrate, ≥ 45 clear — inclusive at the lower edge of each", () => {
    expect(renalBand(EGFR_HOLD_BELOW - 1)).toBe("hold");
    expect(renalBand(EGFR_HOLD_BELOW)).toBe("hydrate");
    expect(renalBand(EGFR_HYDRATE_BELOW - 1)).toBe("hydrate");
    expect(renalBand(EGFR_HYDRATE_BELOW)).toBe("clear");
  });

  it("assessEgfr converts µmol/L, rounds, and flags metformin below 45", () => {
    const a = assessEgfr(1.0 * CREATININE_UMOL_PER_MG_DL, { sex: "female", ageYears: 60 });
    expect(a).toMatchObject({ computed: true, egfr: 64, band: "clear", metforminHold: false });
    const b = assessEgfr(1.5 * CREATININE_UMOL_PER_MG_DL, { sex: "female", ageYears: 70 });
    expect(b).toMatchObject({ computed: true, band: "hydrate", metforminHold: true });
  });

  it("no eGFR without a date of birth, for a sex the equation has no coefficient for, or under 18", () => {
    expect(assessEgfr(80, { sex: "female", ageYears: null })).toMatchObject({ computed: false, reason: "no_dob" });
    expect(assessEgfr(80, { sex: "other", ageYears: 40 })).toMatchObject({ computed: false, reason: "sex_not_binary" });
    expect(assessEgfr(80, { sex: "male", ageYears: 12 })).toMatchObject({ computed: false, reason: "under_18" });
  });
});
