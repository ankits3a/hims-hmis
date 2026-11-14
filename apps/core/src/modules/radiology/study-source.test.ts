import { STUDY_SOURCES, studySource } from "./study-source";

/**
 * #1077 — the one rule for where a study came from, in its precedence order. The acceptance check
 * (`acceptance/imaging-one-rule-1077.test.ts` D1) holds the four answers; this file holds the order
 * they are decided in and the edges between them.
 */
describe("studySource — the one rule (#1077)", () => {
  const study = (encounterNo: string, bedsideLocation: string | null = null) => ({ encounterNo, bedsideLocation });
  const clinician = { authority: "clinician" };

  it("an outside prescription or the patient's own request is walk-in, whatever the encounter or the place", () => {
    expect(studySource(study("V2609010001"), { authority: "external_prescription" })).toBe("walk_in");
    expect(studySource(study("V2609010001"), { authority: "self" })).toBe("walk_in");
    expect(studySource(study("D2609010001", "Day-care bay 2"), { authority: "self" })).toBe("walk_in");
  });

  it("a day-care encounter is day care, even at a bedside", () => {
    expect(studySource(study("D2609010001"), clinician)).toBe("daycare");
    expect(studySource(study("D2609010001", "Day-care bay 2"), clinician)).toBe("daycare");
  });

  it("a bedside study, or an encounter that is neither a visit nor day care, is ipd", () => {
    expect(studySource(study("V2609010001", "Ward 3 · bed 12"), clinician)).toBe("ipd");
    expect(studySource(study("I2609010001"), clinician)).toBe("ipd");
  });

  it("an OPD visit in the department is opd; a blank place is no place", () => {
    expect(studySource(study("V2609010001"), clinician)).toBe("opd");
    expect(studySource(study("V2609010001", "   "), clinician)).toBe("opd");
    expect(studySource(study("V2609010001"), { authority: "protocol" })).toBe("opd");
  });

  it("there is no ER source: STAT is a priority, not a place", () => {
    expect(STUDY_SOURCES).toEqual(["opd", "ipd", "daycare", "walk_in"]);
  });
});
