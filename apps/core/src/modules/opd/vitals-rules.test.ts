import { DEFAULT_DANGER_RANGES } from "./config";
import { bandFor, evaluateVitals, missingRequired, validateVitalsRanges } from "./vitals-rules";

const cfg = DEFAULT_DANGER_RANGES;
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

describe("vitals rules (pure)", () => {
  it("bandFor: exclusive upper bounds; unknown age → adult", () => {
    expect([0, 1, 5, 6, 12, 13, 40, null].map((a) => bandFor(a, cfg).key)).toEqual([
      "infant", "child_1_5", "child_1_5", "child_6_12", "child_6_12", "adult", "adult", "adult",
    ]);
  });
  it("missingRequired: the band's list, plus weight under 18", () => {
    expect(missingRequired({}, 40, cfg)).toEqual(["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"]);
    expect(missingRequired(adultOk, 40, cfg)).toEqual([]);
    expect(missingRequired({ heightCm: 90, tempC: 37, spo2: 98, pulse: 100 }, 3, cfg)).toEqual(["weightKg"]);
    expect(missingRequired({ weightKg: 4.2, tempC: 37, spo2: 98, pulse: 120 }, 0, cfg)).toEqual([]);
    expect(missingRequired({ ...adultOk, weightKg: undefined }, 17, cfg)).toEqual(["weightKg"]); // the under-18 rule
    expect(missingRequired({ ...adultOk }, null, cfg)).toEqual([]); // unknown DOB: adult list, no age rule
  });
  it("evaluateVitals: inclusive bounds; each breach names vital, value, bound, limit", () => {
    const adult = bandFor(40, cfg);
    expect(evaluateVitals({ ...adultOk, sbp: 190 }, adult)).toEqual([{ vital: "sbp", value: 190, bound: "max", limit: 180 }]);
    expect(evaluateVitals({ ...adultOk, sbp: 180 }, adult)).toEqual([]);
    expect(evaluateVitals({ ...adultOk, sbp: 89 }, adult)).toEqual([{ vital: "sbp", value: 89, bound: "min", limit: 90 }]);
    expect(evaluateVitals({ ...adultOk, spo2: 89 }, adult)).toEqual([{ vital: "spo2", value: 89, bound: "min", limit: 90 }]);
    expect(evaluateVitals({ ...adultOk, tempC: 39.5 }, adult)).toEqual([]);
    expect(evaluateVitals({ ...adultOk, tempC: 39.6 }, adult)).toEqual([{ vital: "tempC", value: 39.6, bound: "max", limit: 39.5 }]);
    expect(evaluateVitals({ ...adultOk, sbp: 200, spo2: 85 }, adult)).toHaveLength(2);
    expect(evaluateVitals({ pulse: 85 }, bandFor(0, cfg))).toEqual([{ vital: "pulse", value: 85, bound: "min", limit: 90 }]);
    expect(evaluateVitals({ sbp: 141 }, bandFor(8, cfg))).toEqual([{ vital: "sbp", value: 141, bound: "max", limit: 140 }]);
    expect(evaluateVitals({ rr: 31 }, adult)).toEqual([{ vital: "rr", value: 31, bound: "max", limit: 30 }]); // optional field, still evaluated when present
  });
  it("validateVitalsRanges refuses implausible readings", () => {
    expect(() => validateVitalsRanges({ ...adultOk, spo2: 101 })).toThrow(expect.objectContaining({ code: "invalid_vitals" }));
    expect(() => validateVitalsRanges({ ...adultOk, tempC: 50 })).toThrow(expect.objectContaining({ code: "invalid_vitals" }));
    expect(() => validateVitalsRanges(adultOk)).not.toThrow();
  });
});
