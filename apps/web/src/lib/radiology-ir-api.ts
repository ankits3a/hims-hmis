import { api } from "./api";

/**
 * PLAN 18-S RS12b — the IR suite's wire contract, transcribed from `radiology-ir.controller.ts` /
 * `ir.ts`. Nothing here decides: the checklist, the coagulation rule, the fasting hours and the Ka,r
 * triggers are the server's (the thresholds arrive on the case read). The instruction drafts below
 * are deterministic suggestions the operator edits — never inference.
 */

export type IrPhase = "sign_in" | "time_out" | "sign_out";
export type IrNext = "check_in" | "sign_in" | "time_out" | "start" | "sign_out" | "send" | "note" | "handoff" | "done" | "closed";
export type IrVerdict = "missing" | "stale" | "inr_high" | "platelets_low";
export type IrSedationPlan = "local" | "moderate" | "deep";

export type WireIrThresholds = {
  skinFollowUpMgy: number; srdlMgy: number; inrMax: number; plateletsMinPerUl: number; coagValidDays: number;
  vitalsEveryMin: number; recoveryVitalsEveryMin: number; skinFollowUpDays: { min: number; max: number }; fastingSolidsHours: number; fastingClearHours: number;
};

export type WireIrVitals = {
  id: string; bpSystolic: number; bpDiastolic: number; heartRate: number; spo2: number; rass: number;
  drug: string | null; recordedByName: string; recordedAt: string;
};

export type WireIrHandoff = {
  vitals: { bpSystolic: number; bpDiastolic: number; heartRate: number; spo2: number };
  bedRestHours: number; drainCare?: string; instructionsEn: string; instructionsHi: string; receivedBy: string;
};

/** `ir.ts`'s `IrCaseView`. */
export type WireIrCase = {
  studyId: string; accessionNo: string; status: string; priority: string;
  studyTypeCode: string; studyTypeName: string; bleedingRisk: "low" | "high";
  lateralityApplicable: boolean; laterality: string;
  patient: { name: string; uhid: string; restricted: boolean; ageYears: number | null; sex: string };
  phases: { phase: IrPhase; items: { key: string; answer: unknown; note?: string }[]; participants: string[]; recordedByName: string; recordedAt: string }[];
  coagulation: {
    required: boolean;
    inr: { value: number; sampledAt: string } | null;
    platelets: { perUl: number; sampledAt: string } | null;
    verdicts: IrVerdict[];
    override: { verdict: string; reason: string; byName: string; at: string } | null;
  };
  sedation: { plan: IrSedationPlan | null; vitals: WireIrVitals[]; nextDueAt: string | null };
  dose: { karMgy: number | null; dapGyCm2: number | null; fluoroSeconds: number | null; levels: { level: string; thresholdMgy: number }[] };
  skinFollowUp: { on: string; note: string | null; byName: string; at: string } | null;
  note: {
    procedure: string; approach: string | null; devices: string | null; specimens: string | null;
    complications: string | null; bloodLossMl: number | null; byName: string; at: string;
  } | null;
  handoff: { detail: WireIrHandoff; byName: string; at: string } | null;
  next: IrNext;
  thresholds: WireIrThresholds;
};

export type WireIrRow = {
  studyId: string; accessionNo: string; status: string; priority: string;
  studyTypeCode: string; studyTypeName: string; bleedingRisk: "low" | "high";
  scheduledAt: string | null; deviceCode: string | null;
  patientId: string; patientName: string; restricted: boolean;
  phases: IrPhase[]; handedOff: boolean; lastVitalsAt: string | null; next: IrNext;
};

export type IrSignInBody = {
  participants: string[];
  identityConfirmed: boolean;
  consent: {
    procedureCode: string; templateVersion: string; language: string; signer: "patient" | "guardian";
    guardianId?: string; interpreter?: string; witness?: string; thumbImpression: boolean;
    laterality: "left" | "right" | "bilateral" | null; conversionCovered: boolean; signedAt: string;
  };
  siteMarked: boolean; allergiesReviewed: boolean;
  anticoagulants: "none" | "held" | "continued"; anticoagulantNote?: string;
  sedationPlan: IrSedationPlan; sedationBy?: string;
  lastSolidsAt?: string; lastClearFluidsAt?: string;
  ivAccessAndResus: boolean;
};
export type IrTimeOutBody = {
  participants: string[]; teamIntroduced: boolean; patientProcedureSideConfirmed: boolean; imagesDisplayed: boolean;
  antibiotics: "given" | "not_indicated"; criticalEventsDiscussed: boolean;
};
export type IrSignOutBody = {
  participants: string[]; procedureDone: boolean; countsCorrect: boolean; specimens: "labelled" | "none";
  devices: string; doseRecorded: boolean; recoveryPlanGiven: boolean;
};
export type IrVitalsBody = { bpSystolic: number; bpDiastolic: number; heartRate: number; spo2: number; rass: number; drug?: string };
export type IrNoteBody = {
  procedure: string; approach?: string; devices?: string; specimens?: string; complications?: string; bloodLossMl?: number;
};

const s = (id: string) => `/radiology/studies/${encodeURIComponent(id)}/ir`;

export const fetchIrCases = () => api<{ rows: WireIrRow[] }>("GET", "/radiology/ir/cases");
export const fetchIrCase = (studyId: string) => api<{ case: WireIrCase }>("GET", s(studyId));
export const irSignIn = (studyId: string, body: IrSignInBody) => api("POST", `${s(studyId)}/sign-in`, body);
export const irTimeOut = (studyId: string, body: IrTimeOutBody) => api("POST", `${s(studyId)}/time-out`, body);
export const irSignOut = (studyId: string, body: IrSignOutBody) => api("POST", `${s(studyId)}/sign-out`, body);
export const irOverrideCoagulation = (studyId: string, reason: string) => api("POST", `${s(studyId)}/coagulation-override`, { reason });
export const irRecordVitals = (studyId: string, body: IrVitalsBody) => api("POST", `${s(studyId)}/vitals`, body);
export const irSkinFollowUp = (studyId: string, followUpOn: string, note?: string) =>
  api("POST", `${s(studyId)}/skin-follow-up`, { patientInformed: true, followUpOn, ...(note === undefined || note.trim() === "" ? {} : { note }) });
export const irRecordNote = (studyId: string, body: IrNoteBody) => api("POST", `${s(studyId)}/note`, body);
export const irHandoff = (studyId: string, body: WireIrHandoff) => api("POST", `${s(studyId)}/handoff`, body);

/* ── pure helpers ── */

/** `mm:ss` or plain seconds → whole seconds; null when blank or unreadable. */
export function parseFluoro(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const m = /^(\d{1,3}):([0-5]\d)$/.exec(t);
  if (m !== null) return Number(m[1]) * 60 + Number(m[2]);
  return /^\d{1,6}$/.test(t) ? Number(t) : null;
}

export const fmtFluoro = (sec: number): string => `${String(Math.floor(sec / 60))}:${String(sec % 60).padStart(2, "0")}`;

/** Which Ka,r trigger a typed number reaches — the same thresholds the server sent. */
export function karLevel(karMgy: number | null, t: Pick<WireIrThresholds, "skinFollowUpMgy" | "srdlMgy">): "none" | "skin" | "srdl" {
  if (karMgy === null) return "none";
  if (karMgy >= t.srdlMgy) return "srdl";
  return karMgy >= t.skinFollowUpMgy ? "skin" : "none";
}

/**
 * The recovery instructions, drafted by rule (never inference): bed rest by bleeding risk (DECIDED
 * 6 h high, 4 h low — the operator edits), the dressing, the warning signs, and the drain when one
 * was left. English and Hindi carry the same sentences.
 */
export function draftInstructions(bedRestHours: number, drain: boolean): { en: string; hi: string } {
  const en = [
    `Lie flat in bed for ${String(bedRestHours)} hours.`,
    "Keep the dressing dry and do not remove it.",
    "Tell the nurse at once about bleeding, swelling, fever, breathlessness or new pain.",
  ];
  const hi = [
    `${String(bedRestHours)} घंटे बिस्तर पर सीधे लेटे रहें।`,
    "पट्टी सूखी रखें और उसे न हटाएं।",
    "खून आना, सूजन, बुखार, सांस फूलना या नया दर्द हो तो तुरंत नर्स को बताएं।",
  ];
  if (drain) {
    en.push("Keep the drain bag below the level of the wound and do not pull the tube.");
    hi.push("ड्रेन की थैली घाव से नीचे रखें और नली को न खींचें।");
  }
  return { en: en.join(" "), hi: hi.join(" ") };
}

/** The skin check date the form suggests: three weeks out (inside the 2–4 week window), as YYYY-MM-DD in IST. */
export function suggestedSkinCheck(nowMs: number): string {
  const ist = new Date(nowMs + 330 * 60_000 + 21 * 86_400_000);
  return ist.toISOString().slice(0, 10);
}
