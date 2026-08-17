/**
 * The e-Rx document, FHIR-shaped (spec §6: stored FHIR-shaped, serialized to a conformant profile later).
 * A pure core — this file imports NOTHING, reaches for no clock and no randomness, so the JSONB stored on
 * opd_prescriptions.document is a total function of the consultation facts handed to it.
 *
 * Absence is expressed by an ABSENT KEY, never by null and never by an undefined value: the document is
 * persisted as jsonb and read back by scanners and (later) by an FHIR serializer, and a null there would
 * claim "this field is known to be empty" where the shape means "this field does not apply".
 */

export type RxLine = {
  drug: string;
  dose: string;
  route: string;
  frequency: string;
  durationDays: number | null;
  instructions: string | null;
  noSubstitution: boolean; // true ⇒ the pharmacy may not substitute (FHIR substitution.allowedBoolean = false)
};

/** Structural shape only: this module ships no FHIR validator, and never claims profile conformance. */
export type FhirBundle = {
  resourceType: "Bundle";
  type: "document";
  id: string;
  timestamp: string;
  entry: { resource: Record<string, unknown> }[];
};

export type FhirDocumentInput = {
  prescriptionId: string;
  version: number;
  encounterId: string;
  patientId: string;
  doctorId: string;
  issuedAt: Date;
  diagnosis: string | null;
  icd10Code: string | null;
  lines: RxLine[];
};

const ICD10_SYSTEM = "http://hl7.org/fhir/sid/icd-10";
/** The printed dosage line's separator — the same glyph the e-Rx print surface renders. */
const DOSAGE_SEPARATOR = " · ";

/** A trimmed value, or null when there is nothing to say — blank strings are absence, not content. */
function text(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * One dosageInstruction: the human line joins only the parts that are PRESENT, in the order
 * dose · frequency · route · "<n> days"; the coded fields mirror the same presence.
 */
function dosageInstruction(line: RxLine): Record<string, unknown> {
  const dose = text(line.dose);
  const frequency = text(line.frequency);
  const route = text(line.route);
  const days = line.durationDays;

  const parts: string[] = [];
  if (dose !== null) parts.push(dose);
  if (frequency !== null) parts.push(frequency);
  if (route !== null) parts.push(route);
  if (days !== null) parts.push(`${days} days`);

  const timing: Record<string, unknown> = {};
  if (frequency !== null) timing.code = { text: frequency };
  if (days !== null) timing.repeat = { boundsDuration: { value: days, unit: "d" } };

  const dosage: Record<string, unknown> = { text: parts.join(DOSAGE_SEPARATOR) };
  if (route !== null) dosage.route = { text: route };
  if (Object.keys(timing).length > 0) dosage.timing = timing;
  return dosage;
}

export function toFhirBundle(input: FhirDocumentInput): FhirBundle {
  const issued = input.issuedAt.toISOString();
  const subject = { reference: `Patient/${input.patientId}` };
  const encounter = { reference: `Encounter/${input.encounterId}` };
  const requester = { reference: `Practitioner/${input.doctorId}` };

  const entry: { resource: Record<string, unknown> }[] = [
    {
      resource: {
        resourceType: "Composition", status: "final", type: { text: "Prescription" }, date: issued,
        subject, author: [requester], encounter,
        title: `OPD prescription v${input.version}`,
      },
    },
  ];

  // No diagnosis text AND no ICD-10 code ⇒ no Condition resource at all: an empty Condition would assert
  // a clinical finding the doctor never made.
  const diagnosis = text(input.diagnosis);
  const icd10Code = text(input.icd10Code);
  if (diagnosis !== null || icd10Code !== null) {
    const code: Record<string, unknown> = {};
    if (diagnosis !== null) code.text = diagnosis;
    if (icd10Code !== null) code.coding = [{ system: ICD10_SYSTEM, code: icd10Code }];
    entry.push({ resource: { resourceType: "Condition", subject, encounter, code } });
  }

  for (const line of input.lines) {
    const resource: Record<string, unknown> = {
      resourceType: "MedicationRequest", status: "active", intent: "order", authoredOn: issued,
      subject, encounter, requester,
      medicationCodeableConcept: { text: line.drug },
      dosageInstruction: [dosageInstruction(line)],
    };
    const instructions = text(line.instructions);
    if (instructions !== null) resource.note = [{ text: instructions }];
    if (line.noSubstitution) resource.substitution = { allowedBoolean: false };
    entry.push({ resource });
  }

  return { resourceType: "Bundle", type: "document", id: input.prescriptionId, timestamp: issued, entry };
}
