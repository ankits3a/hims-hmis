import { ISMP_HIGH_ALERT_NAMES, giveTiming, isHighAlert, unitsPerDose } from "./emar-rules";

/** E4.3 review — the eMAR's pure rules: the ISMP names, the late window's boundary, a dose in the label's units. */
const byName = (name: string): boolean => isHighAlert(false, false, { name, moieties: [], classes: [] });

describe("ISMP high-alert names (E4.3 review 22)", () => {
  it.each(ISMP_HIGH_ALERT_NAMES.map((n) => [n]))("%s is high-alert by name, with no item flag", (n) => {
    expect(byName(`${n.toUpperCase()} injection`)).toBe(true);
    expect(byName(`Brand (${n}) 10 mg`)).toBe(true);
  });
  it("ordinary drugs are not, and a word inside another word does not match", () => {
    for (const n of ["Paracetamol 500 mg", "Metformin 500 mg", "Atorvastatin 10 mg", "Pantoprazole 40 mg", "Ceftriaxone 1 g", "Amlodipine 5 mg"]) {
      expect([n, byName(n)]).toEqual([n, false]);
    }
  });
});

describe("the late window (E4.3 review 21)", () => {
  const due = new Date("2026-03-11T02:30:00Z");
  const slot = { dueAt: due, windowMinutes: 60, reofferedAt: null };
  const at = (min: number): Date => new Date(due.getTime() + min * 60_000);
  it("open to +w, late to +2w (one more window), closed after", () => {
    expect(giveTiming(slot, at(-61))).toBe("early");
    expect(giveTiming(slot, at(-60))).toBe("open");
    expect(giveTiming(slot, at(60))).toBe("open");
    expect(giveTiming(slot, at(61))).toBe("late");
    expect(giveTiming(slot, at(120))).toBe("late");
    expect(giveTiming(slot, at(121))).toBe("closed");
  });
});

describe("a dose in the label's units (E4.3 review 1)", () => {
  it("counts tablets, halves, ampoules and single-dose vials; leaves multi-dose containers uncounted", () => {
    expect(unitsPerDose({ doseValue: 2, doseUnit: "tab" }, "500 mg", "tablet")).toBe(2);
    expect(unitsPerDose({ doseValue: 250, doseUnit: "mg" }, "500 mg", "tablet")).toBe(0.5);
    expect(unitsPerDose({ doseValue: 1, doseUnit: "g" }, "1 g", "vial")).toBe(1);
    expect(unitsPerDose({ doseValue: 5, doseUnit: "mg" }, "10 mg/ml", "ampoule")).toBe(0.5);
    expect(unitsPerDose({ doseValue: 50, doseUnit: "mcg" }, "100 mcg/2 ml", "ampoule")).toBe(0.5);
    expect(unitsPerDose({ doseValue: 8, doseUnit: "unit" }, "100 IU/ml", "vial")).toBeCloseTo(0.08);
    expect(unitsPerDose({ doseValue: 10, doseUnit: "ml" }, "100 mg/5 ml", "bottle")).toBeNull();
    expect(unitsPerDose({ doseValue: 8, doseUnit: "unit" }, "100 IU/ml", "pen")).toBeNull();
  });
});
