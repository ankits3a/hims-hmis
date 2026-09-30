import { api } from "./api";

/**
 * PLAN 18-S RS12 — the PACS inbox's wire contract, transcribed from `radiology-pacs.controller.ts`
 * (`pacs.ts` `pacsInbox`, `attachUnmatched`, `rejectUnmatched`). Nothing here matches anything: the
 * accession + UHID rule is the server's, and a refusal is shown in the server's words.
 */

export const UNMATCHED_REASONS = [
  "no_match", "patient_mismatch", "uid_mismatch", "awaiting_acquisition", "study_closed", "outside_study", "no_identifiers",
] as const;
export type UnmatchedReason = (typeof UNMATCHED_REASONS)[number];

export type WireInboxRow = {
  id: string; studyInstanceUid: string; accessionNumber: string | null; dicomPatientId: string | null;
  dicomPatientName: string | null; modality: string | null; studyDate: string | null; seriesCount: number;
  instanceCount: number; reason: UnmatchedReason; receivedAt: string; lastSeenAt: string;
  candidate: {
    studyId: string; accessionNo: string; patientName: string; uhid: string; studyTypeCode: string;
    status: string; imageSource: string | null;
  } | null;
};

export type WireDoseConflict = {
  id: string; studyId: string | null; accessionNo: string | null; template: string;
  conflict: Record<string, { typed: number; sr: number }>; receivedAt: string;
};

export type WirePacsInbox = {
  configured: boolean; lastArrivalAt: string | null; unmatched: WireInboxRow[]; doseConflicts: WireDoseConflict[];
  doseUnmatched: number;
};

export const fetchPacsInbox = () => api<WirePacsInbox>("GET", "/radiology/pacs/inbox");

export const attachUnmatched = (id: string, accessionNo: string, reason: string) =>
  api<{ studyId: string; accessionNo: string }>("POST", `/radiology/pacs/unmatched/${encodeURIComponent(id)}/attach`, { accessionNo, reason });

export const rejectUnmatched = (id: string, reason: string) =>
  api<{ unmatchedId: string }>("POST", `/radiology/pacs/unmatched/${encodeURIComponent(id)}/reject`, { reason });

/** DICOM PN `DEVI^ASHA` → "ASHA DEVI" — how a reconciler reads the name the modality typed. */
export function dicomName(pn: string | null): string {
  if (pn === null || pn.trim() === "") return "";
  const [family = "", given = "", middle = ""] = pn.split("=")[0]!.split("^");
  return [given, middle, family].filter((p) => p.trim() !== "").join(" ").trim();
}
