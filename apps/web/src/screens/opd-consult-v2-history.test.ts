import { describe, expect, it } from "vitest";
import { sectionLines } from "./opd-consult-v2";
import type { PastVisit } from "./opd-consult-v2";

/* The History browser's diagnosis lines name the eye beside the code, as the print does (board "Ophthal"). */
describe("past visit — the diagnosis section names the eye", () => {
  it("an eye-coded row carries its eye inside the code's brackets; any other row is unchanged", () => {
    const v: PastVisit = {
      encounter: {
        id: "enc-1", visitNo: "V1", serviceDate: "2026-09-20", visitType: "new", chiefComplaint: null,
        diagnosis: "Senile nuclear cataract · Essential (primary) hypertension", advice: null, icd10Code: "H25.1",
      },
      vitals: [], prescriptions: [],
      diagnoses: [
        { text: "Senile nuclear cataract", icd10Code: "H25.1", laterality: "os" },
        { text: "Essential (primary) hypertension", icd10Code: "I10", laterality: null },
      ],
    };
    expect(sectionLines(v, "dx")).toEqual(["Senile nuclear cataract (H25.1, LEFT EYE)", "Essential (primary) hypertension (I10)"]);
  });
});
