import { ALL_HI_TYPES } from "./hiu-client";
import type { AnyHiType } from "./hiu-client";

/**
 * ═══ ABDM S3 — READING ANOTHER FACILITY'S FHIR DOCUMENT: WHAT IS IT, AND WHAT DOES IT SAY ═══
 *
 * PURE: a parsed Bundle in, a verdict or a display summary out. The HIU stores the bundle as it
 * arrived (`abdm_external_records.bundle`) and renders it read-only through `summarizeBundle`, which
 * never throws and never trusts the document's shape: every field is optional, every string is
 * bounded, and a reference that resolves to nothing is simply not shown.
 *
 * THE HI TYPE is read from the Composition's profile (NRCeS IG v6.5.0 — `OPConsultRecord`,
 * `PrescriptionRecord`, `DiagnosticReportRecord`, `DischargeSummaryRecord`, `ImmunizationRecord`,
 * `HealthDocumentRecord`, `WellnessRecord`, `InvoiceRecord`), else from its SNOMED `type` (the codes
 * the IG fixes; the ones this hospital also SENDS are in `fhir-records.ts`). A document that is
 * neither is not a recognisable ABDM record, and the HIU refuses it rather than guessing.
 *
 * WHAT IS SHOWN: the Composition's title, date, author and custodian, the subject's name (so the
 * doctor can see whose record it says it is), and each section as lines — conditions, medication
 * requests with their dosage text, observations with value, unit, flag and range, diagnostic reports
 * with their conclusion and results, service requests, allergies, procedures, immunizations, and a
 * plain-text DocumentReference's text. A PDF or image attachment is NAMED, not rendered.
 */
type Json = Record<string, unknown>;
const o = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const MAX_LINE = 300;
const MAX_LINES = 60;
const s = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t === "" ? null : t.slice(0, MAX_LINE);
};

const PROFILE_TYPES: Record<string, AnyHiType> = {
  OPConsultRecord: "OPConsultation",
  PrescriptionRecord: "Prescription",
  DiagnosticReportRecord: "DiagnosticReport",
  DischargeSummaryRecord: "DischargeSummary",
  ImmunizationRecord: "ImmunizationRecord",
  HealthDocumentRecord: "HealthDocumentRecord",
  WellnessRecord: "WellnessRecord",
  InvoiceRecord: "Invoice",
};
/** The Composition.type codes the IG fixes (SNOMED CT), where a sender omits the profile. */
const SNOMED_TYPES: Record<string, AnyHiType> = {
  "371530004": "OPConsultation",
  "440545006": "Prescription",
  "721981007": "DiagnosticReport",
  "373942005": "DischargeSummary",
  "41000179103": "ImmunizationRecord",
  "419891008": "HealthDocumentRecord",
};

export type BundleVerdict =
  | { ok: true; hiType: AnyHiType; composition: Json; title: string | null; date: Date | null }
  | { ok: false; reason: string };

function compositionOf(bundle: Json): Json | null {
  for (const e of arr(bundle.entry)) {
    const r = o(o(e).resource);
    if (r.resourceType === "Composition") return r;
  }
  return null;
}

/** Is this a FHIR document an HIU can store — and of which HI type? */
export function classifyBundle(bundle: unknown): BundleVerdict {
  const b = o(bundle);
  if (b.resourceType !== "Bundle") return { ok: false, reason: "not a FHIR Bundle" };
  if (b.type !== "document") return { ok: false, reason: "not a FHIR document bundle" };
  const comp = compositionOf(b);
  if (comp === null) return { ok: false, reason: "the document has no Composition" };
  let hiType: AnyHiType | null = null;
  for (const p of arr(o(comp.meta).profile)) {
    const name = typeof p === "string" ? p.split("/").pop() ?? "" : "";
    if (PROFILE_TYPES[name] !== undefined) { hiType = PROFILE_TYPES[name]; break; }
  }
  if (hiType === null) {
    for (const c of arr(o(comp.type).coding)) {
      const code = s(o(c).code);
      if (code !== null && SNOMED_TYPES[code] !== undefined) { hiType = SNOMED_TYPES[code]; break; }
    }
  }
  if (hiType === null || !(ALL_HI_TYPES as readonly string[]).includes(hiType)) return { ok: false, reason: "not a recognisable ABDM record type" };
  const t = typeof comp.date === "string" ? Date.parse(comp.date) : Number.NaN;
  return { ok: true, hiType, composition: comp, title: s(comp.title), date: Number.isFinite(t) ? new Date(t) : null };
}

export type ExternalRecordSummary = {
  title: string | null;
  date: string | null;
  authors: string[];
  custodian: string | null;
  subjectName: string | null;
  sections: { title: string; lines: string[] }[];
};

const text = (cc: unknown): string | null => {
  const c = o(cc);
  return s(c.text) ?? arr(c.coding).map((x) => s(o(x).display) ?? s(o(x).code)).find((x) => x !== null) ?? null;
};
const codeOf = (cc: unknown, system: string): string | null =>
  arr(o(cc).coding).map(o).filter((c) => c.system === system).map((c) => s(c.code)).find((x) => x !== null) ?? null;
const quantity = (q: unknown): string | null => {
  const v = o(q);
  if (typeof v.value !== "number" && typeof v.value !== "string") return null;
  const unit = s(v.unit) ?? s(v.code);
  return `${String(v.value)}${unit === null ? "" : ` ${unit}`}`;
};
const dateOnly = (v: unknown): string | null => (typeof v === "string" && v.length >= 10 ? v.slice(0, 10) : null);

/** The whole bundle, indexed by both reference spellings a document uses: `urn:uuid:…` and `Type/id`. */
function indexOf(bundle: Json): Map<string, Json> {
  const m = new Map<string, Json>();
  for (const e of arr(bundle.entry)) {
    const r = o(o(e).resource);
    const full = s(o(e).fullUrl);
    if (full !== null) m.set(full, r);
    if (typeof r.resourceType === "string" && typeof r.id === "string") m.set(`${r.resourceType}/${r.id}`, r);
  }
  return m;
}

function observationLine(r: Json): string {
  const name = text(r.code) ?? "Observation";
  const value = quantity(r.valueQuantity) ?? s(r.valueString) ?? text(r.valueCodeableConcept)
    ?? (typeof r.valueBoolean === "boolean" ? String(r.valueBoolean) : null);
  const flag = arr(r.interpretation).map(text).find((x) => x !== null) ?? null;
  const range = arr(r.referenceRange).map(o).map((rr) => s(rr.text) ?? [quantity(rr.low), quantity(rr.high)].filter((x) => x !== null).join("–")).find((x) => x !== null && x !== "") ?? null;
  return [`${name}${value === null ? "" : `: ${value}`}`, flag, range === null ? null : `ref ${range}`].filter((x) => x !== null).join(" · ");
}

function linesOf(r: Json, index: Map<string, Json>, depth = 0): string[] {
  const type = r.resourceType;
  if (type === "Condition") {
    const icd = codeOf(r.code, "http://hl7.org/fhir/sid/icd-10");
    const site = arr(r.bodySite).map(text).find((x) => x !== null) ?? null;
    return [`${text(r.code) ?? "Condition"}${icd === null ? "" : ` (${icd})`}${site === null ? "" : ` · ${site}`}`];
  }
  if (type === "MedicationRequest" || type === "MedicationStatement") {
    const drug = text(r.medicationCodeableConcept) ?? s(o(r.medicationReference).display) ?? "Medicine";
    const dosage = arr(r.dosageInstruction ?? r.dosage).map((d) => s(o(d).text)).filter((x) => x !== null).join("; ");
    return [`${drug}${dosage === "" ? "" : ` — ${dosage}`}`];
  }
  if (type === "Observation") return [observationLine(r)];
  if (type === "DiagnosticReport") {
    const head = `${text(r.code) ?? "Report"}${s(r.conclusion) === null ? "" : ` — ${s(r.conclusion)!}`}`;
    const results = depth > 1 ? [] : arr(r.result).map((x) => index.get(s(o(x).reference) ?? "")).filter((x): x is Json => x !== undefined)
      .flatMap((x) => linesOf(x, index, depth + 1).map((l) => `  ${l}`));
    const docs = arr(r.presentedForm).map((f) => s(o(f).title)).filter((x) => x !== null).map((t) => `  [attachment: ${t!}]`);
    return [head, ...results, ...docs];
  }
  if (type === "DocumentReference") {
    const title = text(r.type) ?? "Document";
    const out = [title];
    for (const c of arr(r.content)) {
      const a = o(o(c).attachment);
      const ct = s(a.contentType) ?? "";
      if (ct.startsWith("text/plain") && typeof a.data === "string") {
        const body = Buffer.from(a.data, "base64").toString("utf8").slice(0, 20_000);
        out.push(...body.split(/\r?\n/).map((l) => s(l)).filter((l): l is string => l !== null));
      } else {
        out.push(`[attachment: ${s(a.title) ?? (ct === "" ? "file" : ct)}]`);
      }
    }
    return out;
  }
  if (type === "Immunization") {
    return [`${text(r.vaccineCode) ?? "Immunization"}${dateOnly(r.occurrenceDateTime) === null ? "" : ` · ${dateOnly(r.occurrenceDateTime)!}`}`];
  }
  if (type === "ServiceRequest" || type === "AllergyIntolerance" || type === "Procedure" || type === "FamilyMemberHistory" || type === "CarePlan") {
    return [text(r.code) ?? s(r.title) ?? String(type)];
  }
  if (type === "Appointment") return [`Follow-up${s(r.description) === null ? "" : `: ${s(r.description)!}`}${dateOnly(r.start) === null ? "" : ` · ${dateOnly(r.start)!}`}`];
  if (type === "Binary" || type === "Media") return ["[attachment]"];
  if (type === "Encounter" || type === "Patient" || type === "Practitioner" || type === "Organization") return [];
  const generic = text(r.code) ?? s(r.title) ?? s(r.name);
  return typeof type === "string" ? [`${type}${generic === null ? "" : `: ${generic}`}`] : [];
}

function narrative(section: Json): string[] {
  const div = s(o(section.text).div);
  if (div === null) return [];
  const plain = div.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  const t = s(plain);
  return t === null ? [] : [t];
}

function sectionsOf(list: unknown, index: Map<string, Json>, out: { title: string; lines: string[] }[], depth = 0): void {
  for (const sec of arr(list).map(o)) {
    const title = s(sec.title) ?? text(sec.code) ?? "Section";
    const lines = arr(sec.entry)
      .map((e) => index.get(s(o(e).reference) ?? ""))
      .filter((r): r is Json => r !== undefined)
      .flatMap((r) => linesOf(r, index));
    const all = lines.length > 0 ? lines : narrative(sec);
    if (all.length > 0) out.push({ title, lines: all.slice(0, MAX_LINES) });
    if (depth < 3) sectionsOf(sec.section, index, out, depth + 1);
  }
}

/** A read-only display of a stored document. Never throws; an unreadable document is an empty summary. */
export function summarizeBundle(bundle: unknown): ExternalRecordSummary {
  try {
    const b = o(bundle);
    const comp = compositionOf(b) ?? {};
    const index = indexOf(b);
    const display = (ref: unknown): string | null => {
      const x = o(ref);
      const target = index.get(s(x.reference) ?? "");
      return s(x.display) ?? (target === undefined ? null : s(target.name) ?? arr(target.name).map((n) => s(o(n).text)).find((n) => n !== null) ?? null);
    };
    const subject = index.get(s(o(comp.subject).reference) ?? "");
    const sections: { title: string; lines: string[] }[] = [];
    sectionsOf(comp.section, index, sections);
    return {
      title: s(comp.title),
      date: typeof comp.date === "string" ? comp.date : null,
      authors: arr(comp.author).map(display).filter((x): x is string => x !== null),
      custodian: display(comp.custodian),
      subjectName: subject === undefined ? s(o(comp.subject).display) : arr(subject.name).map((n) => s(o(n).text) ?? [arr(o(n).given).join(" "), s(o(n).family)].filter((x) => x !== null && x !== "").join(" ")).find((x) => x !== null && x !== "") ?? null,
      sections,
    };
  } catch {
    return { title: null, date: null, authors: [], custodian: null, subjectName: null, sections: [] };
  }
}
