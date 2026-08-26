import { api, ApiError } from "./api";

/**
 * The OPD wire contract, shared by all six Plan 07 screens (the plan's File Structure names this file
 * as the one place the shapes live). Every `Date` column of the three OPD controllers arrives
 * JSON-serialized as an ISO string, and every IST calendar date as 'YYYY-MM-DD' — the Plan 05 wire-type
 * convention. The server stays authoritative: nothing here validates, it only describes what arrives.
 */

// ——— small closed vocabularies the screens branch and label on (D1 / D2 / D7) ———

export type OpdVisitStatus = "registered" | "waiting" | "in_consultation" | "awaiting_results" | "completed" | "abandoned";
export type OpdQueueStatus = "waiting_vitals" | "waiting" | "called" | "in_consult" | "done" | "left" | "transferred" | "cancelled";
export type OpdSessionStatus = "not_started" | "in" | "out" | "closed";
export type OpdVisitType = "new" | "revisit" | "renewal";
/** 0 danger · 1 same-day re-entry · 2 due appointment · 3 walk-in · 4 future appointment (D2). */
export type OpdQueueClass = 0 | 1 | 2 | 3 | 4;

// ——— masters ———

export type WireDepartment = {
  id: string; code: string; name: string; active: boolean;
  createdBy: string; createdAt: string; updatedBy: string; updatedAt: string;
};

export type WireRoom = {
  id: string; code: string; name: string; floor: string | null; active: boolean;
  createdBy: string; createdAt: string; updatedBy: string; updatedAt: string;
};

export type WireDoctor = {
  id: string; userId: string; displayName: string; registrationNo: string | null; departmentId: string;
  specialty: string | null; active: boolean;
  createdBy: string; createdAt: string; updatedBy: string; updatedAt: string;
};

export type WireSchedule = {
  id: string; doctorId: string; weekday: number; startTime: string; endTime: string; roomId: string;
  slotMinutes: number | null; validFrom: string; validTo: string | null; active: boolean;
  createdBy: string; createdAt: string;
};

export type WireLeave = {
  id: string; doctorId: string; fromDate: string; toDate: string; reason: string;
  status: "scheduled" | "cancelled"; createdBy: string; createdAt: string;
  cancelledBy: string | null; cancelledAt: string | null;
};

export type WireOpdConfig = {
  slotMinutes: number; followUpDefaultDays: number; followUpExtensionDays: number[];
  extensionCapPerDoctorPerMonth: number; maxSkipsBeforeLeft: number; perkEveryNth: number | null;
  dangerRanges: unknown; letterhead: { name: string; addressLines: string[] };
};

// ——— patients, as the OPD module is allowed to see them (§14 / D-37) ———

export type WirePatientSummary = {
  requestedId: string; id: string; uhid: string; name: string | null; alias: string | null;
  restricted: boolean; sex: string; dob: string | null;
};

// ——— appointments and slots ———

export type WireSlot = { start: string; end: string; roomId: string; scheduleId: string; booked: boolean; past: boolean };

export type WireAppointment = {
  id: string; patientId: string; doctorId: string; departmentId: string; serviceDate: string;
  slotStart: string; slotEnd: string;
  status: "booked" | "checked_in" | "cancelled" | "no_show" | "needs_rebooking" | "rescheduled";
  source: "desk" | "phone"; note: string | null; encounterId: string | null;
  rescheduledToId: string | null; rescheduledFromId: string | null; cancelReason: string | null; leaveId: string | null;
  bookedBy: string; bookedAt: string; updatedBy: string; updatedAt: string;
  /** present on the list route, absent on the write routes' bare row */
  patient?: WirePatientSummary | null;
};

// ——— the encounter spine, the queue, vitals and the e-Rx ———

export type WireEncounter = {
  id: string; visitNo: string; patientId: string; type: string; status: OpdVisitStatus; workflowInstanceId: string;
  departmentId: string | null; doctorId: string | null; appointmentId: string | null; serviceDate: string;
  visitType: OpdVisitType; intendedPayer: string; referralSource: string | null; referrerName: string | null;
  chiefComplaint: string | null; diagnosis: string | null; icd10Code: string | null; advice: string | null;
  admissionAdvised: boolean; referralTo: string | null; referralNote: string | null;
  followUpDays: number | null; followUpExtended: boolean; dangerFlagged: boolean;
  consultStartedAt: string | null; consultCompletedAt: string | null;
  abandonedAt: string | null; abandonReason: string | null;
  openedBy: string; openedAt: string; updatedBy: string; updatedAt: string;
  /** present on the list/detail routes, absent on the write routes' bare row */
  patient?: WirePatientSummary | null;
};

export type WireQueueSession = {
  id: string; doctorId: string; serviceDate: string; roomId: string | null; status: OpdSessionStatus;
  nextToken: number; callsMade: number; openedAt: string | null; closedAt: string | null; createdAt: string;
};

export type WireQueueEntry = {
  id: string; seq: number; sessionId: string; encounterId: string; tokenNo: number;
  kind: "appointment" | "walk_in"; appointmentAt: string | null; status: OpdQueueStatus;
  danger: boolean; reEntry: boolean; perk: boolean;
  eligibleAt: string | null; calledAt: string | null; callCount: number; skips: number;
  doneAt: string | null; createdAt: string;
};

/** A queue row as the desk and the consultation screen read it: the row plus the engine's verdict. */
export type WireQueueEntryView = WireQueueEntry & {
  position: number | null;
  queueClass: OpdQueueClass | null;
  encounter: { id: string; patientId: string; visitType: string; dangerFlagged: boolean; status: string };
  patient: WirePatientSummary | null;
};

export type WireQueueView = {
  session: WireQueueSession; doctor: WireDoctor; ordered: WireQueueEntryView[];
  current: WireQueueEntryView | null; inConsult: WireQueueEntryView[]; waitingVitals: number;
  counts: { waiting: number; called: number; inConsult: number; done: number; left: number };
};

/**
 * PLAN 16a T6 — the check-suite shapes the consult screen renders.
 *
 * They live here rather than in the screen because every other `Wire*` in this app does, and a
 * type that describes a server response is the app's shared vocabulary rather than one screen's
 * private business. `WireMedicine` and the coverage shape deliberately do NOT join them: those are
 * FORMULARY responses and belong to `formulary-api.ts`, which T7 creates.
 */
export type WireHitAgainst =
  | { scope: "in_rx"; lineIndex: number }
  | { scope: "prior"; prescriptionId: string; issuedAt: string; assumedCurrent: boolean };

export type WireInteractionHit = {
  severity: "severe" | "moderate"; lineIndex: number; note: string; against: WireHitAgainst;
  /** The interacting pair. The client echoes it on an override so the server knows WHAT was cleared (C5). */
  saltPair: [string, string];
};

export type WireDuplicateHit = {
  moiety: string; lineIndex: number; hard: boolean; against: WireHitAgainst;
};

/** A soft hit is either kind: the screen renders them together and never gates on them (DD3). */
export type WireRxNotice = WireInteractionHit | WireDuplicateHit;

/** `true` for an interaction hit — the discriminant the two kinds actually differ by. */
export function isInteractionHit(hit: WireRxNotice): hit is WireInteractionHit {
  return "severity" in hit;
}

export type WireDoctorSummary = {
  doctor: WireDoctor; sessionId: string | null; status: OpdSessionStatus | "none";
  waitingCount: number; waitingVitalsCount: number; nowServing: number | null;
  scheduledToday: boolean; roomCode: string | null;
};

/** The public board (§11.5): token, room and doctor ONLY — no patient identity ever reaches this shape. */
export type WireBoardItem = {
  sessionId: string; roomId: string | null; roomCode: string | null; doctorId: string; doctorName: string;
  departmentName: string; status: OpdSessionStatus; nowServing: number | null; next: number[]; waitingCount: number;
};

export type WireOpenVisitResult = {
  encounter: WireEncounter; queueEntry: WireQueueEntry; tokenNo: number; sessionId: string;
  roomId: string | null; visitType: OpdVisitType; doctorScheduledToday: boolean;
};

export type WireDangerFlag = { vital: "sbp" | "dbp" | "pulse" | "rr" | "spo2" | "tempC"; value: number; bound: "min" | "max"; limit: number };

export type WireVitals = {
  id: string; encounterId: string; patientId: string;
  heightCm: number | null; weightKg: number | null; sbp: number | null; dbp: number | null;
  pulse: number | null; rr: number | null; spo2: number | null; tempC: number | null; notes: string | null;
  ageYearsAtRecord: number | null; band: "infant" | "child_1_5" | "child_6_12" | "adult";
  dangerFlags: WireDangerFlag[]; recordedBy: string; recordedAt: string;
};

export type WireRxLine = {
  drug: string; dose: string; route: string; frequency: string;
  durationDays: number | null; instructions: string | null; noSubstitution: boolean;
};

export type WirePrescription = {
  id: string; encounterId: string; patientId: string; doctorId: string; version: number;
  lines: WireRxLine[]; document: unknown; allergyOverrides: unknown[];
  status: "active" | "superseded"; issuedBy: string; issuedAt: string;
};

export type WireRxPrint = {
  letterhead: { name: string; addressLines: string[] };
  patient: { uhid: string; name: string | null; alias: string | null; restricted: boolean; ageYears: number | null; sex: string };
  doctor: { displayName: string; registrationNo: string | null; departmentName: string | null };
  encounter: {
    id: string; visitNo: string; serviceDate: string; diagnosis: string | null; icd10Code: string | null;
    advice: string | null; followUpDays: number | null; chiefComplaint: string | null;
  };
  vitals: WireVitals | null; lines: WireRxLine[]; qrPayload: string; version: number; issuedAt: string;
};

export type WireTimelineItem = {
  encounterId: string; serviceDate: string; openedAt: string; status: string; visitType: string;
  doctorId: string | null; doctorName: string | null; departmentId: string | null; departmentName: string | null;
  diagnosis: string | null; icd10Code: string | null; prescriptionLineCount: number; dangerFlagged: boolean;
};

// ——— errors ———

/**
 * The OPD error body — an OBJECT, deliberately wider than the patients/tariff modules' `code: message`
 * string prefix (opd-masters.controller.ts's toHttp). Screens branch on `code` and display `message`.
 */
export type WireOpdError = { statusCode: number; message: string; code: string; detail?: unknown };

/**
 * The displayable text of a failed OPD call. `message` is what the server wants the desk to read; a
 * zod-rejected body carries an ISSUE ARRAY there instead (Nest's BadRequestException), which
 * String(err) prints as "[object Object]"; and a body with no message at all falls back to the
 * machine `code` — never an empty banner.
 */
export function opdErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { message?: unknown; code?: unknown } | null;
    if (typeof body?.message === "string" && body.message !== "") return body.message;
    if (Array.isArray(body?.message)) {
      return body.message
        .map((issue) =>
          typeof issue === "object" && issue !== null && "message" in issue
            ? String((issue as { message: unknown }).message)
            : String(issue),
        )
        .join("; ");
    }
    if (typeof body?.code === "string" && body.code !== "") return body.code;
  }
  return String(e);
}

// ——— the hospital clock ———

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/**
 * The IST calendar date ('YYYY-MM-DD') of an instant — the browser mirror of the server's
 * modules/opd/time.ts istDate. IST is a fixed +05:30 with no DST, so this is arithmetic: no Intl,
 * no dependency on the desk machine's timezone (which is routinely wrong on hospital hardware).
 */
export function todayIst(at: Date = new Date()): string {
  return new Date(Math.floor((at.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

// ——— tiny fetchers (the masters reads every OPD screen needs) ———

export function listDepartments(): Promise<{ items: WireDepartment[] }> {
  return api("GET", "/opd/departments");
}
export function listRooms(): Promise<{ items: WireRoom[] }> {
  return api("GET", "/opd/rooms");
}
export function listDoctors(): Promise<{ items: WireDoctor[] }> {
  return api("GET", "/opd/doctors");
}
export function listDoctorSchedules(doctorId: string): Promise<{ items: WireSchedule[] }> {
  return api("GET", `/opd/doctors/${doctorId}/schedules`);
}
export function listLeaves(doctorId: string): Promise<{ items: WireLeave[] }> {
  return api("GET", `/opd/leaves?doctorId=${encodeURIComponent(doctorId)}`);
}
