import { randomUUID } from "node:crypto";
import { EYE_TEXT } from "@hmis/contracts";
import type { Eye } from "@hmis/contracts";
import type { OpdReleaseVisit, RxLine } from "../opd";
import type { LabReleaseTest, LabReleaseValue } from "../lab";
import type { ImagingReleaseReport } from "../radiology";

/**
 * ═══ ABDM S2 — THE FHIR DOCUMENTS THE HOSPITAL RELEASES, PER THE NRCeS IG v6.5.0 ═══
 *
 * PURE: plain records in, a FHIR R4 `document` Bundle out. No database, no clock (the caller passes
 * `now`), no randomness except the injected `uuid`. The readers that feed it live in the modules
 * that own the data (`opd`, `lab`, `radiology` — each file's `abdm-release.ts` says what it releases
 * and what it holds back). `fhir-records.test.ts` checks every bundle against the IG's
 * StructureDefinitions (the slim extract in `test/fixtures`): the required elements, the fixed
 * codes, the section slices, and that every reference resolves.
 *
 * BUILT in this slice (DECIDED default; the owner's ruling on which records are shared is pending):
 *   · OPConsultation → OPConsultRecord: chief complaint + diagnoses (ChiefComplaints, as the Care
 *     connector files them), the current prescription (Medications), advised tests
 *     (InvestigationAdvice); the Encounter carries the diagnoses.
 *   · Prescription → PrescriptionRecord: one MedicationRequest per line.
 *   · DiagnosticReport → DiagnosticReportRecord, one per lab TEST (DiagnosticReportLab + its
 *     Observations) and one per signed imaging report (a DocumentReference carrying the signed text —
 *     DiagnosticReportImaging REQUIRES `media` 1..*, i.e. the images, which this hospital does not
 *     yet hold in a form it can send).
 * OWED: DischargeSummary, ImmunizationRecord, WellnessRecord, HealthDocumentRecord, Invoice; vitals
 * and examination, follow-up and referral sections; DiagnosticReportImaging with Media.
 *
 * CODES. SNOMED where the IG fixes a code (Composition types and sections — the fixed displays are
 * copied from the profiles and a mistyped one fails the checker). ICD-10 for a diagnosis the doctor
 * PICKED (with the catalogue's display, which the IG's ICD-10 slice requires); a typed diagnosis goes
 * as text. LOINC on an Observation only where the analyte carries one. Medicines go as TEXT: the IG
 * binds `medication.coding` to SNOMED, which this formulary does not carry, and a local code there
 * would fail the IG's fixed system.
 */
export const NRCES = "https://nrces.in/ndhm/fhir/r4/StructureDefinition";
const SCT = "http://snomed.info/sct";
const ICD10 = "http://hl7.org/fhir/sid/icd-10";
const LOINC = "http://loinc.org";
const V2_0203 = "http://terminology.hl7.org/CodeSystem/v2-0203";
const NDHM_ID_TYPE = "https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code";

export type HiType = "OPConsultation" | "Prescription" | "DiagnosticReport";
export const BUILT_HI_TYPES: readonly HiType[] = ["OPConsultation", "Prescription", "DiagnosticReport"];

export type RecordPatient = {
  uhid: string;
  name: string;
  gender: "male" | "female" | "other" | "unknown";
  birthDate: string | null;
  phone: string | null;
  abhaNumber: string | null;
};

export type RecordContext = {
  hip: { id: string; name: string };
  patient: RecordPatient;
  now: Date;
  /** `randomUUID` in production; a counter in tests, so a bundle is a total function of its input. */
  uuid?: () => string;
};

type Json = Record<string, unknown>;
type Entry = { fullUrl: string; resource: Json };
type Ref = { reference: string; display?: string; type?: string };

const iso = (d: Date): string => d.toISOString();
const coding = (system: string, code: string, display: string): Json => ({ system, code, display });

/** A document under construction: every resource gets a urn:uuid id and the profile it claims. */
class Doc {
  readonly entries: Entry[] = [];
  private readonly uuid: () => string;

  constructor(readonly ctx: RecordContext) {
    this.uuid = ctx.uuid ?? randomUUID;
  }

  add(resourceType: string, profile: string, body: Json): Ref {
    const id = this.uuid();
    const resource: Json = { resourceType, id, meta: { profile: [`${NRCES}/${profile}`] }, ...body };
    this.entries.push({ fullUrl: `urn:uuid:${id}`, resource });
    return { reference: `urn:uuid:${id}`, display: resourceType };
  }

  /** The id-mint the bundle and the Composition identifier share. */
  id(): string {
    return this.uuid();
  }
}

function patientResource(doc: Doc): Ref {
  const p = doc.ctx.patient;
  const identifier: Json[] = [{
    type: { coding: [coding(V2_0203, "MR", "Medical record number")] },
    system: `urn:hmis:hip:${doc.ctx.hip.id}:uhid`,
    value: p.uhid,
  }];
  if (p.abhaNumber !== null) {
    identifier.push({
      type: { coding: [coding(NDHM_ID_TYPE, "ABHA", "Ayushman Bharat Health Account (ABHA) ID")] },
      system: "https://healthid.ndhm.gov.in",
      value: p.abhaNumber,
    });
  }
  const body: Json = { identifier, name: [{ text: p.name }], gender: p.gender };
  if (p.birthDate !== null) body.birthDate = p.birthDate;
  if (p.phone !== null) body.telecom = [{ system: "phone", value: `+91${p.phone}`, use: "mobile" }];
  return { ...doc.add("Patient", "Patient", body), display: p.name };
}

function organizationResource(doc: Doc): Ref {
  const h = doc.ctx.hip;
  return {
    ...doc.add("Organization", "Organization", {
      identifier: [{ type: { coding: [coding(V2_0203, "PRN", "Provider number")] }, system: "https://facility.ndhm.gov.in", value: h.id }],
      name: h.name,
    }),
    display: h.name,
  };
}

function practitionerResource(doc: Doc, d: NonNullable<OpdReleaseVisit["doctor"]>): Ref {
  const identifier = d.registrationNo !== null && d.registrationNo.trim() !== ""
    ? { type: { coding: [coding(V2_0203, "MD", "Medical License number")] }, system: `urn:hmis:hip:${doc.ctx.hip.id}:medical-registration`, value: d.registrationNo.trim() }
    : { type: { coding: [coding(V2_0203, "EI", "Employee number")] }, system: `urn:hmis:hip:${doc.ctx.hip.id}:doctor`, value: d.code };
  return { ...doc.add("Practitioner", "Practitioner", { identifier: [identifier], name: [{ text: d.displayName }] }), display: d.displayName };
}

function encounterResource(doc: Doc, v: OpdReleaseVisit, subject: Ref, org: Ref, diagnoses: Ref[]): Ref {
  const body: Json = {
    identifier: [{ system: `urn:hmis:hip:${doc.ctx.hip.id}:visit`, value: v.visitNo }],
    status: "finished",
    class: coding("http://terminology.hl7.org/CodeSystem/v3-ActCode", "AMB", "ambulatory"),
    subject,
    period: { start: iso(v.consultStartedAt ?? v.consultCompletedAt), end: iso(v.consultCompletedAt) },
    serviceProvider: org,
  };
  if (diagnoses.length > 0) body.diagnosis = diagnoses.map((condition, i) => ({ condition, rank: i + 1 }));
  return doc.add("Encounter", "Encounter", body);
}

const EYE_SITE: Record<Eye, { code: string; display: string }> = {
  od: { code: "18944008", display: "Right eye structure" },
  os: { code: "8966001", display: "Left eye structure" },
  ou: { code: "40638003", display: "Both eyes" },
};
const isEye = (v: unknown): v is Eye => v === "od" || v === "os" || v === "ou";

function conditionResources(doc: Doc, v: OpdReleaseVisit, subject: Ref, encounter: Ref | null): { complaint: Ref | null; diagnoses: Ref[] } {
  const clinical = { coding: [coding("http://terminology.hl7.org/CodeSystem/condition-clinical", "active", "Active")] };
  const base = (): Json => (encounter === null ? { subject } : { subject, encounter });
  const complaint = v.chiefComplaint === null
    ? null
    : doc.add("Condition", "Condition", { clinicalStatus: clinical, code: { text: v.chiefComplaint }, ...base() });
  const verification = v.diagnosisKind === "final"
    ? { coding: [coding("http://terminology.hl7.org/CodeSystem/condition-ver-status", "confirmed", "Confirmed")] }
    : { coding: [coding("http://terminology.hl7.org/CodeSystem/condition-ver-status", "provisional", "Provisional")] };
  const diagnoses = v.diagnoses.map((d) => {
    const code: Json = { text: d.text };
    if (d.icd10Code !== null && d.icd10Display !== null) code.coding = [coding(ICD10, d.icd10Code, d.icd10Display)];
    const body: Json = {
      clinicalStatus: clinical,
      verificationStatus: verification,
      category: [{ coding: [coding("http://terminology.hl7.org/CodeSystem/condition-category", "encounter-diagnosis", "Encounter Diagnosis")] }],
      code,
      ...base(),
    };
    if (d.icd10Code !== null && isEye(d.laterality)) {
      body.bodySite = [{ coding: [coding(SCT, EYE_SITE[d.laterality].code, EYE_SITE[d.laterality].display)], text: EYE_TEXT[d.laterality] }];
    }
    return doc.add("Condition", "Condition", body);
  });
  return { complaint, diagnoses };
}

function sig(line: RxLine): string {
  const parts: string[] = [];
  const t = (s: string | null | undefined): string | null => (s === null || s === undefined || s.trim() === "" ? null : s.trim());
  const dose = t(line.dose);
  const frequency = t(line.frequency);
  const route = t(line.route);
  if (dose !== null) parts.push(dose);
  if (frequency !== null) parts.push(frequency);
  if (route !== null) parts.push(route);
  if (isEye(line.eye)) parts.push(EYE_TEXT[line.eye]);
  if (typeof line.durationDays === "number") parts.push(`${line.durationDays} days`);
  return parts.length === 0 ? line.drug : parts.join(" · ");
}

function medicationRequests(doc: Doc, v: OpdReleaseVisit, subject: Ref, encounter: Ref | null, requester: Ref, reasons: Ref[]): Ref[] {
  const rx = v.prescription;
  if (rx === null) return [];
  return rx.lines.map((line) => {
    const dosage: Json = { text: sig(line) };
    if (typeof line.durationDays === "number") dosage.timing = { repeat: { boundsDuration: { value: line.durationDays, unit: "d", system: "http://unitsofmeasure.org", code: "d" } } };
    if (typeof line.route === "string" && line.route.trim() !== "") dosage.route = { text: line.route.trim() };
    if (isEye(line.eye)) dosage.site = { coding: [coding(SCT, EYE_SITE[line.eye].code, EYE_SITE[line.eye].display)], text: EYE_TEXT[line.eye] };
    const body: Json = {
      status: "active",
      intent: "order",
      medicationCodeableConcept: { text: line.drug },
      subject,
      authoredOn: iso(rx.issuedAt),
      requester,
      dosageInstruction: [dosage],
    };
    if (encounter !== null) body.encounter = encounter;
    if (reasons.length > 0) body.reasonReference = reasons;
    if (typeof line.instructions === "string" && line.instructions.trim() !== "") body.note = [{ text: line.instructions.trim() }];
    if (line.noSubstitution) body.substitution = { allowedBoolean: false };
    return { ...doc.add("MedicationRequest", "MedicationRequest", body), type: "MedicationRequest" };
  });
}

function bundleOf(doc: Doc, composition: Json): Json {
  const id = doc.id();
  const compositionId = doc.id();
  const comp = {
    fullUrl: `urn:uuid:${compositionId}`,
    resource: {
      resourceType: "Composition",
      id: compositionId,
      meta: { versionId: "1", lastUpdated: iso(doc.ctx.now), profile: [`${NRCES}/${composition.profile as string}`] },
      language: "en-IN",
      identifier: { system: `urn:hmis:hip:${doc.ctx.hip.id}:document`, value: compositionId },
      status: "final",
      ...(composition.body as Json),
    },
  };
  return {
    resourceType: "Bundle",
    id,
    meta: {
      versionId: "1",
      lastUpdated: iso(doc.ctx.now),
      profile: [`${NRCES}/DocumentBundle`],
      security: [coding("http://terminology.hl7.org/CodeSystem/v3-Confidentiality", "V", "very restricted")],
    },
    identifier: { system: `urn:hmis:hip:${doc.ctx.hip.id}:bundle`, value: id },
    type: "document",
    timestamp: iso(doc.ctx.now),
    entry: [comp, ...doc.entries],
  };
}

const SECTION = {
  chiefComplaints: coding(SCT, "422843007", "Chief complaint section"),
  medications: coding(SCT, "721912009", "Medication summary document"),
  investigationAdvice: coding(SCT, "721963009", "Order document"),
  prescription: coding(SCT, "440545006", "Prescription record"),
  labReport: coding(SCT, "4241000179101", "Laboratory report"),
  imagingReport: coding(SCT, "4201000179104", "Imaging report"),
} as const;

/** OPConsultation → OPConsultRecord. Always buildable for a completed visit. */
export function opConsultBundle(ctx: RecordContext, v: OpdReleaseVisit): Json {
  const doc = new Doc(ctx);
  const subject = patientResource(doc);
  const org = organizationResource(doc);
  const author = v.doctor === null ? org : practitionerResource(doc, v.doctor);
  // Conditions first so the Encounter can name them; their `encounter` is left off rather than
  // pointing forward — the Composition and the Encounter carry the linkage.
  const { complaint, diagnoses } = conditionResources(doc, v, subject, null);
  const encounter = encounterResource(doc, v, subject, org, diagnoses);
  const meds = medicationRequests(doc, v, subject, encounter, author, diagnoses);
  const advice = v.advisedTests.map((name) => doc.add("ServiceRequest", "ServiceRequest", {
    status: "active", intent: "order", code: { text: name }, subject, encounter, requester: author, authoredOn: iso(v.consultCompletedAt),
  }));

  const conditions = [...(complaint === null ? [] : [complaint]), ...diagnoses];
  const sections: Json[] = [conditions.length === 0
    ? { title: "Chief complaints", code: { coding: [SECTION.chiefComplaints] }, emptyReason: { coding: [coding("http://terminology.hl7.org/CodeSystem/list-empty-reason", "nilknown", "Nil Known")] } }
    : { title: "Chief complaints and diagnoses", code: { coding: [SECTION.chiefComplaints] }, entry: conditions.map(({ reference }) => ({ reference })) }];
  if (meds.length > 0) sections.push({ title: "Medications", code: { coding: [SECTION.medications] }, entry: meds.map(({ reference }) => ({ reference })) });
  if (advice.length > 0) sections.push({ title: "Investigation advice", code: { coding: [SECTION.investigationAdvice] }, entry: advice.map(({ reference }) => ({ reference })) });

  const title = `OPD consultation · ${v.departmentName ?? "OPD"} · ${v.serviceDate}`;
  return bundleOf(doc, {
    profile: "OPConsultRecord",
    body: {
      type: { coding: [coding(SCT, "371530004", "Clinical consultation report")], text: "Clinical consultation report" },
      subject, encounter, date: iso(v.consultCompletedAt), author: [author], title, custodian: org, section: sections,
    },
  });
}

/** Prescription → PrescriptionRecord, or null when the visit issued none. */
export function prescriptionBundle(ctx: RecordContext, v: OpdReleaseVisit): Json | null {
  if (v.prescription === null || v.prescription.lines.length === 0) return null;
  const doc = new Doc(ctx);
  const subject = patientResource(doc);
  const org = organizationResource(doc);
  const author = v.doctor === null ? org : practitionerResource(doc, v.doctor);
  const encounter = encounterResource(doc, v, subject, org, []);
  const meds = medicationRequests(doc, v, subject, encounter, author, []);
  return bundleOf(doc, {
    profile: "PrescriptionRecord",
    body: {
      type: { coding: [SECTION.prescription], text: "Prescription record" },
      subject, encounter, date: iso(v.prescription.issuedAt), author: [author],
      title: `Prescription · ${v.departmentName ?? "OPD"} · ${v.serviceDate}`, custodian: org,
      section: [{ title: "Prescription record", code: { coding: [SECTION.prescription] }, entry: meds.map(({ reference }) => ({ reference, type: "MedicationRequest" })) }],
    },
  });
}

const INTERPRETATION: Record<string, string> = { H: "High", L: "Low", HH: "Critical high", LL: "Critical low", A: "Abnormal" };

function valueOf(value: LabReleaseValue): Json {
  const n = value.valueNumeric === null ? Number.NaN : Number(value.valueNumeric);
  if (Number.isFinite(n)) return { valueQuantity: value.unit === null ? { value: n } : { value: n, unit: value.unit } };
  return { valueString: value.valueText ?? value.valueNumeric ?? "" };
}

function referenceRange(value: LabReleaseValue): Json[] {
  const q = (s: string | null): Json | null => {
    const n = s === null ? Number.NaN : Number(s);
    return Number.isFinite(n) ? (value.unit === null ? { value: n } : { value: n, unit: value.unit }) : null;
  };
  const low = q(value.refLow);
  const high = q(value.refHigh);
  if (low === null && high === null && value.refText === null) return [];
  const r: Json = {};
  if (low !== null) r.low = low;
  if (high !== null) r.high = high;
  if (value.refText !== null) r.text = value.refText;
  return [r];
}

function shown(value: LabReleaseValue): string {
  const v = value.valueNumeric === null ? value.valueText ?? "" : String(Number(value.valueNumeric));
  return `${value.analyteName} ${v}${value.unit === null ? "" : ` ${value.unit}`}${value.flag === null ? "" : ` (${value.flag})`}`;
}

/** One lab TEST → DiagnosticReportRecord (DiagnosticReportLab + its Observations). */
export function labReportBundle(ctx: RecordContext, v: OpdReleaseVisit, test: LabReleaseTest): Json {
  const doc = new Doc(ctx);
  const subject = patientResource(doc);
  const org = organizationResource(doc);
  const encounter = encounterResource(doc, v, subject, org, []);
  const results = test.values.map((value) => {
    const code: Json = { text: value.analyteName };
    if (value.loincCode !== null && value.loincCode.trim() !== "") code.coding = [coding(LOINC, value.loincCode.trim(), value.analyteName)];
    const body: Json = {
      status: "final", code, subject, encounter, effectiveDateTime: iso(value.verifiedAt), issued: iso(value.verifiedAt),
      performer: [org], ...valueOf(value),
    };
    const flag = value.flag === null ? null : value.flag.toUpperCase();
    if (flag !== null && INTERPRETATION[flag] !== undefined) {
      body.interpretation = [{ coding: [coding("http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", flag, INTERPRETATION[flag]!)] }];
    }
    const range = referenceRange(value);
    if (range.length > 0) body.referenceRange = range;
    if (value.remarks !== null && value.remarks.trim() !== "") body.note = [{ text: value.remarks.trim() }];
    return doc.add("Observation", "Observation", body);
  });
  const report = doc.add("DiagnosticReport", "DiagnosticReportLab", {
    identifier: [{ system: `urn:hmis:hip:${ctx.hip.id}:lab-order`, value: `${test.orderNo}/${test.testCode}` }],
    status: "final",
    code: { text: test.testName },
    subject, encounter,
    issued: iso(test.issuedAt),
    performer: [org],
    resultsInterpreter: [org],
    result: results.map(({ reference }) => ({ reference })),
    // `conclusion` is 1..1 in the IG. The bench records values, not an interpretation, so the
    // conclusion is the verified values themselves — never a sentence the pathologist did not write.
    conclusion: test.values.map(shown).join("; "),
  });
  return bundleOf(doc, {
    profile: "DiagnosticReportRecord",
    body: {
      type: { coding: [coding(SCT, "721981007", "Diagnostic studies report")], text: "Laboratory report" },
      subject, encounter, date: iso(test.issuedAt), author: [org], title: `Laboratory report · ${test.testName}`, custodian: org,
      section: [{ title: test.testName, code: { coding: [SECTION.labReport] }, entry: [{ reference: report.reference, type: "DiagnosticReport" }] }],
    },
  });
}

/** The signed imaging report as text — what the DocumentReference carries. */
export function imagingReportText(r: ImagingReleaseReport): string {
  const lines = [`${r.studyName} — accession ${r.accessionNo}`, `Signed ${r.signedAt.toISOString()}`, ""];
  for (const s of r.sections) lines.push(s.name.replace(/_/g, " ").toUpperCase(), s.text, "");
  if (r.impression !== null) lines.push("IMPRESSION", r.impression, "");
  return lines.join("\n").trimEnd();
}

/** One signed imaging report → DiagnosticReportRecord carrying a DocumentReference (see the header on Media). */
export function imagingReportBundle(ctx: RecordContext, v: OpdReleaseVisit, r: ImagingReleaseReport): Json {
  const doc = new Doc(ctx);
  const subject = patientResource(doc);
  const org = organizationResource(doc);
  const encounter = encounterResource(doc, v, subject, org, []);
  const docRef = doc.add("DocumentReference", "DocumentReference", {
    identifier: [{ system: `urn:hmis:hip:${ctx.hip.id}:imaging-accession`, value: r.accessionNo }],
    status: "current",
    docStatus: "final",
    type: { coding: [SECTION.imagingReport], text: r.studyName },
    subject,
    date: iso(r.signedAt),
    author: [org],
    custodian: org,
    content: [{ attachment: {
      contentType: "text/plain", language: "en-IN", title: r.studyName, creation: iso(r.signedAt),
      data: Buffer.from(imagingReportText(r), "utf8").toString("base64"),
    } }],
    context: { encounter: [encounter] },
  });
  return bundleOf(doc, {
    profile: "DiagnosticReportRecord",
    body: {
      type: { coding: [coding(SCT, "721981007", "Diagnostic studies report")], text: "Imaging report" },
      subject, encounter, date: iso(r.signedAt), author: [org], title: `Imaging report · ${r.studyName}`, custodian: org,
      section: [{ title: r.studyName, code: { coding: [SECTION.imagingReport] }, entry: [{ reference: docRef.reference, type: "DocumentReference" }] }],
    },
  });
}
