import { gstCodeKind } from "./gst-code";
import { strengthShown } from "./drug-strength";

/** WALK 2026-11-13 (spec #1046) — one rule for the code's name on every bill: goods HSN, services (chapter 99) SAC. */
describe("the name of a bill line's tariff code", () => {
  it("a medicine's code is an HSN; a consultation's is a SAC; no code names nothing", () => {
    expect(gstCodeKind("3004")).toBe("HSN");
    expect(gstCodeKind("30049099")).toBe("HSN");
    expect(gstCodeKind("999312")).toBe("SAC");
    expect(gstCodeKind(" 9993 ")).toBe("SAC");
    expect(gstCodeKind("")).toBeNull();
    expect(gstCodeKind(null)).toBeNull();
  });
});

/** WALK 2026-11-13 — the catalogue's empty denominator ("500 mg/") is not printed; a real one is. */
describe("a strength as a person reads it", () => {
  it("drops only an empty denominator", () => {
    expect(strengthShown("500 mg/")).toBe("500 mg");
    expect(strengthShown("500 mg / ")).toBe("500 mg");
    expect(strengthShown("250 mg/5 ml")).toBe("250 mg/5 ml");
    expect(strengthShown("500 mg")).toBe("500 mg");
    expect(strengthShown("/")).toBeNull();
    expect(strengthShown(null)).toBeNull();
  });
});
