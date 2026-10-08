import type {
  ChartScalars, WireBenchRow, WireBenchState, WireDangerFlag, WireEscalationReading, WireEscalationState, WirePreStage,
  WireVisitOnBench, WireVitalKey, WireVitalsPostBody,
} from "./rules";
import type { GuardianRelation, WirePatientAbsent } from "./guardian";

/**
 * The server routes the vitals bay uses — the SAME ones the web bay calls (apps/web/src/lib/opd-api.ts
 * and patients-api.ts), each behind the permission the server already checks. Nothing here decides
 * anything: the bench, the band, the gates and the danger protocol are all the server's answers.
 */
export type Call = <T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) => Promise<T>;

export type WireEscalationView = {
  entryId: string; state: WireEscalationState; escalatedAt: string | null;
  escalatedFromClass: number | null; escalationBy: string | null; cancelMsRemaining: number;
};
export type WireVitalsGate = { key: WireVitalKey; kind: "slipped_digit" | "shrinking_adult" | "probe_error"; value: number; suggestion?: number; message: string };
/** Only what the phone reads off a saved chart: the flags, and whether the save waived the fee. */
export type WireVitalsSaveResult = { flags: WireDangerFlag[]; feeWaived?: boolean };
/** A saved chart, as far as a correction reads it: the scalars (glucose and its timing among them since 2026-10-08), the readings beside them, and what was carried. */
export type WireChart = ChartScalars & {
  id: string; recordedAt: string; recordedByName?: string; readings: unknown; contextChips: unknown; carriedForward?: string[];
  notes: string | null; emergency: boolean; status: "active" | "superseded";
};
export type WireQueueSummary = { waitingVitalsCount: number };
export type WireQrVerifyResult =
  | { ok: true; patient: { id: string; uhid: string; name: string } }
  | { ok: false; reason: "malformed" | "invalid_signature" | "stale_version" | "unknown_patient" };
export type WireAllergy = {
  id: string; substance: string; reaction: string | null;
  severity: "mild" | "moderate" | "severe" | null; status: "active" | "entered_in_error";
};
export type WireAllergenHit = { term: string; kind: "class" | "moiety"; allergenClass: string | null; saltId: string | null; blocks: string[] };

const enc = encodeURIComponent;

export function vitalsApi(call: Call) {
  return {
    bench: (serviceDate: string, doctorId?: string) =>
      call<{ items: WireBenchRow[] }>("GET", `/opd/bench?serviceDate=${serviceDate}${doctorId === undefined ? "" : `&doctorId=${enc(doctorId)}`}`),
    /** Why a typed or scanned visit number is not on today's bench (owner 2026-10-06). */
    locateVisit: (visitNo: string, serviceDate: string) =>
      call<WireVisitOnBench>("GET", `/opd/bench/locate?visitNo=${enc(visitNo)}&serviceDate=${serviceDate}`),
    summary: (serviceDate: string) => call<{ items: WireQueueSummary[] }>("GET", `/opd/queues/summary?serviceDate=${serviceDate}`),
    preStage: (encounterId: string) => call<WirePreStage>("GET", `/opd/visits/${enc(encounterId)}/prestage`),
    postVitals: (encounterId: string, body: WireVitalsPostBody) => call<WireVitalsSaveResult>("POST", `/opd/visits/${enc(encounterId)}/vitals`, body),
    escalation: (encounterId: string) => call<{ escalation: WireEscalationView | null }>("GET", `/opd/visits/${enc(encounterId)}/escalation`),
    demandRecheck: (encounterId: string, reading: WireEscalationReading) => call<WireEscalationView>("POST", `/opd/visits/${enc(encounterId)}/escalation/recheck`, reading),
    escalate: (encounterId: string, reading: WireEscalationReading) => call<WireEscalationView>("POST", `/opd/visits/${enc(encounterId)}/escalation/escalate`, reading),
    cancelEscalation: (encounterId: string) => call<WireEscalationView>("POST", `/opd/visits/${enc(encounterId)}/escalation/cancel`, {}),
    setBenchState: (encounterId: string, body: { state: WireBenchState | null; restMinutes?: number; note?: string }) =>
      call<WireBenchRow>("POST", `/opd/visits/${enc(encounterId)}/bench-state`, body),
    /** The saved chart a nurse may correct (`opd.vitals.record` — she who may amend may read). */
    chart: (vitalsId: string) => call<{ vitals: WireChart }>("GET", `/opd/vitals/${enc(vitalsId)}`),
    amend: (vitalsId: string, body: WireVitalsPostBody & { reason: string }) =>
      call<{ vitals: WireChart; flags: WireDangerFlag[]; superseded: string }>("POST", `/opd/vitals/${enc(vitalsId)}/amend`, body),
    verifyQr: (payload: string) => call<WireQrVerifyResult>("POST", "/patients/qr/verify", { payload }),
    allergies: (patientId: string) => call<{ items: WireAllergy[] }>("GET", `/patients/${enc(patientId)}/allergies`),
    addAllergy: (patientId: string, body: {
      substance: string; reaction?: string; severity: "mild" | "moderate" | "severe"; source: "vitals";
      saltId?: string | null; allergenClass?: string | null;
    }) => call<unknown>("POST", `/patients/${enc(patientId)}/allergies`, body),
    /** Owner 2026-10-07 — a revisit whose guardian came with the reports skips the bay (`opd/patient-absent.ts`). */
    markPatientAbsent: (encounterId: string, body: { relation: GuardianRelation; name?: string | null }) =>
      call<{ patientAbsent: WirePatientAbsent; alreadyMarked: boolean }>("POST", `/opd/visits/${enc(encounterId)}/patient-absent`, body),
    completeAllergen: (q: string) => call<{ items: WireAllergenHit[]; known: boolean }>("GET", `/opd/cds/complete/allergen?q=${enc(q)}`),
  };
}
export type VitalsApi = ReturnType<typeof vitalsApi>;

/** The server's own sentence for a refusal, else its code — never an empty banner. */
export function refusalText(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object") {
    const b = body as { message?: unknown; code?: unknown };
    if (typeof b.message === "string" && b.message !== "") return b.message;
    if (Array.isArray(b.message)) {
      return b.message.map((i) => (typeof i === "object" && i !== null && "message" in i ? String((i as { message: unknown }).message) : String(i))).join("; ");
    }
    if (typeof b.code === "string" && b.code !== "") return b.code;
  }
  return fallback;
}
