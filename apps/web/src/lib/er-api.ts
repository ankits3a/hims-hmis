import { ApiError, api } from "./api";
import type {
  ErDraft, ErDraftKind, ErEsiProposal, ErEsiProposalCheck, ErSinceArrival, ErWaitingDisplay,
  ErBay, ErBill, ErBillDesk, ErBoard, ErCodeView, ErCodes, ErMciBoard, ErMciCount, ErMciPack, ErMciSurgeBed, ErCareView, ErDeskView, ErDoctorOption, ErEpisodeView, ErItemOption, ErMlcDesk, ErMlcDetail, ErPatientHit, ErRefusalBody,
} from "@hmis/contracts";

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
  // lane 4 (#811)
  mlc: "/er/mlc",
  mlcOpen: "/er/mlc/open",
  mlcAddendum: "/er/mlc/addendum",
  mlcIntimation: "/er/mlc/intimation",
  mlcCountersign: "/er/mlc/countersign",
  mlcBelongings: "/er/mlc/belongings",
  mlcEvidence: "/er/mlc/evidence",
  // lane 5 (#812)
  dispoDecide: "/er/dispo/decide",
  dispoDischarge: "/er/dispo/discharge",
  dispoAdmit: "/er/dispo/admit",
  dispoRefer: "/er/dispo/refer",
  dispoLama: "/er/dispo/lama",
  dispoLwbs: "/er/dispo/lwbs",
  dispoAbscond: "/er/dispo/abscond",
  dispoDeath: "/er/dispo/death",
  // lane 6 (#813) — the ER bill desk (money)
  bill: "/er/bill",
  billPayer: "/er/bill/payer",
  billAdvance: "/er/bill/advance",
  billPrice: "/er/bill/price",
  billSettle: "/er/bill/settle",
  // lane 7 (#814) — codes
  codes: "/er/codes",
  codeCall: "/er/codes/call",
  codeEvent: "/er/codes/event",
  codeEnd: "/er/codes/end",
  codeDebrief: "/er/codes/debrief",
  // lane 8 (#815) — mass casualty, Code Yellow
  mci: "/er/mci",
  mciPacks: "/er/mci/packs",
  mciOverflow: "/er/mci/overflow-beds",
  mciDeclare: "/er/mci/declare",
  mciStandDown: "/er/mci/stand-down",
  mciArrival: "/er/mci/arrivals",
  mciTag: "/er/mci/tag",
  mciSurge: "/er/mci/surge",
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

/* ═══ lane 4 (#811) — the medico-legal case. The categories are the contract's `ER_MLC_CATEGORIES`, copied. ═══ */
export const ER_MLC_CATEGORIES = [
  "assault", "road_accident", "burns", "acid_attack", "poisoning", "hanging", "drowning", "fall_from_height", "bite_dispute",
  "unknown_unconscious", "sexual_assault", "brought_dead", "death_within_24h_injury", "police_brought", "other",
] as const;
export const ER_INJURY_KINDS = ["abrasion", "laceration", "contusion", "incised", "stab", "burn", "fracture", "firearm", "bite", "ligature_mark", "other"] as const;
export const ER_EVIDENCE_KINDS = ["clothes", "swab", "blood_sample", "projectile", "weapon", "viscera", "other"] as const;
export const fetchMlcDesk = () => api<ErMlcDesk>("GET", ER_ROUTES.mlc);
export const fetchMlc = (id: string) => api<ErMlcDetail>("GET", `${ER_ROUTES.mlc}/${encodeURIComponent(id)}`);
export const openMlcApi = (body: Record<string, unknown>) => post<{ mlcId: string; mlcNo: string; late: boolean }>(ER_ROUTES.mlcOpen, body);
export const mlcAddendumApi = (body: Record<string, unknown>) => post<{ addendumId: string }>(ER_ROUTES.mlcAddendum, body);
export const mlcIntimationApi = (body: Record<string, unknown>) => post<{ withinTarget: boolean }>(ER_ROUTES.mlcIntimation, body);
export const mlcCountersignApi = (mlcId: string) => post<{ withinTarget: boolean }>(ER_ROUTES.mlcCountersign, { mlcId });
export const mlcBelongingsApi = (body: Record<string, unknown>) => post<{ custodyId: string }>(ER_ROUTES.mlcBelongings, body);
export const mlcEvidenceApi = (body: Record<string, unknown>) => post<{ custodyId: string; link: number }>(ER_ROUTES.mlcEvidence, body);

/* ═══ lane 5 (#812) — disposition and departure. Lists are the contract's (`emergency/dispo.ts`), copied. ═══ */
export const ER_RETURN_IF_SIGNS = [
  "chest_pain", "breathlessness", "bleeding", "high_fever", "repeated_vomiting", "fits", "drowsiness", "worsening_pain",
  "wound_redness", "less_urine", "weakness_one_side", "severe_headache",
] as const;
export const ER_REFERRAL_REASONS = [
  "higher_centre_care", "specialty_not_available", "bed_not_available", "equipment_not_available", "patient_choice",
] as const;
export type DepartureOut = { episodeId: string; state: "departed"; outcome: string; departedAt: string; bayReleased: string | null };
/** Review #4: one idempotency key per ATTEMPT (kept across a retried click, renewed after success) — not per click. */
const postK = <T>(path: string, body: Record<string, unknown>, idempotencyKey: string) => api<T>("POST", path, { idempotencyKey, ...body });
export const dischargeApi = (body: Record<string, unknown>, k: string) => postK<DepartureOut>(ER_ROUTES.dispoDischarge, body, k);
export const handToUnitApi = (body: Record<string, unknown>, k: string) => postK<{ admissionId: string; boarding: boolean }>(ER_ROUTES.dispoAdmit, body, k);
export const referApi = (body: Record<string, unknown>, k: string) => postK<DepartureOut>(ER_ROUTES.dispoRefer, body, k);
export const lamaApi = (body: Record<string, unknown>, k: string) => postK<DepartureOut>(ER_ROUTES.dispoLama, body, k);
export const lwbsApi = (body: Record<string, unknown>, k: string = newKey()) => postK<DepartureOut>(ER_ROUTES.dispoLwbs, body, k);
export const abscondApi = (body: Record<string, unknown>, k: string) => postK<DepartureOut & { policeToBeInformed: boolean }>(ER_ROUTES.dispoAbscond, body, k);
export const deathApi = (body: Record<string, unknown>, k: string) => postK<DepartureOut>(ER_ROUTES.dispoDeath, body, k);

/* ═══ lane 6 (#813) — the ER bill desk (money: desk and billing roles only) ═══ */
export const ER_PAYER_KINDS = ["self", "pmjay", "road_accident", "bnss_free", "mci_event"] as const;
export const fetchErBillDesk = () => api<ErBillDesk>("GET", ER_ROUTES.bill);
export const fetchErBill = (episodeId: string) => api<ErBill>("GET", `${ER_ROUTES.bill}/${encodeURIComponent(episodeId)}`);
export const setPayerApi = (body: Record<string, unknown>) => post<{ payer: string }>(ER_ROUTES.billPayer, body);
export const advanceApi = (body: Record<string, unknown>) => post<{ receiptNo: string; amountPaise: number }>(ER_ROUTES.billAdvance, body);
export const priceLinesApi = (episodeId: string) => post<{ priced: number; stillMissing: number }>(ER_ROUTES.billPrice, { episodeId });
export const settleApi = (body: Record<string, unknown>, k: string) => postK<{ invoiceNo: string | null; duesPaise: number; paidPaise: number }>(ER_ROUTES.billSettle, body, k);

/* ═══ lane 7 (#814) — codes. Lists are the contract's (`emergency/codes.ts`), copied. ═══ */
export const ER_CODE_KINDS = ["code_blue", "code_grey", "stemi", "stroke", "trauma", "sepsis", "snakebite", "obstetric"] as const;
export const ER_CODE_MILESTONES: Record<string, readonly string[]> = {
  code_blue: [], code_grey: [], stemi: ["ecg", "balloon"], stroke: ["ct", "needle"], trauma: ["primary_survey", "ct"], sepsis: ["antibiotics"],
  snakebite: ["asv"], obstetric: ["lr_handover"],
};
export const ER_RHYTHMS = ["vf", "pulseless_vt", "pea", "asystole", "sinus", "brady", "svt", "af"] as const;
export const fetchErCodes = () => api<ErCodes>("GET", ER_ROUTES.codes);
export const fetchErCode = (id: string) => api<ErCodeView>("GET", `${ER_ROUTES.codes}/${encodeURIComponent(id)}`);
export const callCodeApi = (body: Record<string, unknown>) => post<{ codeId: string; paged: number }>(ER_ROUTES.codeCall, body);
export const codeEventApi = (body: Record<string, unknown>) => post<{ eventId: string; at: string }>(ER_ROUTES.codeEvent, body);
export const endCodeApi = (body: Record<string, unknown>) => post<{ durationSec: number }>(ER_ROUTES.codeEnd, body);
export const debriefApi = (body: Record<string, unknown>) => post<{ at: string }>(ER_ROUTES.codeDebrief, body);

/* ═══ lane 8 (#815) — mass casualty, Code Yellow. The tag list is the contract's (`emergency/mci.ts`), copied. ═══ */
export const ER_MCI_TAGS = ["red", "yellow", "green", "black"] as const;
export type ErMciTagName = (typeof ER_MCI_TAGS)[number];
export const fetchMciBoard = () => api<ErMciBoard>("GET", ER_ROUTES.mci);
export const fetchMciPacks = () => api<{ ready: Omit<ErMciPack, "packId" | "patientId" | "aliasHi">[] }>("GET", ER_ROUTES.mciPacks);
export const fetchMciOverflowBeds = () => api<ErMciSurgeBed[]>("GET", ER_ROUTES.mciOverflow);
export const fetchMciCount = (mciId: string) => api<ErMciCount>("GET", `${ER_ROUTES.mci}/${encodeURIComponent(mciId)}/count`);
export const declareMciApi = (body: Record<string, unknown>) => post<{ mciId: string }>(ER_ROUTES.mciDeclare, body);
export const standDownMciApi = (body: Record<string, unknown>) => post<{ backToEsi: number }>(ER_ROUTES.mciStandDown, body);
export const mintPacksApi = (body: Record<string, unknown>) => post<{ packs: ErMciPack[] }>(ER_ROUTES.mciPacks, body);
export const mciArrivalApi = (body: Record<string, unknown>) => post<{ episodeNo: string; alias: string }>(ER_ROUTES.mciArrival, body);
export const mciTagApi = (body: Record<string, unknown>) => post<{ tag: ErMciTagName }>(ER_ROUTES.mciTag, body);
export const surgeApi = (body: Record<string, unknown>) => post<{ opened: { bedId: string; code: string }[] }>(ER_ROUTES.mciSurge, body);

/* ═══ lane 9 (#816) — the ER copilot (`copilot.controller.ts`, the contract's `ER_COPILOT_ROUTES`, copied). Reads and drafts
 * only: nothing here records anything — a draft fills a form; the doctor signs through the act that owns it. ═══ */
const ER_COPILOT_ROUTES = { esi: "/er/copilot/esi", since: "/er/copilot/since", drafts: "/er/copilot/drafts", waiting: "/er/copilot/waiting" } as const;
export const fetchEsiProposal = (episodeId: string) => api<ErEsiProposal>("GET", `${ER_COPILOT_ROUTES.esi}/${encodeURIComponent(episodeId)}`);
/** #899 — does the proposal on the screen (its basis) still stand? */
export const checkEsiProposal = (episodeId: string, basis: string) =>
  api<ErEsiProposalCheck>("GET", `${ER_COPILOT_ROUTES.esi}/${encodeURIComponent(episodeId)}/check?basis=${encodeURIComponent(basis)}`);
export const fetchSinceArrival = (episodeId: string) => api<ErSinceArrival>("GET", `${ER_COPILOT_ROUTES.since}/${encodeURIComponent(episodeId)}`);
export const draftApi = (episodeId: string, kind: ErDraftKind) => api<ErDraft>("POST", `${ER_COPILOT_ROUTES.drafts}/${encodeURIComponent(episodeId)}/${kind}`, {});
export const fetchWaitingDisplay = () => api<ErWaitingDisplay>("GET", ER_COPILOT_ROUTES.waiting);
