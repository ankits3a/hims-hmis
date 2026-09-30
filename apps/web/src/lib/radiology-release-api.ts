import { api } from "./api";

/**
 * PLAN 18-S RS9 — the wire contract of `radiology-release.controller.ts`, transcribed (the
 * `radiology-api.ts` rule: this file describes what the routes ship and decides nothing).
 */

export const ACTED_OUTCOMES = ["changed_treatment", "referred", "followup_booked", "discussed_with_patient", "no_change"] as const;
export type ActedOutcome = (typeof ACTED_OUTCOMES)[number];

export type WireInboxRow = {
  reportId: string;
  studyId: string;
  accessionNo: string;
  studyName: string;
  studyTypeCode: string;
  patientId: string;
  patientName: string;
  uhid: string;
  version: number;
  amended: boolean;
  signedAt: string;
  publishedAt: string;
  signerName: string | null;
  impression: string | null;
  criticalCategory: string | null;
  critical: { criticalId: string; category: string; raisedAt: string; acknowledgedAt: string | null; readBack: string | null } | null;
  state: "unread" | "read" | "acted";
  firstReadAt: string | null;
  chasedAt: string | null;
  acted: { at: string; outcome: string; note: string } | null;
  orderedByMe: boolean;
  /** 18-S RS8c — the morning over-read of a night partner's prelim on this study (absent from older servers). */
  overread?: { grade: string; providerName: string } | null;
};

export const fetchImagingResults = () => api<{ rows: WireInboxRow[] }>("GET", "/radiology/results");
export const markReportActed = (reportId: string, body: { outcome: ActedOutcome; note: string }) =>
  api<{ reportId: string; actedAt: string; outcome: string }>("POST", `/radiology/reports/${reportId}/acted`, body);
export const readBackCritical = (reportId: string, readBack: string) =>
  api<{ criticalId: string; acknowledgedAt: string }>("POST", `/radiology/reports/${reportId}/read-back`, { readBack });

export const COLLECTOR_KINDS = ["patient", "relative", "ward_staff", "courier"] as const;
export type CollectorKind = (typeof COLLECTOR_KINDS)[number];
export const COLLECTOR_ID_TYPES = ["aadhaar", "voter_id", "driving_licence", "pan", "passport", "other"] as const;

export type ReleaseNeed =
  | "abnormal_uncollected" | "amended_after_handover" | "held_for_dues" | "media_to_print" | "media_to_hand" | "notice_not_sent" | "not_collected";

/** 18-S RS9b — the owner's answer to "release this held copy unpaid" (`held.ts` HoldRelease). */
export type WireHoldRelease =
  | { state: "none" }
  | { state: "pending"; approvalId: string; askedAt: string }
  | { state: "granted"; approvalId: string; decidedAt: string | null }
  | { state: "refused"; approvalId: string; decidedAt: string | null; note: string | null };

export type WireReleaseRow = {
  studyId: string;
  reportId: string;
  version: number;
  accessionNo: string;
  studyName: string;
  modality: string;
  patientId: string;
  patientName: string;
  uhid: string;
  publishedAt: string;
  criticalCategory: string | null;
  bedsideLocation: string | null;
  /** 18-S RS9b — the PATIENT's copy held for dues (self-pay, bill unsettled); null when nothing holds it. */
  hold: { outstandingPaise: number; invoiceNo: string; release: WireHoldRelease } | null;
  doctor: "unread" | "read" | "acted" | "none";
  notice: string | null;
  filmIncluded: boolean;
  handovers: {
    handoverId: string; reportId: string; version: number; collectorKind: string; collectorName: string | null;
    collectorRelation: string | null; filmSheets: number; cd: boolean; handedAt: string;
  }[];
  media: {
    requestId: string; kind: string; quantity: number; included: boolean; requestedAt: string;
    printedAt: string | null; handedOver: boolean; serviceCode: string | null;
  }[];
  needs: ReleaseNeed[];
};

export type HandoverBody = {
  collectorKind: CollectorKind;
  collectorName?: string | null;
  collectorRelation?: string | null;
  collectorIdType?: string | null;
  collectorIdLast4?: string | null;
  mediaRequestIds?: string[];
  note?: string | null;
};

export const fetchReleaseRegister = () => api<{ rows: WireReleaseRow[] }>("GET", "/radiology/release");
export const requestImagingMedia = (studyId: string, body: { kind: "film" | "cd"; quantity?: number }) =>
  api<{ requestIds: string[]; included: boolean }>("POST", `/radiology/studies/${studyId}/media`, body);
export const markMediaPrinted = (requestId: string) =>
  api<{ requestId: string; printedAt: string }>("POST", `/radiology/media/${requestId}/printed`);
export const handOverReport = (reportId: string, body: HandoverBody) =>
  api<{ handoverId: string; filmSheets: number; cd: boolean }>("POST", `/radiology/reports/${reportId}/handover`, body);
/** 18-S RS9b — the desk ASKS the owner to release a held copy unpaid; the owner decides in the approvals inbox. */
export const askUnpaidRelease = (reportId: string, reason: string) =>
  api<{ approvalId: string; status: "pending" | "granted"; outstandingPaise: number }>(
    "POST", `/radiology/reports/${reportId}/release-unpaid`, { reason },
  );
