import { api } from "./api";
import { toCsv } from "./payables-api";

/**
 * PHARMACY STAGE D2 — the medication error and near-miss log, transcribed from `pharmacy/incidents.ts`.
 * Record: `pharmacy.incidents.record`; review and close: `pharmacy.incidents.review`; reads need either.
 *
 * BLAME-FREE: the server decides who is told the reporter's name (`reporter.name` is null for everyone but
 * a reviewer). The web never shows a name the server did not send, and the export never shows one at all.
 */
export const MED_INCIDENT_KINDS = ["near_miss", "error"] as const;
export type MedIncidentKind = (typeof MED_INCIDENT_KINDS)[number];
export const MED_INCIDENT_STAGES = ["prescribing", "transcribing", "dispensing", "administration", "monitoring"] as const;
export type MedIncidentStage = (typeof MED_INCIDENT_STAGES)[number];
export const MED_INCIDENT_TYPES = [
  "wrong_drug", "wrong_strength", "wrong_dose", "wrong_quantity", "wrong_patient", "wrong_route", "expired", "lasa_mixup", "omission", "other",
] as const;
export type MedIncidentType = (typeof MED_INCIDENT_TYPES)[number];
export const NCC_MERP_CATEGORIES = ["A", "B", "C", "D", "E", "F", "G", "H", "I"] as const;
export type NccMerpCategory = (typeof NCC_MERP_CATEGORIES)[number];
export const MED_INCIDENT_FACTORS = ["lasa", "look_alike_packaging", "illegible_rx", "workload", "interruption", "other"] as const;
export type MedIncidentFactor = (typeof MED_INCIDENT_FACTORS)[number];

export const INCIDENT_RECORD = "pharmacy.incidents.record";
export const INCIDENT_REVIEW = "pharmacy.incidents.review";

/** NCC MERP: A–B did not reach the patient. */
export const kindOfCategory = (c: string): MedIncidentKind => (c === "A" || c === "B" ? "near_miss" : "error");
export const isHarmCategory = (c: string): boolean => c >= "E" && c <= "I";
export const categoriesOf = (k: MedIncidentKind): readonly NccMerpCategory[] => NCC_MERP_CATEGORIES.filter((c) => kindOfCategory(c) === k);

export type WireIncidentPatient = { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean };
export type WireIncidentReporter = { role: string; roleTitle: string; name: string | null };
export type WireIncidentEvent = {
  id: string; kind: "reviewed" | "closed"; rootCause: string | null; actionTaken: string | null; note: string | null; recordedByName: string | null; recordedAt: string;
};
export type WireIncidentState = { reviewed: boolean; rootCause: string | null; actionTaken: string | null; closed: boolean };
export type WireIncident = {
  id: string; no: string; kind: MedIncidentKind; stage: string; type: string; category: string; factors: string[];
  patient: WireIncidentPatient | null; item: { id: string; name: string } | null; dispenseNo: string | null; lineIdx: number | null;
  whatHappened: string; reporter: WireIncidentReporter; createdAt: string; state: WireIncidentState; events: WireIncidentEvent[];
};
export type WireIncidentMonth = {
  month: string; errors: number; nearMisses: number; dispensedLines: number; counterLines: number; walkInLines: number; errorsPer1000: number | null;
};

export type RecordIncidentBody = {
  kind: MedIncidentKind; stage: MedIncidentStage; type: MedIncidentType; category: NccMerpCategory;
  patientId?: string | null; dispenseLine?: { dispenseId: string; lineIdx: number } | null; itemId?: string | null;
  factors?: MedIncidentFactor[]; whatHappened: string;
};
export type IncidentEventBody =
  | { kind: "reviewed"; rootCause: string; actionTaken: string; note?: string | null }
  | { kind: "closed"; note?: string | null };

export const fetchIncidents = (): Promise<{ items: WireIncident[] }> => api("GET", "/pharmacy/incidents");
export const fetchIncidentIndicator = (months = 6): Promise<{ months: WireIncidentMonth[] }> => api("GET", `/pharmacy/incidents/indicator?months=${String(months)}`);
export const recordIncident = (body: RecordIncidentBody, idempotencyKey: string): Promise<{ incidentId: string; no: string }> =>
  api("POST", "/pharmacy/incidents", body, idempotencyKey);
export const addIncidentEvent = (id: string, body: IncidentEventBody): Promise<{ eventId: string }> =>
  api("POST", `/pharmacy/incidents/${encodeURIComponent(id)}/events`, body);

/**
 * The log as CSV for the quality committee. It carries the reporter's ROLE, never the name — whoever exports
 * it, a reviewer included: an export leaves the building, and a blame-free log that exports names is not one.
 * No patient either: the committee reads patterns, not people.
 */
export function incidentsCsv(rows: readonly WireIncident[]): string {
  const head = ["no", "recorded_at", "kind", "category", "stage", "type", "factors", "item", "reporter_role", "reviewed", "root_cause", "action_taken", "closed"];
  return toCsv(head, rows.map((r) => [
    r.no, r.createdAt, r.kind, r.category, r.stage, r.type, r.factors.join(";"), r.item?.name ?? "", r.reporter.roleTitle,
    r.state.reviewed ? "yes" : "no", r.state.rootCause ?? "", r.state.actionTaken ?? "", r.state.closed ? "yes" : "no",
  ]));
}
