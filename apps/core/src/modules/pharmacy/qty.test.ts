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
    expect(doseUnits("10 mg")).toBe(10);
    expect(doseUnits("one tablet")).toBeNull();
  });
});
