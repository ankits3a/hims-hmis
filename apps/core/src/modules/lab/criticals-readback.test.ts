import { numbersSpoken, readbackCarriesValue } from "./criticals";

/**
 * The §13 walk finding (2026-09-28), pinned without a database: which read-backs SAY a value.
 * A technologist types what the clinician said, so words and digits must both be heard.
 */
describe("numbersSpoken", () => {
  it.each([
    ["six point eight", [6.8]],
    ["potassium six point eight, repeat sample sent", [6.8]],
    ["K 6.8", [6.8]],
    ["one hundred and twenty", [120]],
    ["two thousand five hundred", [2500]],
    ["sodium one twenty", [120]],
    ["one thirty five", [135]],
    ["one oh five", [105]],
    ["one two zero", [120]],
    ["twenty five", [25]],
    ["sixty eight", [68]],
    ["glucose 1,250", [1250]],
    ["point five", [0.5]],
    ["६.८", [6.8]],
    ["noted, will review", []],
  ])("%s → %j", (said, expected) => {
    expect(numbersSpoken(said).sort()).toEqual([...expected].sort());
  });
});

describe("readbackCarriesValue", () => {
  it("hears the stored value however it is said", () => {
    expect(readbackCarriesValue("six point eight", "6.8000")).toBe(true);
    expect(readbackCarriesValue("potassium 6.80", "6.8000")).toBe(true);
    expect(readbackCarriesValue("haemoglobin four point two", "4.2000")).toBe(true);
    expect(readbackCarriesValue("platelets twenty thousand", "20000.0000")).toBe(true);
  });

  it("refuses the wrong number, the right digits in the wrong place, and no number at all", () => {
    expect(readbackCarriesValue("five point eight", "6.8000")).toBe(false);
    expect(readbackCarriesValue("68", "6.8000")).toBe(false);
    expect(readbackCarriesValue("sixty eight", "6.8000")).toBe(false);
    expect(readbackCarriesValue("ok noted", "6.8000")).toBe(false);
  });
});
