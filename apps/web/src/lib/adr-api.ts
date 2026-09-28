import { api } from "./api";
import type { WireRenderedDocument } from "./print-api";

/**
 * PHARMACY STAGE D1 — the adverse drug reaction register, transcribed from `pharmacy/adr.ts`. Record:
 * `pharmacy.adr.record`; causality, sent to PvPI, closed: `pharmacy.adr.manage`; reads need either.
 */
export const ADR_SERIOUSNESS = [
  "death", "life_threatening", "hospitalisation", "disability", "congenital_anomaly", "other_medically_important", "not_serious",
] as const;
export type AdrSeriousness = (typeof ADR_SERIOUSNESS)[number];
export const ADR_OUTCOMES = ["recovered", "recovering", "not_recovered", "fatal", "unknown"] as const;
export type AdrOutcome = (typeof ADR_OUTCOMES)[number];
export const ADR_CHALLENGE = ["yes", "no", "unknown", "na"] as const;
export type AdrChallenge = (typeof ADR_CHALLENGE)[number];
export const ADR_CAUSALITY = ["certain", "probable", "possible", "unlikely", "conditional", "unclassifiable"] as const;
export type AdrCausality = (typeof ADR_CAUSALITY)[number];
export const ADR_CHANNELS = ["amc", "pvpi_app", "email"] as const;
export type AdrChannel = (typeof ADR_CHANNELS)[number];

export const ADR_RECORD = "pharmacy.adr.record";
export const ADR_MANAGE = "pharmacy.adr.manage";

export type WireAdrPatient = { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean; gender: string; dob: string | null };
export type WireAdrState = { causality: string | null; sentOn: string | null; channel: string | null; pvpiRef: string | null; closed: boolean };

export type WireAdrRow = {
  id: string; no: string; patient: WireAdrPatient | null; onsetDate: string; seriousness: string; outcome: string;
  suspects: string[]; reportedByCode: string; createdAt: string; state: WireAdrState;
};

export type WireAdrSuspect = {
  position: number; saltId: string | null; name: string; itemId: string | null; batchNo: string | null; manufacturer: string | null;
  dose: string | null; route: string | null; frequency: string | null; indication: string | null;
  startDate: string | null; stopDate: string | null; dispenseId: string | null; allergyId: string;
};

export type WireAdrEvent = {
  id: string; kind: "causality_assessed" | "sent_to_pvpi" | "closed"; causality: string | null; sentOn: string | null; channel: string | null;
  pvpiRef: string | null; note: string | null; recordedBy: string; recordedByCode: string; recordedAt: string;
};

export type WireAdrConcomitant = { name: string; dose: string | null; route: string | null; startDate: string | null; stopDate: string | null; indication: string | null };

export type WireAdrDetail = WireAdrRow & {
  reaction: string; recoveryDate: string | null; dechallenge: string; rechallenge: string; weightKg: string | null;
  concomitants: WireAdrConcomitant[]; relevantTests: string | null; relevantHistory: string | null;
  suspectLines: WireAdrSuspect[]; events: WireAdrEvent[];
};

export type AdrSuspectBody = {
  saltId?: string | null; name?: string | null; batchNo?: string | null; manufacturer?: string | null; dose?: string | null;
  route?: string | null; frequency?: string | null; indication?: string | null; startDate?: string | null; stopDate?: string | null;
};

export type RecordAdrBody = {
  patientId: string; reaction: string; onsetDate: string; recoveryDate?: string | null;
  seriousness: AdrSeriousness; outcome: AdrOutcome; dechallenge: AdrChallenge; rechallenge: AdrChallenge;
  weightKg?: number | null; suspects: AdrSuspectBody[];
  concomitants?: { name: string; dose?: string | null; route?: string | null; startDate?: string | null; stopDate?: string | null; indication?: string | null }[];
  relevantTests?: string | null; relevantHistory?: string | null;
};

export type AdrEventBody =
  | { kind: "causality_assessed"; causality: AdrCausality; note?: string | null }
  | { kind: "sent_to_pvpi"; sentOn: string; channel: AdrChannel; pvpiRef?: string | null; note?: string | null }
  | { kind: "closed"; note?: string | null };

export const fetchAdrList = (open = false): Promise<{ items: WireAdrRow[] }> => api("GET", `/pharmacy/adr${open ? "?open=true" : ""}`);
export const fetchAdr = (id: string): Promise<WireAdrDetail> => api("GET", `/pharmacy/adr/${encodeURIComponent(id)}`);
export const fetchAdrDocument = (id: string): Promise<WireRenderedDocument> => api("GET", `/pharmacy/adr/${encodeURIComponent(id)}/document`);
export const suggestAdrSalts = (q: string): Promise<{ items: { id: string; name: string }[] }> => api("GET", `/pharmacy/adr/salts?q=${encodeURIComponent(q)}`);
export const recordAdr = (body: RecordAdrBody, idempotencyKey: string): Promise<{ reportId: string; no: string; allergyIds: string[] }> =>
  api("POST", "/pharmacy/adr", body, idempotencyKey);
export const addAdrEvent = (id: string, body: AdrEventBody): Promise<{ eventId: string }> => api("POST", `/pharmacy/adr/${encodeURIComponent(id)}/events`, body);

export const isSerious = (s: string): boolean => s !== "not_serious";
