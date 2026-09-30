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
  /** 18-S RS8b — `awaiting_cosign`: a resident signed it and a consultant has not co-signed yet. */
  reportState: "none" | "draft" | "prelim" | "signed" | "awaiting_cosign";
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
  signed: {
    reportId: string; version: number; publishedAt: string | null;
    /** 18-S RS8b — the signed text, so Amend starts from what was signed. */
    templateKey?: string; body?: Record<string, unknown>; impression?: string | null; laterality?: string | null;
    criticalCategory?: string | null;
  } | null;
  /** 18-S RS8b — a resident's signed text waiting for a consultant's co-sign. */
  awaitingCosign?: {
    reportId: string; version: number; residentId: string | null; residentName: string; signedAt: string | null;
    templateKey: string; body: Record<string, unknown>; impression: string | null; criticalCategory: string | null;
  } | null;
  /** 18-S RS8b — who is reading (the dock's words) and whether a prelim may be issued (STAT / ER only). */
  viewer?: { consultant: boolean; resident: boolean };
  prelimAllowed?: boolean;
  readingBy: WireReadingRow["readingBy"];
};

export type WirePreSignFinding = { code: string; level: "refuse" | "warn"; words: string };

export type WireSignerBlock = {
  userId: string; name: string; qualification: string; designation: string | null;
  councilRegNo: string; councilRegSource: string; doctorCode: string | null;
  signature: { method: string; secondFactorAt: string; keyId: string | null; contentSha256: string };
  /** 18-S RS8b — on a co-signed report: the resident who drafted it and signed it for co-sign. */
  draftedBy?: { userId: string; name: string; signedAt: string; reportId: string } | null;
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
}) => api<{ reportId: string; version: number; awaitingCosign?: boolean }>("POST", `/radiology/studies/${studyId}/reports/sign`, body);

/** 18-S RS8b — the consultant's co-signature on a resident's `awaiting_cosign` version (own second factor). */
export const cosignReading = (studyId: string, body: { reportId: string; acknowledgedWarnings?: string[] }) =>
  api<{ reportId: string; version: number; cosignedId: string }>("POST", `/radiology/studies/${studyId}/reports/cosign`, body);

/** 18-S RS8b — the PRELIM (ER/STAT): quotable by the ward, never published. First web caller of the route. */
export const savePrelim = (studyId: string, body: {
  templateKey?: string; body: Record<string, unknown>; impression?: string | null; laterality?: string | null;
}) => api<{ reportId: string; version: number }>("POST", `/radiology/studies/${studyId}/reports/prelim`, body);

/**
 * 18-S RS8b — the AMENDMENT: v(n+1) signed under the second factor, v(n) superseded; the server
 * re-publishes it (and tells the patient) when v(n) had been published. First web caller.
 */
export const amendReading = (studyId: string, body: {
  templateKey?: string; body: Record<string, unknown>; impression?: string | null; laterality?: string | null;
  reason: string; criticalCategory?: string | null; acknowledgedWarnings?: string[];
}) => api<{ reportId: string; version: number; supersededId: string }>("POST", `/radiology/studies/${studyId}/reports/amend`, body);

/** The amendment's reason codes (board: Amendments). The stored reason is "<code words>: <note>". */
export const AMEND_REASONS = ["addendum", "laterality", "measurement", "clinical_information", "other"] as const;
export type AmendReason = (typeof AMEND_REASONS)[number];

/* ── 18-S RS8b — the critical-call ladder ── */

export type CriticalRungKey = "treating_doctor" | "unit_head" | "duty_rmo" | "hod";
export const CRITICAL_RUNGS: readonly CriticalRungKey[] = ["treating_doctor", "unit_head", "duty_rmo", "hod"];

export type WireCriticalCall = {
  criticalId: string; reportId: string; studyId: string; accessionNo: string; studyTypeName: string;
  patientName: string; patientUhid: string; category: string; finding: string | null;
  flaggedAt: string; windowMin: number | null; dueAt: string | null; overdue: boolean; ladderRung: number;
  rungs: { key: CriticalRungKey; people: { userId: string; name: string }[]; source: "order" | "roster" | "role" | "none" }[];
  attempts: { rung: number; calledName: string | null; calledUserName: string | null; outcome: string; at: string; recordedByName: string | null }[];
  acknowledgedAt: string | null; acknowledgedByName: string | null; readBack: string | null;
};

export const fetchCriticalCalls = () =>
  api<{ open: WireCriticalCall[]; acknowledged: WireCriticalCall[] }>("GET", "/radiology/reading/criticals");

export const recordCriticalCall = (criticalId: string, body: {
  rung: number; calledUserId?: string | null; calledName?: string | null; outcome: "no_answer" | "answered";
}) => api<{ attemptId: string; ladderRung: number }>("POST", `/radiology/criticals/${criticalId}/calls`, body);

/** The read-back that closes the call (`read_back_mismatch` when it does not name the finding). */
export const closeCriticalCall = (criticalId: string, body: { acknowledgedByClinicianId: string; readBack: string }) =>
  api<{ criticalId: string; acknowledgedAt: string }>("POST", `/radiology/criticals/${criticalId}/acknowledge`, body);

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
