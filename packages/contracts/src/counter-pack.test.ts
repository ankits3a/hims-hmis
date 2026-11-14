import { counterPackOf, packWordOf } from "./counter-pack";

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

describe("packWordOf — a pack's CODE as a patient's paper words it (walk 2026-11-13, #1055)", () => {
  it("drops the size a code carries: strip15 → strip, box10 → box", () => {
    expect(packWordOf("strip15")).toBe("strip");
    expect(packWordOf("strip10")).toBe("strip");
    expect(packWordOf("box100")).toBe("box");
    expect(packWordOf("Strip 15")).toBe("Strip");
  });
  it("leaves a plain word as it is", () => {
    expect(packWordOf("strip")).toBe("strip");
    expect(packWordOf("bottle")).toBe("bottle");
    expect(packWordOf("10x10")).toBe("10x10");
  });
});
