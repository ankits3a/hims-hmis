import { taperText, toFhirBundle } from "./fhir";
import type { RxLine } from "./fhir";

/** Hand-written instants and objects — nothing below was produced by running the builder (§3.10). */
const ISSUED = "2026-08-17T05:12:00.000Z";
const SUBJECT = { reference: "Patient/P1" };
const ENCOUNTER = { reference: "Encounter/E1" };
const REQUESTER = { reference: "Practitioner/DOC1" };

describe("toFhirBundle (the e-Rx document — pure)", () => {
  it("builds the whole bundle for a two-line prescription with a diagnosis and an ICD-10 code", () => {
    const lines: RxLine[] = [
      { drug: "Tab Paracetamol 500 mg", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: "after food", noSubstitution: false },
      { drug: "Syp Cetirizine", dose: "5 ml", route: "oral", frequency: "HS", durationDays: null, instructions: null, noSubstitution: true },
    ];
    const bundle = toFhirBundle({
      prescriptionId: "RX1", version: 1, encounterId: "E1", patientId: "P1", doctorId: "DOC1",
      issuedAt: new Date(ISSUED), diagnosis: "Acute pharyngitis", icd10Code: "J02.9", lines,
    });

    expect(bundle).toEqual({
      resourceType: "Bundle", type: "document", id: "RX1", timestamp: ISSUED,
      entry: [
        { resource: { resourceType: "Composition", status: "final", type: { text: "Prescription" }, date: ISSUED,
            subject: SUBJECT, author: [REQUESTER], encounter: ENCOUNTER,
            title: "OPD prescription v1" } },
        { resource: { resourceType: "Condition", subject: SUBJECT, encounter: ENCOUNTER,
            code: { text: "Acute pharyngitis", coding: [{ system: "http://hl7.org/fhir/sid/icd-10", code: "J02.9" }] } } },
        { resource: { resourceType: "MedicationRequest", status: "active", intent: "order", authoredOn: ISSUED,
            subject: SUBJECT, encounter: ENCOUNTER, requester: REQUESTER,
            medicationCodeableConcept: { text: "Tab Paracetamol 500 mg" },
            dosageInstruction: [{ text: "1 tab · TDS · oral · 5 days", route: { text: "oral" }, timing: { code: { text: "TDS" }, repeat: { boundsDuration: { value: 5, unit: "d" } } } }],
            note: [{ text: "after food" }] } },
        { resource: { resourceType: "MedicationRequest", status: "active", intent: "order", authoredOn: ISSUED,
            subject: SUBJECT, encounter: ENCOUNTER, requester: REQUESTER,
            medicationCodeableConcept: { text: "Syp Cetirizine" },
            dosageInstruction: [{ text: "5 ml · HS · oral", route: { text: "oral" }, timing: { code: { text: "HS" } } }],
            substitution: { allowedBoolean: false } } },
      ],
    });
  });

  it("omits the Condition entry with no diagnosis and no ICD-10, and omits absent keys instead of nulling them", () => {
    const bundle = toFhirBundle({
      prescriptionId: "RX2", version: 2, encounterId: "E1", patientId: "P1", doctorId: "DOC1",
      issuedAt: new Date(ISSUED), diagnosis: null, icd10Code: null,
      lines: [{ drug: "Tab Iron", dose: "1 tab", route: "oral", frequency: "OD", durationDays: null, instructions: null, noSubstitution: false }],
    });

    expect(bundle).toEqual({
      resourceType: "Bundle", type: "document", id: "RX2", timestamp: ISSUED,
      entry: [
        { resource: { resourceType: "Composition", status: "final", type: { text: "Prescription" }, date: ISSUED,
            subject: SUBJECT, author: [REQUESTER], encounter: ENCOUNTER,
            title: "OPD prescription v2" } },
        { resource: { resourceType: "MedicationRequest", status: "active", intent: "order", authoredOn: ISSUED,
            subject: SUBJECT, encounter: ENCOUNTER, requester: REQUESTER,
            medicationCodeableConcept: { text: "Tab Iron" },
            dosageInstruction: [{ text: "1 tab · OD · oral", route: { text: "oral" }, timing: { code: { text: "OD" } } }] } },
      ],
    });

    // toEqual treats an undefined-valued key as absent; the stored JSONB must not carry the key at all,
    // so the key SET is asserted directly (a null or undefined `substitution`/`note`/`timing` fails here).
    expect(bundle.entry.map((e) => (e.resource as { resourceType: string }).resourceType)).toEqual(["Composition", "MedicationRequest"]);
    expect(Object.keys(bundle.entry[1]!.resource).sort()).toEqual([
      "authoredOn", "dosageInstruction", "encounter", "intent", "medicationCodeableConcept", "requester", "resourceType", "status", "subject",
    ]);
    const dosage = (bundle.entry[1]!.resource as { dosageInstruction: Record<string, unknown>[] }).dosageInstruction[0]!;
    expect(Object.keys(dosage).sort()).toEqual(["route", "text", "timing"]);
    expect(Object.keys((dosage as { timing: Record<string, unknown> }).timing).sort()).toEqual(["code"]); // no repeat without a duration
  });

  /**
   * The ophthal line (board "Ophthal", 2026-09-23): an eye is a coded SITE on the dosage, and a
   * taper is one dosageInstruction per step, in order — FHIR's own shape for "6× a day for a week,
   * then 4×…". Hand-written expectations; the plain-line bundles above prove nothing else moved.
   */
  const eyeBundle = (line: RxLine) => toFhirBundle({
    prescriptionId: "RX3", version: 1, encounterId: "E1", patientId: "P1", doctorId: "DOC1",
    issuedAt: new Date(ISSUED), diagnosis: null, icd10Code: null, lines: [line],
  });
  const dosageOf = (line: RxLine) =>
    (eyeBundle(line).entry[1]!.resource as { dosageInstruction: Record<string, unknown>[] }).dosageInstruction;
  const MOXI: RxLine = {
    drug: "Moxifloxacin 0.5% eye drops", dose: "1 drop", route: "eye", frequency: "QID", durationDays: 7,
    instructions: null, noSubstitution: false,
  };

  it("an eye line carries a SNOMED body-structure site, one code per eye", () => {
    const sites = (["od", "os", "ou"] as const).map((eye) => dosageOf({ ...MOXI, eye })[0]!.site);
    expect(sites).toEqual([
      { coding: [{ system: "http://snomed.info/sct", code: "18944008", display: "Right eye structure" }], text: "RIGHT EYE" },
      { coding: [{ system: "http://snomed.info/sct", code: "8966001", display: "Left eye structure" }], text: "LEFT EYE" },
      { coding: [{ system: "http://snomed.info/sct", code: "40638003", display: "Both eyes" }], text: "BOTH EYES" },
    ]);
    expect(dosageOf({ ...MOXI, eye: "ou" })[0]!.text).toBe("1 drop · QID · eye · BOTH EYES · 7 days");
    // null is absence, exactly as a missing key is.
    expect(Object.keys(dosageOf({ ...MOXI, eye: null })[0]!).sort()).toEqual(["route", "text", "timing"]);
  });

  it("a tapered line is one sequenced dosageInstruction per step, each with its own frequency and bound", () => {
    const taper = [{ timesPerDay: 6, days: 7 }, { timesPerDay: 4, days: 7 }, { timesPerDay: 1, days: 3 }];
    const dosage = dosageOf({
      ...MOXI, drug: "Prednisolone acetate 1% eye drops", eye: "od", taper, frequency: taperText(taper), durationDays: 17,
    });
    const site = { coding: [{ system: "http://snomed.info/sct", code: "18944008", display: "Right eye structure" }], text: "RIGHT EYE" };
    expect(dosage).toEqual([
      { sequence: 1, text: "1 drop · 6×/day · eye · RIGHT EYE · 7 days", route: { text: "eye" }, site,
        timing: { repeat: { frequency: 6, period: 1, periodUnit: "d", boundsDuration: { value: 7, unit: "d" } } } },
      { sequence: 2, text: "1 drop · 4×/day · eye · RIGHT EYE · 7 days", route: { text: "eye" }, site,
        timing: { repeat: { frequency: 4, period: 1, periodUnit: "d", boundsDuration: { value: 7, unit: "d" } } } },
      { sequence: 3, text: "1 drop · 1×/day · eye · RIGHT EYE · 3 days", route: { text: "eye" }, site,
        timing: { repeat: { frequency: 1, period: 1, periodUnit: "d", boundsDuration: { value: 3, unit: "d" } } } },
    ]);
  });

  it("taperText is the one canonical wording of a taper", () => {
    expect(taperText([{ timesPerDay: 6, days: 7 }, { timesPerDay: 4, days: 7 }, { timesPerDay: 3, days: 7 }]))
      .toBe("Taper: 6×/day × 7d → 4×/day × 7d → 3×/day × 7d");
  });
});
