import { labelDirections } from "./label";
import type { RxLine } from "../opd";

/**
 * The label's directions line — the words the patient reads at home. An eye line that printed
 * "1 drop · QID · 7 days" and not WHICH eye would be a label that lets the drop go in the wrong one.
 */
describe("labelDirections", () => {
  const base: RxLine = {
    drug: "Tab Paracetamol 500 mg", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5,
    instructions: "after food", noSubstitution: false,
  };

  it("a plain line reads exactly as it always has", () => {
    expect(labelDirections(base)).toBe("1 tab · TDS · 5 days · after food");
    expect(labelDirections({ ...base, durationDays: null, instructions: null, eye: null })).toBe("1 tab · TDS");
  });

  it("an eye line names the eye, after the dose", () => {
    expect(labelDirections({
      ...base, drug: "Prednisolone acetate 1% eye drops", dose: "1 drop", route: "eye", eye: "od",
      frequency: "Taper: 6×/day × 7d → 4×/day × 7d", durationDays: 14, instructions: null,
    })).toBe("1 drop · RIGHT EYE · Taper: 6×/day × 7d → 4×/day × 7d · 14 days");
    expect(labelDirections({ ...base, dose: "1 drop", eye: "os", instructions: null })).toBe("1 drop · LEFT EYE · TDS · 5 days");
  });
});
