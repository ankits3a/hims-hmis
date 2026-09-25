/**
 * The e-Rx document, FHIR-shaped (spec §6: stored FHIR-shaped, serialized to a conformant profile later).
 * A pure core — it imports only the pure shared eye-line vocabulary (`@hmis/contracts` rx-eye), reaches
 * for no clock and no randomness, so the JSONB stored on
 * opd_prescriptions.document is a total function of the consultation facts handed to it.
 *
 * Absence is expressed by an ABSENT KEY, never by null and never by an undefined value: the document is
 * persisted as jsonb and read back by scanners and (later) by an FHIR serializer, and a null there would
 * claim "this field is known to be empty" where the shape means "this field does not apply".
 */
import { EYE_TEXT, taperDays, taperText } from "@hmis/contracts";
import type { Eye, TaperStep } from "@hmis/contracts";

/** The identifier system for this hospital's own formulary — a local code system, not a public one. */
export const FORMULARY_CODE_SYSTEM = "urn:hmis:formulary:medicine";

export type RxLine = {
  drug: string;
  /**
   * PLAN 16a T5 / DD9 — the formulary medicine this line resolved to, when the prescriber picked
   * one. OPTIONAL AND STAYING OPTIONAL: every `lines` jsonb row written before this phase lacks the
   * key for ever, so every reader tolerates its absence and no migration rewrites a stored
   * document. It rides the FHIR bundle as an IDENTIFIER, never as a replacement for what the
   * doctor typed — `medicationCodeableConcept.text` is unchanged below.
   */
  medicineId?: string | null;
  dose: string;
  route: string;
  frequency: string;
  durationDays: number | null;
  instructions: string | null;
  noSubstitution: boolean; // true ⇒ the pharmacy may not substitute (FHIR substitution.allowedBoolean = false)
  /**
   * The ophthal line (board "Ophthal", 2026-09-23): WHICH eye, and an optional taper. Both optional
   * for the same reason `medicineId` is — every stored line before them lacks the keys for ever.
   * A tapered line still carries `frequency` and `durationDays`: `normaliseRxLine` writes them from
   * the steps at issue, so no reader has to learn what a taper is to read the line correctly.
   */
  eye?: Eye | null;
  taper?: TaperStep[] | null;
};

/** od = right, os = left, ou = both — the ophthalmologist's own abbreviations. The vocabulary is shared with the web (`@hmis/contracts` rx-eye). */
export type { Eye, TaperStep };
export { EYE_TEXT, taperText };

/** SNOMED CT body structures — the coded `site` of an eye line's dosage. */
const EYE_SITE: Record<Eye, { code: string; display: string }> = {
  od: { code: "18944008", display: "Right eye structure" },
  os: { code: "8966001", display: "Left eye structure" },
  ou: { code: "40638003", display: "Both eyes" },
};
const SNOMED_SYSTEM = "http://snomed.info/sct";

/**
 * The server is the source of truth for a tapered line: its frequency is the canonical taper text
 * and its duration the sum of the steps, whatever the client sent. Any other line is returned AS
 * IS — the same object — so a plain prescription stores exactly what it stored before.
 */
export function normaliseRxLine(line: RxLine): RxLine {
  const steps = line.taper;
  if (steps === undefined || steps === null || steps.length === 0) return line;
  return { ...line, frequency: taperText(steps), durationDays: taperDays(steps) };
}

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
  /** The eye of the primary coded diagnosis (`icd10Code`'s row), when it is an eye code. */
  laterality?: Eye | null;
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
  const eye = line.eye ?? null;
  const days = line.durationDays;

  const parts: string[] = [];
  if (dose !== null) parts.push(dose);
  if (frequency !== null) parts.push(frequency);
  if (route !== null) parts.push(route);
  if (eye !== null) parts.push(EYE_TEXT[eye]);
  if (days !== null) parts.push(`${days} days`);

  const timing: Record<string, unknown> = {};
  if (frequency !== null) timing.code = { text: frequency };
  if (days !== null) timing.repeat = { boundsDuration: { value: days, unit: "d" } };

  const dosage: Record<string, unknown> = { text: parts.join(DOSAGE_SEPARATOR) };
  if (route !== null) dosage.route = { text: route };
  if (eye !== null) dosage.site = siteOf(eye);
  if (Object.keys(timing).length > 0) dosage.timing = timing;
  return dosage;
}

function siteOf(eye: Eye): Record<string, unknown> {
  return { coding: [{ system: SNOMED_SYSTEM, ...EYE_SITE[eye] }], text: EYE_TEXT[eye] };
}

/**
 * A taper is FHIR's sequenced dosage: one dosageInstruction per step, `sequence` 1-based, each
 * with its own times-a-day and its own bound — never one instruction whose free text alone says
 * "then 4×", which no machine reader downstream could act on.
 */
function taperInstructions(line: RxLine, steps: readonly TaperStep[]): Record<string, unknown>[] {
  const dose = text(line.dose);
  const route = text(line.route);
  const eye = line.eye ?? null;
  return steps.map((step, i) => {
    const parts: string[] = [];
    if (dose !== null) parts.push(dose);
    parts.push(`${String(step.timesPerDay)}×/day`);
    if (route !== null) parts.push(route);
    if (eye !== null) parts.push(EYE_TEXT[eye]);
    parts.push(`${String(step.days)} days`);
    const dosage: Record<string, unknown> = { sequence: i + 1, text: parts.join(DOSAGE_SEPARATOR) };
    if (route !== null) dosage.route = { text: route };
    if (eye !== null) dosage.site = siteOf(eye);
    dosage.timing = {
      repeat: { frequency: step.timesPerDay, period: 1, periodUnit: "d", boundsDuration: { value: step.days, unit: "d" } },
    };
    return dosage;
  });
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
    const condition: Record<string, unknown> = { resourceType: "Condition", subject, encounter, code };
    /* ICD-10 has no laterality; FHIR's place for the eye is `bodySite`, coded as the eye lines' `site` is. */
    const eye = icd10Code === null ? null : input.laterality ?? null;
    if (eye !== null) condition.bodySite = [siteOf(eye)];
    entry.push({ resource: condition });
  }

  for (const line of input.lines) {
    const resource: Record<string, unknown> = {
      resourceType: "MedicationRequest", status: "active", intent: "order", authoredOn: issued,
      subject, encounter, requester,
      medicationCodeableConcept: line.medicineId === undefined || line.medicineId === null
        ? { text: line.drug }
        // The display text is what the prescriber wrote and is never rewritten; the coding is an
        // extra fact about it. Absence stays an ABSENT KEY, per this file's own rule.
        : { text: line.drug, coding: [{ system: FORMULARY_CODE_SYSTEM, code: line.medicineId }] },
      dosageInstruction: line.taper !== undefined && line.taper !== null && line.taper.length > 0
        ? taperInstructions(line, line.taper)
        : [dosageInstruction(line)],
    };
    const instructions = text(line.instructions);
    if (instructions !== null) resource.note = [{ text: instructions }];
    if (line.noSubstitution) resource.substitution = { allowedBoolean: false };
    entry.push({ resource });
  }

  return { resourceType: "Bundle", type: "document", id: input.prescriptionId, timestamp: issued, entry };
}
