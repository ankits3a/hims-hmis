import { api } from "./api";

/**
 * PLAN 18-S RS8c — the reading room, part 3: follow-ups, peer review, night & outside reads.
 * Transcribed from `radiology-reading-room.controller.ts`. It describes what the server ships and
 * decides nothing — every refusal is the server's words.
 */

export const FOLLOWUP_CHANNELS = ["letter", "phone", "in_person"] as const;
export type FollowupChannel = (typeof FOLLOWUP_CHANNELS)[number];
/** The five a person may choose (`withdrawn_by_amendment` is the amendment's own). */
export const FOLLOWUP_CLOSE_REASONS = ["done_here", "done_elsewhere", "clinician_declines", "patient_declines", "patient_died"] as const;
export type FollowupCloseReason = (typeof FOLLOWUP_CLOSE_REASONS)[number];

export type WireFollowup = {
  followupId: string; studyId: string; accessionNo: string; studyName: string;
  patientId: string; patientName: string; uhid: string;
  source: "birads" | "tirads" | "lirads" | "lungrads" | "fleischner" | "other";
  recommendation: string; intervalLabel: string; dueOn: string;
  state: "open" | "notified" | "booked" | "closed";
  overdue: boolean; signedAt: string | null; treatingDoctor: string | null;
  notified: { at: string; channel: string; by: string | null; note: string | null } | null;
  booked: { orderNo: string; at: string } | null;
  closed: { at: string; reason: string; note: string | null } | null;
};

export type WireFollowupBoard = {
  rows: WireFollowup[];
  tiles: { open: number; overdue: number; notActed: number; closedOnTime90: number | null; recommendedThisMonth: number };
};

export const fetchFollowups = () => api<WireFollowupBoard>("GET", "/radiology/reading/followups");
export const markFollowupNotified = (id: string, body: { channel: FollowupChannel; note?: string | null }) =>
  api<{ followupId: string }>("POST", `/radiology/followups/${id}/notified`, body);
export const closeFollowup = (id: string, body: { reason: FollowupCloseReason; note: string }) =>
  api<{ followupId: string }>("POST", `/radiology/followups/${id}/close`, body);
export const bookFollowup = (id: string, body: { encounterNo?: string | null; serviceId?: string | null } = {}) =>
  api<{ followupId: string; orderId: string; orderNo: string }>("POST", `/radiology/followups/${id}/book`, body);
/** RS9's inbox: the treating doctor's follow-ups still to book. */
export const fetchMyFollowups = () => api<{ rows: WireFollowup[] }>("GET", "/radiology/results/followups");

export const PEER_SCORES = ["1", "2a", "2b", "3a", "3b", "4a", "4b"] as const;
export type PeerScore = (typeof PEER_SCORES)[number];

export type WirePeerBoard = {
  queue: { reviewId: string; trigger: string; studyTypeName: string; modality: string; signedAt: string | null; openedAt: string; ageDays: number }[];
  recent: { reviewId: string; trigger: string; studyTypeName: string; modality: string; score: string; learningCase: boolean; note: string | null; scoredAt: string }[];
  readers: { readerId: string; readerName: string; scored: number; concur: number; minor: number; significant: number; agreementPct: number | null }[];
  tiles: { sampledThisMonth: number; triggeredThisMonth: number; agreementPct: number | null; significantThisMonth: number; overdue: number };
};

export type WirePeerCase = {
  reviewId: string; trigger: string; studyId: string; studyTypeName: string; modality: string;
  patientAgeSex: string; indication: string | null; sections: Record<string, string>;
  impression: string | null; coded: Record<string, unknown>; signedAt: string | null; prelim: boolean;
};

export const fetchPeerBoard = () => api<WirePeerBoard>("GET", "/radiology/reading/peer");
export const fetchPeerCase = (id: string) => api<{ case: WirePeerCase }>("GET", `/radiology/reading/peer/${id}`);
export const scorePeerCase = (id: string, body: { score: PeerScore; learningCase?: boolean; note?: string | null }) =>
  api<{ reviewId: string }>("POST", `/radiology/reading/peer/${id}/score`, body);

export type WireTeleRow = {
  teleReadId: string; studyId: string; accessionNo: string; patientName: string; uhid: string; studyName: string;
  priority: string; providerName: string; readerName: string; readerNmcNo: string;
  prelimAt: string; imagesAt: string | null; tatMinutes: number | null; targetMinutes: number | null; late: boolean;
  prelim: { findings: string | null; impression: string | null };
  state: "awaiting" | "concur" | "minor" | "major";
  overread: { at: string; by: string | null; note: string | null } | null;
};

export type WireTeleBoard = {
  configured: boolean;
  coverage: { nightFrom: string; nightTo: string; overreadBy: string; prelimMinutes: { stat: number; urgent: number } } | null;
  providers: { key: string; name: string; dpaSignedOn: string; readers: number }[];
  queue: WireTeleRow[];
  log: WireTeleRow[];
  outside: { studyId: string; accessionNo: string; patientName: string; studyName: string; centreName: string; studyDate: string; state: string }[];
  summary: { prelims30: number; medianTat30: number | null; late30: number; minor30: number; major30: number; awaiting: number };
};

export type OverreadGrade = "concur" | "minor" | "major";

export const fetchTeleBoard = () => api<WireTeleBoard>("GET", "/radiology/reading/tele");
export const overreadNightRead = (id: string, body: {
  grade: OverreadGrade; note?: string | null; findings?: string | null; impression?: string | null; acknowledgedWarnings?: string[];
}) => api<{ teleReadId: string; grade: OverreadGrade; finalReportId: string }>("POST", `/radiology/tele/${id}/overread`, body);
