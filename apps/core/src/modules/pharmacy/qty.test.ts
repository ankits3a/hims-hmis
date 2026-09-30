import { doseUnits, dosesPerDay, prefillQtyBase } from "./qty";

describe("prefillQtyBase — the pharmacist's number, prefilled (16c D5)", () => {
  it.each([
    ["1 tab", "TDS", 5, 15],
    ["1 tab", "1-0-1", 5, 10],
    ["2 tab", "BD", 3, 12],
    ["½ tab", "OD", 7, 4],
    ["1 tab", "0-0-1", 10, 10],
    ["5 ml", "TDS", 5, 75],
    ["1 tab", "q8h", 3, 9],
    ["1 tab", "every 12 hours", 2, 4],
    ["1 cap", "HS", 14, 14],
  ])("%s · %s · %s days → %s", (dose, frequency, durationDays, expected) => {
    expect(prefillQtyBase({ dose, frequency, durationDays })).toBe(expected);
  });

  it.each([
    ["1 tab", "SOS", 5],
    ["1 tab", "TDS", null],
    ["1 tab", "TDS", 0],
    ["apply", "BD", 5],
    ["1 tab", "as directed", 5],
    ["1 tab", "q7h", 3],
    ["1 tab", "0-0-0", 3],
  ])("%s · %s · %s days → blank", (dose, frequency, durationDays) => {
    expect(prefillQtyBase({ dose, frequency, durationDays })).toBeNull();
  });

  it("the parts are readable on their own", () => {
    expect(dosesPerDay("Twice Daily")).toBe(2);
    expect(dosesPerDay("1-1-1")).toBe(3);
    expect(dosesPerDay("prn")).toBeNull();
    expect(doseUnits("1 tab")).toBe(1);
    expect(doseUnits("one tablet")).toBeNull();
  });
});

/**
 * THE WALK OF 2026-09-30 — the doctor's screen asks "Dose, e.g. 500 mg", so an OPD line reads
 * "650 mg · TDS · 5 days" for Dolo 650. The counter read the 650 as a count of TABLETS and prefilled
 * 9,750 tablets (650 strips, ₹21,840) for a fifteen-tablet prescription; the queue called the line
 * short and the pharmacist had to give a reason for giving the fifteen that were prescribed.
 *
 * A mass (or IU) is not a count of anything on a shelf. It becomes one only against the medicine's
 * own strength, and only when the strength is a single plain amount of the same kind; otherwise the
 * prefill is blank and the pharmacist types it — a wrong prefill that looks right is worse than none.
 */
describe("a dose written as a mass is converted by the strength, or left blank", () => {
  it.each([
    ["650 mg", "TDS", 5, "650 mg", 15],
    ["500 mg", "BD", 5, "250 mg", 20],
    ["1 g", "TDS", 3, "500 mg", 18],
    ["250 mg", "BD", 4, "500 mg", 4],
    ["40mg", "OD", 10, "40 mg", 10],
    ["60000 IU", "OD", 1, "60000 IU", 1],
    ["0.5 mg", "HS", 10, "0.5 mg", 10],
  ])("%s · %s · %s days, strength %s → %s", (dose, frequency, durationDays, strength, expected) => {
    expect(prefillQtyBase({ dose, frequency, durationDays }, strength)).toBe(expected);
  });

  it.each([
    ["650 mg", "TDS", 5, null],
    ["650 mg", "TDS", 5, undefined],
    ["10 mg", "OD", 5, "650 mg"],
    ["250 mg", "TDS", 5, "125 mg/5 ml"],
    ["500 mg", "BD", 5, "500 mg + 125 mg"],
    ["650 mg", "TDS", 5, "650 IU"],
    ["650 mg", "TDS", 5, "tablet"],
  ])("%s · %s · %s days, strength %s → blank, never the milligrams", (dose, frequency, durationDays, strength) => {
    expect(prefillQtyBase({ dose, frequency, durationDays }, strength)).toBeNull();
  });

  it("the bare parts: a mass is no count without the strength", () => {
    expect(doseUnits("10 mg")).toBeNull();
    expect(doseUnits("650 mg", "650 mg")).toBe(1);
    expect(doseUnits("5 ml")).toBe(5);
  });
});
