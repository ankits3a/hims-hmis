import { api } from "./api";
import type { CodedSystem } from "./imaging-coded";

/**
 * PLAN 18-S RS8a — the reading room's wire, transcribed from `radiology-reading.controller.ts`
 * and the report controller's `checks` route. Like `radiology-api.ts`, it DESCRIBES what the
 * server ships and decides nothing: the checks shown on the screen are the server's dry run of the
 * same pipeline the signature meets.
 */

export type TatClass = "stat" | "er" | "ipd" | "opd";

export type WireReadingRow = {
  studyId: string; accessionNo: string; status: string; priority: string;
  studyTypeCode: string; studyTypeName: string; modality: string; bodyPart: string;
  patientId: string; patientName: string; patientSex: string; patientAge: number | null;
  restricted: boolean; formFRequired: boolean;
  acquiredAt: string | null;
  tatClass: TatClass; targetMinutes: number; dueAt: string | null;
  reportState: "none" | "draft" | "prelim" | "signed";
  readingBy: { userId: string; name: string; since: string } | null;
};

export type WireReadingTemplate = {
  key: string; name: string; governed: boolean;
  sections: { key: string; label: string; normal: string | null }[];
  macros: { key: string; label: string; section: string; text: string }[];
  coded: { system: CodedSystem; required: boolean }[];
};

export type WireReadingContext = {
  studyId: string; accessionNo: string; status: string; priority: string;
  studyTypeCode: string; studyTypeName: string; modality: string; laterality: string;
  bedsideLocation: string | null; acquiredAt: string | null;
  tatClass: TatClass; targetMinutes: number; dueAt: string | null;
  clinicalQuestion: string | null;
  referrer: { doctorCode: string | null; department: string | null };
  patient: { id: string; name: string; uhid: string; sex: string; age: number | null; flags: string[] };
  priors: { studyId: string; studyTypeName: string; signedAt: string; impression: string | null; criticalCategory: string | null }[];
  cumulativeDlp12m: number | null;
  canOpenImages: boolean;
  templates: WireReadingTemplate[];
  defaultTemplateKey: string;
  working: {
    reportId: string; version: number; status: string; templateKey: string;
    body: Record<string, unknown>; impression: string | null; criticalCategory: string | null;
  } | null;
  signed: { reportId: string; version: number; publishedAt: string | null } | null;
  readingBy: WireReadingRow["readingBy"];
};

export type WirePreSignFinding = { code: string; level: "refuse" | "warn"; words: string };

export type WireSignerBlock = {
  userId: string; name: string; qualification: string; designation: string | null;
  councilRegNo: string; councilRegSource: string; doctorCode: string | null;
  signature: { method: string; secondFactorAt: string; keyId: string | null; contentSha256: string };
};

export type WireReportPrint = {
  reportId: string; version: number; status: string; accessionNo: string; studyTypeName: string;
  acquiredAt: string | null; signedAt: string; amendmentReason: string | null;
  letterhead: { name: string; addressLines: string[] } | null;
  patient: { name: string; uhid: string; sex: string; age: number | null };
  referrer: { doctorCode: string | null; department: string | null };
  sections: { key: string; label: string; text: string }[];
  impression: string | null;
  codedLines: string[];
  criticalCategory: string | null;
  signer: WireSignerBlock | null;
  signerId: string;
};

export const fetchReadingWorklist = () => api<{ rows: WireReadingRow[] }>("GET", "/radiology/reading/worklist");

export const fetchReadingStudy = (studyId: string) =>
  api<{ study: WireReadingContext | null }>("GET", `/radiology/reading/studies/${studyId}`);

export const dryRunChecks = (studyId: string, body: {
  templateKey?: string; body: Record<string, unknown>; impression?: string | null; criticalCategory?: string | null;
}) => api<{ findings: WirePreSignFinding[]; signable: boolean }>("POST", `/radiology/studies/${studyId}/reports/checks`, body);

export const signReading = (studyId: string, body: {
  reportId: string; criticalCategory?: string | null; acknowledgedWarnings?: string[];
}) => api<{ reportId: string; version: number }>("POST", `/radiology/studies/${studyId}/reports/sign`, body);

export const fetchReportPrint = (reportId: string) =>
  api<{ report: WireReportPrint | null }>("GET", `/radiology/reports/${reportId}/print`);

/**
 * The session's second factor: `POST /auth/totp/verify` stamps it on the SESSION, and the sign
 * route then reads it off the session (§11.19-D-27) — the code never travels with the report.
 */
export const verifySecondFactor = (code: string) => api<void>("POST", "/auth/totp/verify", { code });

/** A refusal from the guard (Nest's `ForbiddenException("second_factor_required")`) or the service. */
export function needsSecondFactor(e: unknown): boolean {
  const body = (e as { body?: { code?: string; message?: string } } | undefined)?.body;
  return body?.code === "second_factor_required" || body?.message === "second_factor_required";
}
