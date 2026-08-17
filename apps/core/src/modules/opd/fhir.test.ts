import { toFhirBundle } from "./fhir";
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
});
