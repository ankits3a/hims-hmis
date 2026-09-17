import { gstinCheckChar, gstinState, isValidGstin } from "./gstin";

describe("GSTIN", () => {
  it("accepts a real registration and names its state", () => {
    // The hospital's trust, Bihar (given by the owner on 2026-09-17).
    expect(isValidGstin("10AAATL6484H1ZP")).toBe(true);
    expect(gstinState("10AAATL6484H1ZP")).toEqual({ code: "10", name: "Bihar" });
    expect(gstinCheckChar("10AAATL6484H1Z")).toBe("P");
  });

  it("refuses a wrong check character, a transposition, lower case, a bad shape and an unknown state", () => {
    expect(isValidGstin("10AAATL6484H1ZQ")).toBe(false);
    expect(isValidGstin("10AAATL6448H1ZP")).toBe(false);
    expect(isValidGstin("10aaatl6484h1zp")).toBe(false);
    expect(isValidGstin("10AAATL6484H1XP")).toBe(false);
    expect(isValidGstin("10AAATL6484H")).toBe(false);
    const unknown = `25AAATL6484H1Z`;
    expect(isValidGstin(`${unknown}${gstinCheckChar(unknown)}`)).toBe(false);
    expect(gstinState("10AAATL6484H1ZQ")).toBeNull();
  });
});
