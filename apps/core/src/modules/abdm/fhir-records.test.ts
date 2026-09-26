import { readFileSync } from "node:fs";
import {
  IG_PACKAGE_DIR, IgChecker, SLIM_FIXTURE, igPackagePresent, loadSlimIg, slimProfiles,
} from "../../../test/helpers/fhir-ig";
import {
  imagingReportBundle, imagingReportText, labReportBundle, opConsultBundle, prescriptionBundle,
} from "./fhir-records";
import type { RecordContext } from "./fhir-records";
import type { OpdReleaseVisit } from "../opd";
import type { LabReleaseTest } from "../lab";
import type { ImagingReleaseReport } from "../radiology";

/**
 * ABDM S2 — every bundle the hospital releases, checked against the NRCeS IG v6.5.0 profiles it
 * claims (`test/helpers/fhir-ig.ts` says what the checker enforces and what it does not). The
 * checker is tested first, on bundles broken on purpose, so a green here is not a checker that
 * passes everything.
 */
const checker = new IgChecker(loadSlimIg());
let n = 0;
const ctx = (): RecordContext => ({
  hip: { id: "IN0000000001", name: "CRK MEDICAL COLLEGE & HOSPITAL" },
  patient: { uhid: "HMS00000013", name: "Sunita Sharma", gender: "female", birthDate: "1986-03-14", phone: "9876543210", abhaNumber: "91-2345-6789-0123" },
  now: new Date("2026-09-25T06:00:00.000Z"),
  uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
});

const visit = (over: Partial<OpdReleaseVisit> = {}): OpdReleaseVisit => ({
  encounterId: "01ENC0000000000000000000001", visitNo: "V2609250001", patientId: "01PAT", serviceDate: "2026-09-25",
  consultStartedAt: new Date("2026-09-25T04:10:00.000Z"), consultCompletedAt: new Date("2026-09-25T04:25:00.000Z"),
  departmentName: "General Medicine",
  doctor: { id: "D1", displayName: "Dr. Anil Verma", code: "DR001", registrationNo: "BMC-12345" },
  chiefComplaint: "Fever for 3 days",
  diagnosisKind: "provisional",
  diagnoses: [
    { text: "Enteric fever", icd10Code: "A01.0", icd10Display: "Typhoid fever", laterality: null },
    { text: "dehydration, mild", icd10Code: null, icd10Display: null, laterality: null },
  ],
  advisedTests: ["Widal test", "Complete blood count"],
  prescription: {
    id: "RX1", version: 2, issuedAt: new Date("2026-09-25T04:24:00.000Z"),
    lines: [
      { drug: "Paracetamol 650 mg tablet", medicineId: "MED-LOCAL-9", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: "after food", noSubstitution: false },
      { drug: "ORS sachet", dose: "1 sachet in 1 L", route: "oral", frequency: "as needed", durationDays: null, instructions: null, noSubstitution: true },
    ],
  },
  ...over,
});

const labTest = (over: Partial<LabReleaseTest> = {}): LabReleaseTest => ({
  orderItemId: "OI1", orderNo: "LO2609250007", encounterNo: "V2609250001", patientId: "01PAT", testName: "Complete blood count", testCode: "CBC",
  issuedAt: new Date("2026-09-25T09:00:00.000Z"),
  values: [
    { resultId: "R1", analyteName: "Haemoglobin", loincCode: "718-7", valueNumeric: "9.1000", valueText: null, unit: "g/dL", flag: "L", refLow: "12.0000", refHigh: "15.0000", refText: null, verifiedAt: new Date("2026-09-25T09:00:00.000Z"), remarks: null },
    { resultId: "R2", analyteName: "Peripheral smear", loincCode: null, valueNumeric: null, valueText: "Microcytic hypochromic", unit: null, flag: null, refLow: null, refHigh: null, refText: null, verifiedAt: new Date("2026-09-25T08:55:00.000Z"), remarks: "Suggest iron studies" },
  ],
  ...over,
});

const imaging: ImagingReleaseReport = {
  reportId: "IR1", studyId: "S1", accessionNo: "RA260925001", encounterNo: "V2609250001", patientId: "01PAT",
  studyName: "X-ray chest PA view", signedAt: new Date("2026-09-25T10:00:00.000Z"),
  sections: [{ name: "technique", text: "PA erect" }, { name: "findings", text: "Lung fields clear." }],
  impression: "No active lung lesion.",
};

type Json = Record<string, unknown>;
const resources = (b: Json): Json[] => (b.entry as { resource: Json }[]).map((e) => e.resource);
const composition = (b: Json): Json => resources(b)[0]!;
const ofType = (b: Json, t: string): Json[] => resources(b).filter((r) => r.resourceType === t);

describe("the IG checker is not vacuous", () => {
  it("finds a missing required element, a wrong fixed code, a closed-slice violation and a dangling reference", () => {
    const b = opConsultBundle(ctx(), visit()) as Json;
    expect(checker.checkBundle(b)).toEqual([]);

    const noSubject = structuredClone(b);
    delete (composition(noSubject)).subject;
    expect(checker.checkBundle(noSubject).join("\n")).toMatch(/Composition\.subject is required/);

    const wrongType = structuredClone(b);
    ((composition(wrongType).type as Json).coding as Json[])[0]!.code = "440545006";
    expect(checker.checkBundle(wrongType).join("\n")).toMatch(/Composition\.type\.coding\.code must be "371530004"/);

    const localCoding = structuredClone(b);
    (ofType(localCoding, "Condition")[1]!.code as Json).coding = [{ system: "urn:hmis:local", code: "X", display: "x" }];
    expect(checker.checkBundle(localCoding).join("\n")).toMatch(/Condition\.code\.coding member .* matches no slice \(closed\)/);

    const dangling = structuredClone(b);
    (composition(dangling).subject as Json).reference = "urn:uuid:ffffffff-ffff-4fff-8fff-ffffffffffff";
    expect(checker.checkBundle(dangling).join("\n")).toMatch(/does not resolve in the bundle/);

    const noBundleVersion = structuredClone(b);
    delete (noBundleVersion.meta as Json).versionId;
    expect(checker.checkBundle(noBundleVersion).join("\n")).toMatch(/Bundle\.meta\.versionId is required/);
  });

  it("the committed slim profiles are exactly what the IG package on this box slims to (skipped where the package is absent, e.g. CI)", () => {
    if (!igPackagePresent()) return;
    expect(JSON.parse(readFileSync(SLIM_FIXTURE, "utf8"))).toEqual(JSON.parse(JSON.stringify(slimProfiles(IG_PACKAGE_DIR))));
  });
});

describe("OPConsultRecord", () => {
  it("passes the IG check, with SNOMED 371530004, the subject + encounter + author + custodian, and its sections", () => {
    const b = opConsultBundle(ctx(), visit()) as Json;
    expect(checker.checkBundle(b)).toEqual([]);
    const c = composition(b);
    expect((c.meta as Json).profile).toEqual(["https://nrces.in/ndhm/fhir/r4/StructureDefinition/OPConsultRecord"]);
    expect((c.type as Json).coding).toEqual([{ system: "http://snomed.info/sct", code: "371530004", display: "Clinical consultation report" }]);
    const sections = (c.section as Json[]).map((s) => ((s.code as Json).coding as Json[])[0]!.code);
    expect(sections).toEqual(["422843007", "721912009", "721963009"]);
    expect(b.type).toBe("document");
    expect((b.meta as Json).versionId).toBe("1");
  });

  it("an ICD-10 diagnosis the doctor PICKED is coded (with the catalogue display); a typed one is text only; the complaint is text", () => {
    const b = opConsultBundle(ctx(), visit()) as Json;
    const codes = ofType(b, "Condition").map((r) => r.code);
    expect(codes).toEqual([
      { text: "Fever for 3 days" },
      { text: "Enteric fever", coding: [{ system: "http://hl7.org/fhir/sid/icd-10", code: "A01.0", display: "Typhoid fever" }] },
      { text: "dehydration, mild" },
    ]);
    expect(((ofType(b, "Encounter")[0]!.diagnosis) as Json[]).length).toBe(2);
  });

  it("a medicine goes as TEXT — the local formulary code never reaches the bundle (the IG fixes SNOMED)", () => {
    const b = opConsultBundle(ctx(), visit()) as Json;
    const meds = ofType(b, "MedicationRequest");
    expect(meds.map((m) => m.medicationCodeableConcept)).toEqual([{ text: "Paracetamol 650 mg tablet" }, { text: "ORS sachet" }]);
    expect(JSON.stringify(b)).not.toContain("MED-LOCAL-9");
    expect(JSON.stringify(b)).not.toContain("urn:hmis:formulary");
    expect(meds[1]!.substitution).toEqual({ allowedBoolean: false });
  });

  it("a visit with no complaint, no diagnosis, no prescription and no advice still passes (an EMPTY chief-complaint section)", () => {
    const b = opConsultBundle(ctx(), visit({ chiefComplaint: null, diagnoses: [], prescription: null, advisedTests: [], doctor: null })) as Json;
    expect(checker.checkBundle(b)).toEqual([]);
    expect((composition(b).section as Json[])).toHaveLength(1);
    expect(ofType(b, "Practitioner")).toHaveLength(0);
  });
});

describe("PrescriptionRecord", () => {
  it("passes the IG check: SNOMED 440545006, one section, entries typed MedicationRequest", () => {
    const b = prescriptionBundle(ctx(), visit()) as Json;
    expect(checker.checkBundle(b)).toEqual([]);
    const s = (composition(b).section as Json[])[0]!;
    expect((s.entry as Json[]).map((e) => e.type)).toEqual(["MedicationRequest", "MedicationRequest"]);
  });

  it("is null for a visit that issued no prescription", () => {
    expect(prescriptionBundle(ctx(), visit({ prescription: null }))).toBeNull();
  });
});

describe("DiagnosticReportRecord", () => {
  it("a lab test: DiagnosticReportLab with one Observation per verified value, LOINC only where the analyte has one, interpretation from the flag", () => {
    const b = labReportBundle(ctx(), visit(), labTest()) as Json;
    expect(checker.checkBundle(b)).toEqual([]);
    const report = ofType(b, "DiagnosticReport")[0]!;
    expect((report.meta as Json).profile).toEqual(["https://nrces.in/ndhm/fhir/r4/StructureDefinition/DiagnosticReportLab"]);
    expect(report.result as Json[]).toHaveLength(2);
    const obs = ofType(b, "Observation");
    expect(obs[0]!.code).toEqual({ text: "Haemoglobin", coding: [{ system: "http://loinc.org", code: "718-7", display: "Haemoglobin" }] });
    expect(obs[0]!.valueQuantity).toEqual({ value: 9.1, unit: "g/dL" });
    expect(obs[0]!.interpretation).toEqual([{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: "L", display: "Low" }] }]);
    expect(obs[1]!.code).toEqual({ text: "Peripheral smear" });
    expect(obs[1]!.valueString).toBe("Microcytic hypochromic");
    expect(report.conclusion).toBe("Haemoglobin 9.1 g/dL (L); Peripheral smear Microcytic hypochromic");
    const s = (composition(b).section as Json[])[0]!;
    expect(s.entry).toEqual([{ reference: report.id === undefined ? "" : `urn:uuid:${String(report.id)}`, type: "DiagnosticReport" }]);
  });

  it("a signed imaging report: a DocumentReference whose text is the signed report — sections and impression", () => {
    const b = imagingReportBundle(ctx(), visit(), imaging) as Json;
    expect(checker.checkBundle(b)).toEqual([]);
    const docRef = ofType(b, "DocumentReference")[0]!;
    const attachment = ((docRef.content as Json[])[0]!.attachment as Json);
    expect(attachment.contentType).toBe("text/plain");
    expect(Buffer.from(String(attachment.data), "base64").toString("utf8")).toBe(imagingReportText(imaging));
    expect(imagingReportText(imaging)).toContain("IMPRESSION\nNo active lung lesion.");
    expect(ofType(b, "DiagnosticReport")).toHaveLength(0);
  });
});
