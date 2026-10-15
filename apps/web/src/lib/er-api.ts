import { ApiError, api } from "./api";
import type { ErBay, ErBoard, ErCareView, ErDeskView, ErDoctorOption, ErEpisodeView, ErItemOption, ErPatientHit, ErRefusalBody } from "@hmis/contracts";

/* ═══ ER lane 1 (#808) — `apps/core/src/modules/emergency/emergency.controller.ts`. The paths are the contract's
 * `ER_ROUTES` and the topic its `ER_BOARD_TOPIC`, copied: the web bundle imports the contract package for TYPES only. ═══ */
const ER_ROUTES = {
  board: "/er/board",
  boardWall: "/er/board/wall",
  desk: "/er/desk",
  patients: "/er/patients",
  doctors: "/er/doctors",
  preAlerts: "/er/pre-alerts",
  cancelPreAlert: "/er/pre-alerts/cancel",
  arrivals: "/er/arrivals",
  unidentified: "/er/arrivals/unidentified",
  broughtDead: "/er/arrivals/brought-dead",
  printBand: "/er/bands/print",
  reprintBand: "/er/bands/reprint",
  linkIdentity: "/er/identity/link",
  // lane 2 (#809)
  triage: "/er/triage",
  reTriage: "/er/triage/again",
  vitals: "/er/vitals",
  placeInBay: "/er/bays/place",
  moveBay: "/er/bays/move",
  assignDoctor: "/er/doctor",
  bays: "/er/bays",
  episode: "/er/episodes",
  triageDoctors: "/er/triage-doctors",
  // lane 3 (#810)
  care: "/er/care",
  notes: "/er/notes",
  cosign: "/er/notes/cosign",
  orders: "/er/orders",
  items: "/er/items",
  issue: "/er/meds/issue",
  dose: "/er/meds/dose",
  returnMed: "/er/meds/return",
  signVerbal: "/er/meds/sign-verbal",
  procedures: "/er/procedures",
  consents: "/er/consents",
  calls: "/er/calls",
  answerCall: "/er/calls/answer",
  stabilised: "/er/stabilised",
} as const;
export const ER_BOARD_TOPIC = "er:board";
export const ER_WALL_TOPIC = "erwall:board";

/** The contract's value lists, copied for the same reason (`packages/contracts/src/emergency/common.ts`). */
export const ER_SEXES = ["male", "female", "other", "unknown"] as const;
export const ER_AGE_BANDS = ["infant", "child", "teen", "young_adult", "adult", "elderly"] as const;
export const ER_ARRIVAL_MODES = ["walk_in", "private_vehicle", "ambulance_108", "own_ambulance", "police", "referred_in", "inter_facility"] as const;
export const ER_PRE_ALERT_MODES = ["ambulance_108", "own_ambulance", "police", "referred_in", "inter_facility"] as const;
/** Lane 2 (#809) — the contract's ESI table (`packages/contracts/src/emergency/triage.ts`), copied. */
export const ER_ESI = {
  1: { colour: "red", retriageMin: null, doctorWithinMin: 0 },
  2: { colour: "orange", retriageMin: 15, doctorWithinMin: 10 },
  3: { colour: "yellow", retriageMin: 30, doctorWithinMin: 30 },
  4: { colour: "green", retriageMin: 60, doctorWithinMin: 60 },
  5: { colour: "blue", retriageMin: 120, doctorWithinMin: 120 },
} as const;
export type EsiLevel = 1 | 2 | 3 | 4 | 5;
export type EsiDecision = { lifeSaving: boolean; highRisk: boolean; resources: "none" | "one" | "many"; dangerVitals: boolean };
/** The ESI v4 algorithm — the contract's `esiAlgorithm`, copied (the server re-computes it; this is the proposal shown). */
export function esiProposal(d: EsiDecision): { level: EsiLevel; reasonKey: string } {
  if (d.lifeSaving) return { level: 1, reasonKey: "lifeSaving" };
  if (d.highRisk) return { level: 2, reasonKey: "highRisk" };
  if (d.resources === "many") return d.dangerVitals ? { level: 2, reasonKey: "manyDanger" } : { level: 3, reasonKey: "many" };
  if (d.resources === "one") return { level: 4, reasonKey: "one" };
  return { level: 5, reasonKey: "none" };
}
export const ER_DOOR_TO_TRIAGE_MINUTES = 5;
export type ErSexValue = (typeof ER_SEXES)[number];
export type ErAgeBandValue = (typeof ER_AGE_BANDS)[number];
export type ErArrivalModeValue = (typeof ER_ARRIVAL_MODES)[number];

export type BandOut = {
  bandId: string; bandSerial: string; printedAt: string;
  band: {
    name: string; nameHi: string | null; uhid: string; ageSex: string; episodeNo: string; arrivedOn: string;
    allergyWords: string[]; alertWords: string[]; size: string; site: string; barcode: string; qr: string;
  };
};
export type ArrivalOut = {
  episodeId: string; episodeNo: string; patientId: string; uhid: string; state: "arrived"; arrivedAt: string;
  registeredAt: string; returnedWithin24h: boolean; band: BandOut; alias?: string; aliasHi?: string;
};

/** A uuid per act: a retried request on a bad network records once (spec §6 edge 8). */
export const newKey = (): string => crypto.randomUUID();

// ER review (2026-10-15) — the wall display reads its own route (`er.board.wall`; a kiosk holds only that).
export const fetchErBoard = (wall: boolean) => api<ErBoard>("GET", wall ? ER_ROUTES.boardWall : ER_ROUTES.board);
export const fetchErDesk = () => api<ErDeskView>("GET", ER_ROUTES.desk);
export const searchErPatients = (q: string) => api<ErPatientHit[]>("GET", `${ER_ROUTES.patients}?q=${encodeURIComponent(q)}`);
export const fetchErDoctors = () => api<ErDoctorOption[]>("GET", ER_ROUTES.doctors);
export const preAlertApi = (body: Record<string, unknown>) => api<{ preAlertId: string }>("POST", ER_ROUTES.preAlerts, { idempotencyKey: newKey(), ...body });
export const cancelPreAlertApi = (preAlertId: string, reason: string) =>
  api<{ preAlertId: string }>("POST", ER_ROUTES.cancelPreAlert, { idempotencyKey: newKey(), preAlertId, reason });
export const registerArrivalApi = (body: Record<string, unknown>, idempotencyKey: string) =>
  api<ArrivalOut>("POST", ER_ROUTES.arrivals, { idempotencyKey, ...body });
export const registerUnidentifiedApi = (body: Record<string, unknown>, idempotencyKey: string) =>
  api<ArrivalOut>("POST", ER_ROUTES.unidentified, { idempotencyKey, ...body });
export const broughtDeadApi = (body: Record<string, unknown>, idempotencyKey: string) =>
  api<{ episodeId: string; episodeNo: string; uhid: string; alias: string | null }>("POST", ER_ROUTES.broughtDead, { idempotencyKey, ...body });
export const printBandApi = (episodeId: string) => api<BandOut>("POST", ER_ROUTES.printBand, { idempotencyKey: newKey(), episodeId, site: "wrist" });
export const reprintBandApi = (episodeId: string, reason: string) =>
  api<BandOut>("POST", ER_ROUTES.reprintBand, { idempotencyKey: newKey(), episodeId, reason });
export const linkIdentityApi = (body: { episodeId: string; truePatientId: string; how: string; note: string }) =>
  api<{ mergeRequestId: string }>("POST", ER_ROUTES.linkIdentity, { idempotencyKey: newKey(), ...body });

export function erRefusalOf(e: unknown): ErRefusalBody | null {
  if (!(e instanceof ApiError) || e.body === null || typeof e.body !== "object") return null;
  const b = e.body as Partial<ErRefusalBody>;
  return typeof b.rule === "string" && typeof b.code === "string" ? (b as ErRefusalBody) : null;
}

/** Whole minutes from `iso` to `now` (negative = in the future). */
export function minutesSince(iso: string, now: number): number {
  return Math.floor((now - new Date(iso).getTime()) / 60_000);
}

/* ═══ lane 2 (#809) — triage, vitals, bays, the ER doctor ═══ */
export type TriageOut = {
  episodeId: string; level: EsiLevel; algorithmLevel: EsiLevel | null; downTriage: boolean; retriageDueAt: string | null;
  doctorDueAt: string; ews: { kind: string; value: number; band: string } | null;
  take: { departmentCode: string; teamId: string | null; source: string } | null;
};
export const fetchErEpisode = (id: string) => api<ErEpisodeView>("GET", `${ER_ROUTES.episode}/${encodeURIComponent(id)}`);
export const fetchErBays = () => api<ErBay[]>("GET", ER_ROUTES.bays);
export const fetchTriageDoctors = () => api<ErDoctorOption[]>("GET", ER_ROUTES.triageDoctors);
export const triageApi = (body: Record<string, unknown>, idempotencyKey: string) => api<TriageOut>("POST", ER_ROUTES.triage, { idempotencyKey, ...body });
export const reTriageApi = (body: Record<string, unknown>, idempotencyKey: string) => api<TriageOut>("POST", ER_ROUTES.reTriage, { idempotencyKey, ...body });
export const vitalsApi = (body: Record<string, unknown>) => api<{ worse: boolean }>("POST", ER_ROUTES.vitals, { idempotencyKey: newKey(), ...body });
export const placeInBayApi = (episodeId: string, bedId: string) => api<{ bayCode: string }>("POST", ER_ROUTES.placeInBay, { idempotencyKey: newKey(), episodeId, bedId });
export const moveBayApi = (episodeId: string, bedId: string) => api<{ bayCode: string }>("POST", ER_ROUTES.moveBay, { idempotencyKey: newKey(), episodeId, bedId });
export const assignDoctorApi = (episodeId: string, doctorId: string) => api<{ state: string }>("POST", ER_ROUTES.assignDoctor, { idempotencyKey: newKey(), episodeId, doctorId });

/* ═══ lane 3 (#810) — care ═══ */
export const ER_MED_ROUTES = ["iv", "im", "sc", "oral", "neb", "sl", "pr", "topical", "inhaled", "other"] as const;
export const fetchErCare = (episodeId: string) => api<ErCareView>("GET", `${ER_ROUTES.care}/${encodeURIComponent(episodeId)}`);
export const fetchErItems = (q: string) => api<ErItemOption[]>("GET", `${ER_ROUTES.items}?q=${encodeURIComponent(q)}`);
const post = <T>(path: string, body: Record<string, unknown>) => api<T>("POST", path, { idempotencyKey: newKey(), ...body });
export const noteApi = (body: Record<string, unknown>) => post<{ status: string }>(ER_ROUTES.notes, body);
export const cosignApi = (noteId: string) => post<{ status: string }>(ER_ROUTES.cosign, { noteId });
export type ErOrderOut = { labOrderId: string | null; imagingOrderId: string | null; skipped: { department: string; code: string; message: string }[]; duplicates: string[] };
export const orderApi = (body: Record<string, unknown>) => post<ErOrderOut>(ER_ROUTES.orders, body);
export const issueApi = (body: Record<string, unknown>) => post<{ issueId: string; highAlert: boolean; labelLines: string[] }>(ER_ROUTES.issue, body);
export const doseApi = (body: Record<string, unknown>) => post<{ outcome: string }>(ER_ROUTES.dose, body);
/** ER review 2 — a medicine not given: back to stock unopened, or wastage (a witness for high-alert / controlled). */
export const returnMedApi = (body: Record<string, unknown>) => post<{ kind: "returned" | "wasted" }>(ER_ROUTES.returnMed, body);
export const signVerbalApi = (issueId: string) => post<{ signedAt: string }>(ER_ROUTES.signVerbal, { issueId });
export const procedureApi = (body: Record<string, unknown>) => post<{ procedureId: string }>(ER_ROUTES.procedures, body);
export const consentApi = (body: Record<string, unknown>) => post<{ consentId: string }>(ER_ROUTES.consents, body);
export const callApi = (body: Record<string, unknown>) => post<{ callId: string; callees: { name: string }[] }>(ER_ROUTES.calls, body);
export const answerCallApi = (callId: string, step: "answered" | "seen") => post<{ callId: string }>(ER_ROUTES.answerCall, { callId, step });
export const stabilisedApi = (episodeId: string, note?: string) => post<{ stabilisedAt: string }>(ER_ROUTES.stabilised, { episodeId, ...(note ? { note } : {}) });
