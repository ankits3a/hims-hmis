import { describe, expect, it } from "vitest";
import { glucoseText, sectionLines } from "./opd-consult-v2";
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

/* Owner 2026-10-08 — the bay's finger-prick glucose reads back in the doctor's history with WHEN it was taken. */
describe("past visit — the vitals section carries a glucose that was taken", () => {
  const visit = (vitals: PastVisit["vitals"]): PastVisit => ({
    encounter: { id: "enc-2", visitNo: "V2", serviceDate: "2026-10-08", visitType: "revisit", chiefComplaint: null, diagnosis: null, advice: null, icd10Code: null },
    vitals, prescriptions: [], diagnoses: [],
  });
  const base = { id: "v1", recordedAt: "2026-10-08T06:10:00.000Z", status: "active", sbp: 148, dbp: 92, pulse: 84, spo2: null, tempC: null, weightKg: 71.5 };
  it("names the number and the timing; a chart without one says nothing about glucose", () => {
    expect(sectionLines(visit([{ ...base, glucoseMgDl: 186, glucoseTiming: "random" }]), "vitals")).toEqual(["BP 148/92 · P 84 · SpO₂ — · T — · 71.5 kg · Glucose 186 mg/dL (random)"]);
    expect(sectionLines(visit([base]), "vitals")).toEqual(["BP 148/92 · P 84 · SpO₂ — · T — · 71.5 kg"]);
    expect(glucoseText({ glucoseMgDl: 110, glucoseTiming: "after_food" })).toBe("Glucose 110 mg/dL (after food)");
    expect(glucoseText({ glucoseMgDl: null })).toBeNull();
  });
});
