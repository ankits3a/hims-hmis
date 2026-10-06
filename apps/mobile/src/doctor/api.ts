import type { WireDangerFlag } from "../vitals/rules";
import type {
  WireFollowUpConfig, WirePatientDispense, WirePatientImaging, WirePatientResult, WireQueueDoctor, WireQueueView, WireSkipReason,
} from "./rules";

/**
 * The server routes the doctor's phone uses — the SAME ones the web consultation screen calls
 * (apps/web/src/screens/opd-consult.tsx), each behind the permission the server already checks
 * (`opd.consult`, `opd.queue.read`, `opd.queue.operate`, `opd.visits.read`, `patients.read`,
 * `lab.results.read`, `radiology.reports.read`) and behind `requireTreatingDoctor` for every act on
 * a visit. Nothing here decides who is callable, who is held for the bill, or who may be completed.
 */
export type Call = <T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) => Promise<T>;

export type WireVisitVitals = {
  id: string; heightCm: number | null; weightKg: number | null; sbp: number | null; dbp: number | null;
  pulse: number | null; rr: number | null; spo2: number | null; tempC: number | null; muacCm: number | null;
  notes: string | null; dangerFlags: WireDangerFlag[]; recordedAt: string; recordedByName?: string;
  status: "active" | "superseded"; emergency?: boolean;
};
export type WireVisitDetail = {
  encounter: {
    id: string; visitNo: string; patientId: string; status: string; serviceDate: string; visitType: string;
    chiefComplaint: string | null; diagnosis: string | null; dangerFlagged: boolean;
    consultStartedAt: string | null; rxDraft?: { drug?: unknown }[] | null;
  };
  feeUnpaid?: boolean;
  feeBypass?: { by: string; reason: string; at: string } | null;
  deskComplaint?: { text: string; by: string; at: string } | null;
  vitals: WireVisitVitals[];
  prescriptions: { id: string; status: string }[];
};
export type WirePatientRow = { uhid: string; name: string | null; alias: string | null; dob: string | null; administrativeGender: string };
export type WireAllergyRow = { id: string; substance: string; reaction?: string | null; severity: "mild" | "moderate" | "severe" | null; status: string };
export type WireTimelineItem = {
  visitNo?: string; encounterId: string; serviceDate: string; status: string; visitType: string;
  doctorName: string | null; departmentName: string | null; diagnosis: string | null; prescriptionLineCount: number;
};
export type WireRxHistoryLine = { drug: string; dose: string; route: string; frequency: string; durationDays: number | null; instructions: string | null };
export type WireRxHistoryItem = {
  prescriptionId: string; encounterId: string; serviceDate: string; issuedAt: string; doctorName: string | null;
  status: string; version: number; lines: WireRxHistoryLine[];
};
export type WireDocument = { id: string; encounterId: string | null; kind: string; mimeType: string; byteSize: number; note: string | null; capturedAt: string };
export type WireDoctorUnit = { userId: string; short: string };

const enc = encodeURIComponent;

export function doctorApi(call: Call) {
  return {
    /** 404 `not_a_doctor` is an ANSWER — this user has no OPD doctor profile — not a transport error. */
    me: () => call<WireQueueDoctor>("GET", "/opd/me/doctor"),
    queue: (doctorId: string, serviceDate: string) =>
      call<WireQueueView | { session: null }>("GET", `/opd/queues?doctorId=${enc(doctorId)}&serviceDate=${serviceDate}`),
    config: () => call<WireFollowUpConfig>("GET", "/opd/config"),
    doctorUnits: (date: string) => call<WireDoctorUnit[]>("GET", `/roster/doctor-units?date=${enc(date)}`),

    callNext: (sessionId: string) => call<{ entry: { id: string; tokenNo: number } | null }>("POST", `/opd/queues/${enc(sessionId)}/call-next`),
    recall: (entryId: string) => call<unknown>("POST", `/opd/queues/entries/${enc(entryId)}/recall`),
    skip: (entryId: string, reason: WireSkipReason, note: string | null) => call<unknown>("POST", `/opd/queues/entries/${enc(entryId)}/skip`, { reason, note }),
    undoSkip: (entryId: string) => call<unknown>("POST", `/opd/queues/entries/${enc(entryId)}/undo-skip`),
    sessionStatus: (sessionId: string, status: "in" | "out") => call<unknown>("POST", `/opd/queues/${enc(sessionId)}/status`, { status }),

    openUnpaid: (encounterId: string, reason: string) => call<unknown>("POST", `/opd/visits/${enc(encounterId)}/consult/open-unpaid`, { reason }),
    start: (encounterId: string) => call<unknown>("POST", `/opd/visits/${enc(encounterId)}/consult/start`),
    park: (encounterId: string) => call<unknown>("POST", `/opd/visits/${enc(encounterId)}/consult/park`),
    resume: (encounterId: string) => call<unknown>("POST", `/opd/visits/${enc(encounterId)}/consult/resume`),
    complete: (encounterId: string, body: { testsOrderedReturnToday: boolean; followUpDays?: number }) =>
      call<unknown>("POST", `/opd/visits/${enc(encounterId)}/consult/complete`, body),

    visit: (encounterId: string) => call<WireVisitDetail>("GET", `/opd/visits/${enc(encounterId)}`),
    /** A sealed record answers 404 here: restricted mode, never an error on the screen. */
    patient: (patientId: string) => call<{ patient: WirePatientRow }>("GET", `/patients/${enc(patientId)}`),
    allergies: (patientId: string) => call<{ items: WireAllergyRow[] }>("GET", `/patients/${enc(patientId)}/allergies`),
    timeline: (patientId: string) => call<{ items: WireTimelineItem[] }>("GET", `/opd/patients/${enc(patientId)}/timeline`),
    prescriptions: (patientId: string) => call<{ items: WireRxHistoryItem[] }>("GET", `/opd/patients/${enc(patientId)}/prescriptions`),
    labResults: (patientId: string) => call<{ items: WirePatientResult[] }>("GET", `/lab/results/patient/${enc(patientId)}`),
    imaging: (patientId: string) => call<{ items: WirePatientImaging[] }>("GET", `/radiology/reports/patient/${enc(patientId)}`),
    dispenses: (patientId: string) => call<{ items: WirePatientDispense[] }>("GET", `/pharmacy/doctor/patients/${enc(patientId)}/dispenses`),
    /** Metadata only; the bytes are their own request, because reading a slip is its own PHI read. */
    documents: (patientId: string) => call<{ items: WireDocument[] }>("GET", `/patients/${enc(patientId)}/documents`),
    document: (documentId: string) => call<{ mimeType: string; imageBase64: string }>("GET", `/patients/documents/${enc(documentId)}`),
  };
}
export type DoctorApi = ReturnType<typeof doctorApi>;
