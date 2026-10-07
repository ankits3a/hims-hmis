import type { Call } from "../doctor/api";
import type { ConsultTest, WireLastLine, WirePrecheck, WireSetBody } from "./rules";

/**
 * The routes the doctor's phone consultation uses. Everything that writes a note, checks a line,
 * issues a prescription or completes a visit is the WEB consultation's own route, behind
 * `opd.consult` and `requireTreatingDoctor` — the phone adds no way to do any of them. The four
 * that are new (sets, most-used diagnoses, the voice status and the spoken note) are decision 0048.
 */
export type WireMedicineHit = { id: string; name: string; form: string; strength: string | null; code: string | null; routeClass: string; salts: string[]; prefix: boolean; reviewed: boolean };
export type WireIcd10Hit = { code: string; description: string };
export type WireMyDiagnosis = { text: string; icd10Code: string | null; uses: number };
export type WireComplaintHit = { term: string; mine: number; hospital: number };
export type WireTestHit = { serviceId: string; code: string; name: string; pricePaise: number; mine: number; hospital: number };
export type WirePriceRow = { serviceId: string; code: string; name: string; pricePaise: number; category?: string | null };
export type WireAdviceTemplate = { id: string; title: string; textEn: string | null; textHi: string | null; mine: boolean };
export type WireRxSet = {
  id: string; scope: "doctor" | "department"; name: string; body: WireSetBody; departmentId: string | null; departmentName: string | null;
  mine: boolean; signed: boolean; signedByName: string | null; signedAt: string | null; maySign: boolean;
};
export type WireVoiceStatus = {
  enabled: boolean; configured: boolean; model: string; maxSeconds: number; usedSecondsToday: number; dailyMinutesCap: number;
  why: "not_configured" | "switched_off" | "cap_reached" | null;
};
export type WireVoiceSuggestion =
  | { kind: "medicine"; heard: string; medicineId: string; name: string; form: string; strength: string | null }
  | { kind: "test"; heard: string; serviceId: string; code: string; name: string; pricePaise: number };
export type WireVoiceResult = { voiceId: string; text: string; suggestions: WireVoiceSuggestion[]; model: string };
export type WireConsultVisit = {
  encounter: {
    id: string; visitNo: string; patientId: string; status: string; chiefComplaint: string | null; doctorNote?: string | null;
    diagnosis: string | null; advice?: string | null; advisedTests?: ConsultTest[] | null;
    rxDraft?: { drug?: string; dose?: string; route?: string; frequency?: string; durationDays?: number | string | null; instructions?: string; medicineId?: string | null }[] | null;
  };
  prescriptions: { id: string; status: string }[];
};
export type WireIssued = { prescriptionId: string; version: number };

const enc = encodeURIComponent;

export function consultApi(call: Call) {
  return {
    visit: (id: string) => call<WireConsultVisit>("GET", `/opd/visits/${enc(id)}`),
    saveNote: (id: string, body: Record<string, unknown>) => call<unknown>("PUT", `/opd/visits/${enc(id)}/consult/note`, body),
    precheck: (id: string, lines: unknown[]) => call<WirePrecheck>("POST", `/opd/visits/${enc(id)}/rx-precheck`, { lines }),
    issue: (id: string, body: Record<string, unknown>) => call<WireIssued>("POST", `/opd/visits/${enc(id)}/prescriptions`, body),
    complete: (id: string, body: Record<string, unknown>) => call<unknown>("POST", `/opd/visits/${enc(id)}/consult/complete`, body),

    medicines: async (q: string) => (await call<{ items: WireMedicineHit[] }>("GET", `/formulary/medicines/search?q=${enc(q)}&limit=8`)).items,
    diagnoses: async (q: string) => (await call<{ items: WireIcd10Hit[] }>("GET", `/opd/cds/complete/diagnosis?q=${enc(q)}&limit=8`)).items,
    myDiagnoses: async () => (await call<{ items: WireMyDiagnosis[] }>("GET", "/opd/consult/my-diagnoses")).items,
    complaints: async (q: string) => (await call<{ items: WireComplaintHit[] }>("GET", `/opd/cds/complete/complaint?q=${enc(q)}`)).items,
    testsFor: async (dx: { text: string; icd10: string | null }[]) => (await call<{ items: WireTestHit[] }>("GET", `/opd/cds/suggest/tests?dx=${enc(JSON.stringify(dx))}`)).items,
    priceList: async () => (await call<{ items: WirePriceRow[] }>("GET", "/tariff/price-list")).items,
    advice: async () => (await call<{ items: WireAdviceTemplate[] }>("GET", "/opd/advice-templates")).items,
    lastPrescriptions: async (patientId: string) => (await call<{ items: { prescriptionId: string; encounterId: string; serviceDate: string; issuedAt: string; status: string; lines: WireLastLine[] }[] }>("GET", `/opd/patients/${enc(patientId)}/prescriptions`)).items,

    sets: () => call<{ items: WireRxSet[]; headOf: string[]; departmentId: string | null }>("GET", "/opd/rx-sets"),
    saveSet: (name: string, body: WireSetBody) => call<{ setId: string }>("POST", "/opd/rx-sets", { scope: "doctor", name, body }),
    retireSet: (id: string) => call<unknown>("DELETE", `/opd/rx-sets/${enc(id)}`),

    voiceStatus: () => call<WireVoiceStatus>("GET", "/opd/consult/voice/status"),
    voice: (id: string, audio: string, mimeType: string, seconds: number) => call<WireVoiceResult>("POST", `/opd/visits/${enc(id)}/consult/voice`, { audio, mimeType, seconds }),
    voiceKept: (voiceId: string, changedChars: number, keptChars: number) => call<unknown>("POST", `/opd/consult/voice/${enc(voiceId)}/kept`, { changedChars, keptChars }),
  };
}
export type ConsultApi = ReturnType<typeof consultApi>;
