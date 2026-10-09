import type { Call } from "../doctor/api";
import type { CounterFeeQuote, CounterFlow, CounterTimelineItem, MoveConsultTerms, MoveMoney, MoveVisitType, PaperJob } from "./rules";

/**
 * The server routes the phone's Desk One uses — the SAME ones the counter PC calls
 * (apps/web/src/screens/desk-one), each behind the permission the server already checks:
 * `patients.read` / `patients.register` for the person, `opd.visits.open` for the visit,
 * `opd.queue.read` for the board, `billing.invoice.read` / `billing.invoice.issue` /
 * `billing.session.own` for the money, `opd.paper.reprint` for the paper. Nothing here prices a
 * visit, decides what kind it is, allocates a token or takes money: the phone asks, the server
 * answers, and a refusal is shown in the server's own words.
 *
 * THE TWO WRITES THAT MUST NEVER HAPPEN TWICE — a visit and a bill — carry an `Idempotency-Key`
 * (the web's own header). The phone keeps ONE key per intent and sends it again on a retry, so a
 * request whose answer was lost on a bad connection is ANSWERED the second time, not repeated.
 */

export type WireMatchLane = "uhid" | "mobile" | "name";
export type WirePatientHit = {
  id: string; uhid: string; name: string; phone: string | null; administrativeGender: string; dob: string | null;
  isConfidential: boolean; district?: string | null; matchedOn: WireMatchLane[];
};
export type WireQrVerify =
  | { ok: true; patient: { id: string; uhid: string; name: string; administrativeGender: string; dob: string | null } }
  | { ok: false; reason: string };
export type WireRegistered = { patient: { id: string; uhid: string; name: string; dob: string | null; phone: string | null; addressLine: string | null } };
export type WirePatientDetail = { patient: { uhid: string; name: string | null; alias: string | null; dob: string | null; phone: string | null; addressLine: string | null; administrativeGender: string } };
export type WireLinked = {
  numbers: string[]; total: number;
  items: { id: string; uhid: string; name: string; phone: string | null; administrativeGender: string; dob: string | null; isConfidential: boolean; sharedOn: string[] }[];
};

export type WireDepartment = { id: string; code: string; name: string; active: boolean };
export type WireBoardDoctor = { id: string; userId: string; displayName: string; departmentId: string; active: boolean; designation?: string | null };
export type WireDoctorSummary = {
  doctor: WireBoardDoctor; sessionId: string | null; status: string;
  waitingCount: number; waitingVitalsCount: number; nowServing: number | null;
  scheduledToday: boolean; roomCode: string | null; avgConsultMinutes: number; onLeaveToday: boolean;
};
export type WireContinuity = { anchor: { doctorId: string; doctorName: string; seenOn: string; windowEndsOn: string; wouldBe: MoveVisitType; via?: "consult" | "referral" } | null };

export type WireWalkIn = {
  encounter: { id: string; visitNo: string; patientId: string; status: string; visitType: MoveVisitType; departmentId: string | null; doctorId: string | null };
  tokenNo: number | null; sessionId: string | null; roomId: string | null; visitType: MoveVisitType; patientId: string; registered: boolean;
};
export type WireJoin = { tokenNo: number; alreadyJoined: boolean };

export type WireFeeStatus = "free" | "settled" | "credit" | "unsettled";
export type WireFeeQuote = CounterFeeQuote & {
  encounterId: string; visitType: string;
  visit?: { visitNo: string; serviceDate: string; status: string; tokenNo: number | null; departmentCode: string | null; feeStatus: WireFeeStatus | null } | null;
  alreadyBilled?: { invoiceId: string; invoiceNo: string } | null;
  intendedPayer: string;
};
export type TenderMode = "cash" | "upi" | "card";
export type WireIssueBody = {
  draftId: string; patientId: string; encounterId: string;
  lines: { lineId: string; serviceId: string; qty: number }[];
  receipt: { tenders: { mode: TenderMode; amountPaise: number; refText?: string }[] };
};
export type WireIssued = { invoiceId: string; invoiceNo: string; receiptNo: string | null; totals: { netPayablePaise: number } };
export type WireCashSession = { id: string; status: "open" | "closing" | "closed"; openedAt: string; openingFloatPaise: number };
export type WireInvoiceRow = { id: string; invoiceNo: string; netPayablePaise: number; issuedAt: string; creditExtended: boolean };

export type WirePrintJob = PaperJob & { attempts: number; lastError: string | null; printedAt: string | null };

export type WireMovePreview = {
  encounterId: string;
  from: { departmentId: string | null; doctorId: string | null; visitType: MoveVisitType; feePaise?: number };
  to: { departmentId: string; visitType: MoveVisitType; feePaise?: number };
  standingInvoiceNo: string | null;
  money?: MoveMoney;
  maySettleDifference?: boolean;
};
export type WireMoveResult = {
  from: { encounter: { id: string; visitNo: string }; tokenNo: number | null };
  to: { encounter: { id: string; visitNo: string; patientId: string; departmentId: string | null; doctorId: string | null }; tokenNo: number | null; visitType: MoveVisitType };
  money?: MoveMoney & { creditNoteNo: string | null; newInvoiceNo: string | null; advancePaise: number; collectedPaise: number };
};
export type WireDoctorUnit = { userId: string; short: string };

// ——— appointments (the web's `/opd/slots` and `/opd/appointments…`; `opd.appointments.read` / `.manage`) ———
export type WireMasterDoctor = { id: string; userId: string; displayName: string; departmentId: string; active: boolean; designation?: string | null };
export type WireRoom = { id: string; code: string; name: string; active: boolean };
export type WireSchedule = { id: string; doctorId: string; weekday: number; startTime: string; endTime: string; roomId: string; validFrom: string; validTo: string | null; active: boolean };
export type WireLeave = { id: string; doctorId: string; fromDate: string; toDate: string; reason: string; status: "scheduled" | "cancelled" };
export type WireSlot = { start: string; end: string; roomId: string; scheduleId: string; booked: boolean; past: boolean };
export type WireAppointment = {
  id: string; appointmentNo?: string | null; patientId: string; doctorId: string; departmentId: string; serviceDate: string;
  slotStart: string; slotEnd: string;
  status: "booked" | "checked_in" | "cancelled" | "no_show" | "needs_rebooking" | "rescheduled";
  note: string | null; encounterId: string | null; rescheduledToId: string | null; rescheduledFromId: string | null; cancelReason: string | null;
  /** Owner 2026-10-09 — how the patient is seen. The number travels only on the contact read. */
  mode?: "in_person" | "tele"; telePhone?: string | null;
  /** The desk's money mark on a tele-call (list route only): what it costs, and whether that is met. */
  teleDesk?: { amountPaise: number | null; covered: boolean } | null;
  /** present on the list route, absent on the write routes' bare row */
  patient?: { id?: string; uhid?: string | null; name?: string | null; alias?: string | null; phone?: string | null; administrativeGender?: string | null; dob?: string | null } | null;
};
export type WireCheckIn = {
  encounter: { id: string; visitNo: string; patientId: string; status: string; visitType: MoveVisitType; departmentId: string | null; doctorId: string | null };
  tokenNo: number | null; sessionId: string | null; roomId: string | null; visitType: MoveVisitType;
};

const enc = encodeURIComponent;

/** One key per intent. Not a secret and not a uuid by law — only unique per actor and route (`billing/idempotency.ts`). */
export function newIntentKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  let out = Date.now().toString(16);
  for (let i = 0; i < 24; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

export function counterApi(call: Call) {
  return {
    // ——— the person ———
    search: async (q: string, limit = 8) => (await call<{ items: WirePatientHit[] }>("GET", `/patients/search?q=${enc(q)}&limit=${limit}`)).items,
    verifyCard: (payload: string) => call<WireQrVerify>("POST", "/patients/qr/verify", { payload }),
    register: (body: Record<string, unknown>) => call<WireRegistered>("POST", "/patients", body),
    patient: (patientId: string) => call<WirePatientDetail>("GET", `/patients/${enc(patientId)}`),
    /** "Shares a contact number" — a household read, capped, sealed records filtered by the server. */
    linked: (patientId: string) => call<WireLinked>("GET", `/patients/${enc(patientId)}/linked`),
    timeline: (patientId: string) => call<{ items: CounterTimelineItem[] }>("GET", `/opd/patients/${enc(patientId)}/timeline`),

    // ——— the board ———
    config: () => call<CounterFlow>("GET", "/opd/config"),
    departments: () => call<{ items: WireDepartment[] }>("GET", "/opd/departments"),
    summary: (serviceDate: string) => call<{ items: WireDoctorSummary[] }>("GET", `/opd/queues/summary?serviceDate=${enc(serviceDate)}`),
    doctorUnits: (date: string) => call<WireDoctorUnit[]>("GET", `/roster/doctor-units?date=${enc(date)}`),
    continuity: (patientId: string, departmentId: string) => call<WireContinuity>("GET", `/opd/continuity?patientId=${enc(patientId)}&departmentId=${enc(departmentId)}`),
    consultTerms: () => call<MoveConsultTerms>("GET", "/billing/consult-terms"),

    // ——— the visit ———
    walkIn: (body: { patient: { existingId: string }; departmentId: string; doctorId: string; join: "queue" | "defer"; deskComplaint?: string }, key: string) =>
      call<WireWalkIn>("POST", "/opd/walk-in", body, key),
    /** Idempotent on the server: a replay answers the existing live entry with `alreadyJoined`. */
    joinQueue: (encounterId: string) => call<WireJoin>("POST", `/opd/visits/${enc(encounterId)}/join-queue`),
    movePreview: (encounterId: string, departmentId: string) => call<WireMovePreview>("GET", `/opd/visits/${enc(encounterId)}/move-preview?departmentId=${enc(departmentId)}`),
    move: (encounterId: string, input: { departmentId: string; doctorId: string; reason: string; tenders?: { mode: TenderMode; amountPaise: number; refText?: string }[] }) =>
      call<WireMoveResult>("POST", `/opd/visits/${enc(encounterId)}/move-department`, input),

    // ——— the money ———
    feeQuote: (encounterId: string) => call<WireFeeQuote>("GET", `/billing/visits/${enc(encounterId)}/fee-quote`),
    issue: (body: WireIssueBody, key: string) => call<WireIssued>("POST", "/billing/invoices", body, key),
    cashSession: () => call<{ session: WireCashSession | null }>("GET", "/billing/sessions/current"),
    /** Owner 2026-10-09 — "To collect": visits a desk let through unpaid, until the fee is settled. */
    toCollect: () => call<{ items: import("../../../../packages/contracts/src/to-collect").WireToCollectRow[] }>("GET", "/billing/to-collect"),
    openCashSession: (floatPaise: number) => call<WireCashSession>("POST", "/billing/sessions", { floatPaise }),
    invoices: (encounterId: string) => call<{ items: WireInvoiceRow[] }>("GET", `/billing/invoices?encounterId=${enc(encounterId)}`),

    // ——— appointments. No fee is taken at booking (the web's rule): the visit, and its bill, begin at check-in. ———
    doctors: () => call<{ items: WireMasterDoctor[] }>("GET", "/opd/doctors"),
    rooms: () => call<{ items: WireRoom[] }>("GET", "/opd/rooms"),
    schedules: (doctorId: string) => call<{ items: WireSchedule[] }>("GET", `/opd/doctors/${enc(doctorId)}/schedules`),
    leaves: (doctorId: string, from: string, to: string) => call<{ items: WireLeave[] }>("GET", `/opd/leaves?doctorId=${enc(doctorId)}&from=${enc(from)}&to=${enc(to)}&status=scheduled`),
    slots: (doctorId: string, date: string) => call<{ slots: WireSlot[] }>("GET", `/opd/slots?doctorId=${enc(doctorId)}&date=${enc(date)}`),
    /** Every appointment this patient holds or held — the list the lost-answer re-read settles against. */
    patientAppointments: async (patientId: string) => (await call<{ items: WireAppointment[] }>("GET", `/opd/appointments?patientId=${enc(patientId)}`)).items,
    dayAppointments: async (serviceDate: string) => (await call<{ items: WireAppointment[] }>("GET", `/opd/appointments?serviceDate=${enc(serviceDate)}`)).items,
    /** The one read that carries telephone numbers; the server records each disclosure with its reason. */
    needsRebooking: async () => (await call<{ items: WireAppointment[] }>("GET", "/opd/appointments?needsRebooking=true&contact=true")).items,
    book: (body: { patientId: string; doctorId: string; slotStart: string; note?: string; mode?: "tele"; telePhone?: string }) => call<{ appointment: WireAppointment }>("POST", "/opd/appointments", body),
    reschedule: (appointmentId: string, body: { slotStart: string; doctorId?: string; reason?: string }) =>
      call<{ from: WireAppointment; to: WireAppointment }>("POST", `/opd/appointments/${enc(appointmentId)}/reschedule`, body),
    cancelAppointment: (appointmentId: string, reason: string) => call<{ appointment: WireAppointment }>("POST", `/opd/appointments/${enc(appointmentId)}/cancel`, { reason }),
    /** What a tele-call costs, and — when the hospital has a UPI id — the QR for exactly that amount (rows of 0/1, encoded by the server). */
    teleFee: (appointmentId: string) =>
      call<{ amountPaise: number; covered: boolean; upi: { vpa: string; qr: string[] } | null }>("GET", `/opd/appointments/${enc(appointmentId)}/tele-fee`),
    /** The desk takes a tele-call's fee: one advance receipt for exactly the quote. ONE key per intent. */
    teleAdvance: (appointmentId: string, body: { amountPaise: number; tenders?: { mode: TenderMode; amountPaise: number; refText?: string }[] }, key: string) =>
      call<{ amountPaise: number; receiptNo: string | null }>("POST", `/opd/appointments/${enc(appointmentId)}/advance`, body, key),
    /** An arrival: the booking BECOMES the visit (the walk-in's own answer shape). */
    checkIn: (appointmentId: string) => call<WireCheckIn>("POST", `/opd/appointments/${enc(appointmentId)}/check-in`),

    // ——— the paper (queued by the server inside the visit's own transaction; the phone only asks) ———
    printJobs: (encounterId: string) => call<{ jobs: WirePrintJob[] }>("GET", `/print/jobs?encounterId=${enc(encounterId)}`),
    reprint: (jobId: string) => call<{ id: string | null }>("POST", "/print/reprint", { jobId }),
  };
}
export type CounterApi = ReturnType<typeof counterApi>;
