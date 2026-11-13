import { counterPackOf } from "./counter-pack";

describe("counterPackOf — the one counter-pack rule (#1047)", () => {
  const base = { uom: "tablet", toBaseMultiplier: 1, isIssueUom: true };
  it("takes the issue pack, not the smallest or the largest", () => {
    expect(counterPackOf([base, { uom: "strip10", toBaseMultiplier: 10 }, { uom: "strip15", toBaseMultiplier: 15, isIssueUom: true }, { uom: "box150", toBaseMultiplier: 150 }])?.uom).toBe("strip15");
  });
  it("takes the smallest issue pack when several are flagged", () => {
    expect(counterPackOf([base, { uom: "box100", toBaseMultiplier: 100, isIssueUom: true }, { uom: "strip10", toBaseMultiplier: 10, isIssueUom: true }])?.uom).toBe("strip10");
  });
  it("falls back to the smallest pack above one unit, and to none for loose stock", () => {
    expect(counterPackOf([base, { uom: "box100", toBaseMultiplier: 100 }, { uom: "strip10", toBaseMultiplier: 10, isIssueUom: false }])?.uom).toBe("strip10");
    expect(counterPackOf([base])).toBeNull();
    expect(counterPackOf([])).toBeNull();
  });
});
