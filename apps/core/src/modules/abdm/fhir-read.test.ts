import { createFakeAbdmGateway } from "../../../test/helpers/abdm-fake-gateway";
import { remoteBundles } from "../../../test/helpers/abdm-hiu";
import { imagingReportBundle } from "./fhir-records";
import { classifyBundle, summarizeBundle } from "./fhir-read";

/**
 * ABDM S3 — reading another facility's document: its HI type from the Composition (profile, else the
 * SNOMED type), and a bounded, never-throwing display of its key content. The documents are built with
 * the hospital's OWN NRCeS builders for a remote facility, so they are the IG's shapes.
 */
const fake = createFakeAbdmGateway({ clientId: "x", clientSecret: "y" });
const docs = remoteBundles(fake);
const lines = (b: unknown): string => summarizeBundle(b).sections.flatMap((s) => [s.title, ...s.lines]).join("\n");

describe("classifyBundle", () => {
  it("names the HI type of each document from its Composition profile", () => {
    expect(docs.map((d) => { const v = classifyBundle(d.bundle); return v.ok ? v.hiType : v.reason; })).toEqual(docs.map((d) => d.hiType));
  });

  it("falls back to the SNOMED Composition type when the profile is absent", () => {
    const b = structuredClone(docs[1]!.bundle) as { entry: { resource: { meta?: unknown } }[] };
    delete b.entry[0]!.resource.meta;
    expect(classifyBundle(b)).toMatchObject({ ok: true, hiType: "Prescription" });
  });

  it("refuses what is not an ABDM document: not a Bundle, not a document, no Composition, an unknown type", () => {
    expect(classifyBundle({ resourceType: "Patient" })).toEqual({ ok: false, reason: "not a FHIR Bundle" });
    expect(classifyBundle({ resourceType: "Bundle", type: "collection", entry: [] })).toEqual({ ok: false, reason: "not a FHIR document bundle" });
    expect(classifyBundle({ resourceType: "Bundle", type: "document", entry: [] })).toEqual({ ok: false, reason: "the document has no Composition" });
    expect(classifyBundle({ resourceType: "Bundle", type: "document", entry: [{ resource: { resourceType: "Composition", type: { coding: [{ code: "1" }] } } }] }))
      .toEqual({ ok: false, reason: "not a recognisable ABDM record type" });
  });
});

describe("summarizeBundle", () => {
  it("an OP consult: complaint and ICD-coded diagnosis, medication with its dosage, advised tests; author, custodian, subject", () => {
    const s = summarizeBundle(docs[0]!.bundle);
    expect(s).toMatchObject({ custodian: "Fortis Escorts Jaipur", authors: ["Dr. Kavya Rao"], subjectName: "Sunita Sharma" });
    expect(s.title).toMatch(/^OPD consultation · Cardiology · 2026-07-14/);
    const t = lines(docs[0]!.bundle);
    expect(t).toContain("Chest discomfort on exertion");
    expect(t).toContain("Stable angina (I20.8)");
    expect(t).toContain("Atorvastatin 20 mg tablet — 1 tab · HS · oral · 30 days");
    expect(t).toContain("Treadmill test");
  });

  it("a lab report: the test, its conclusion, and each value with unit, flag and range", () => {
    expect(lines(docs[2]!.bundle)).toMatch(/LDL cholesterol: 162 mg\/dL · High · ref 130 mg\/dL/);
  });

  it("a plain-text DocumentReference is shown as its text", () => {
    const b = imagingReportBundle(
      { hip: { id: "IN0810000123", name: "Fortis Escorts Jaipur" }, patient: { uhid: "F1", name: "Sunita Sharma", gender: "female", birthDate: null, phone: null, abhaNumber: null }, now: new Date("2026-08-01T00:00:00Z") },
      { encounterId: "E", visitNo: "V", patientId: "P", serviceDate: "2026-08-01", consultStartedAt: null, consultCompletedAt: new Date("2026-08-01T05:00:00Z"), departmentName: null, doctor: null, chiefComplaint: null, diagnosisKind: null, diagnoses: [], advisedTests: [], prescription: null },
      { reportId: "R", studyId: "S", accessionNo: "ACC1", encounterNo: "V", patientId: "P", studyName: "X-ray chest PA view", signedAt: new Date("2026-08-01T06:00:00Z"), sections: [{ name: "findings", text: "Lung fields clear." }], impression: "No active lung lesion." },
    );
    expect(lines(b)).toContain("No active lung lesion.");
  });

  it("never throws on a hostile document, and bounds what it shows", () => {
    expect(summarizeBundle(null)).toEqual({ title: null, date: null, authors: [], custodian: null, subjectName: null, sections: [] });
    const huge = { resourceType: "Bundle", type: "document", entry: [{ fullUrl: "urn:uuid:c", resource: { resourceType: "Composition", title: "x".repeat(5000), section: [{ title: "S", entry: Array.from({ length: 500 }, () => ({ reference: "urn:uuid:o" })) }] } }, { fullUrl: "urn:uuid:o", resource: { resourceType: "Observation", code: { text: "Hb" }, valueQuantity: { value: 9, unit: "g/dL" } } }] };
    const s = summarizeBundle(huge);
    expect(s.title!.length).toBeLessThanOrEqual(300);
    expect(s.sections[0]!.lines).toHaveLength(60);
  });
});
