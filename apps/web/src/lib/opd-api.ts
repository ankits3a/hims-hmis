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

/**
 * RC-4 T2/T4 — THE COUNTER FLOW, TWO AXES, MIRRORED FROM `modules/opd/config.ts:98-101`.
 *
 * The web cannot import core, so the enums are restated here and PINNED against the core file read
 * as text by `registration-counter.test.tsx` — the same discipline `SEAT_TENDER_ORDER` uses on
 * `tender-editor.tsx`. The SEQUENCE decides whether a walk-in joins the queue at open (`queue_first`,
 * the shipped behaviour) or after billing (`bill_first`, the deferred join). The TOKEN LANE decides
 * only when the slip leaves the printer and which stamp it wears — allocation never moves with it,
 * and it is meaningful only under `queue_first`. Both are HOSPITAL-WIDE on `opd_config`: one setting
 * for every counter, not one per department.
 */
export const COUNTER_SEQUENCES = ["queue_first", "bill_first"] as const;
export type CounterSequence = (typeof COUNTER_SEQUENCES)[number];
export const TOKEN_LANES = ["token_first", "token_on_payment"] as const;
export type TokenLane = (typeof TOKEN_LANES)[number];
export type WireCounterFlow = { counterSequence: CounterSequence; tokenLane: TokenLane };

export type WireOpdConfig = WireCounterFlow & {
  slotMinutes: number; followUpDefaultDays: number; followUpExtensionDays: number[];
  extensionCapPerDoctorPerMonth: number; maxSkipsBeforeLeft: number; perkEveryNth: number | null;
  dangerRanges: unknown; letterhead: { name: string; addressLines: string[] };
};

export function getOpdConfig(): Promise<WireOpdConfig> {
  return api("GET", "/opd/config");
}

/**
 * RC-4 T4 — the flow pill's own write. `PUT /opd/config/counter-flow` takes EXACTLY these two keys
 * (`counterFlowBody` strips everything else), under `opd.counter.flow.manage` — narrower than the
 * config editor's permission on purpose, so the body here must never be widened toward
 * `WireOpdConfig`: a supervisor holding only the pill must not reach danger ranges through it.
 */
export function putCounterFlow(body: Partial<WireCounterFlow>): Promise<WireOpdConfig> {
  return api("PUT", "/opd/config/counter-flow", body);
}

// ——— patients, as the OPD module is allowed to see them (§14 / D-37) ———

export type WirePatientSummary = {
  requestedId: string; id: string; uhid: string; name: string | null; alias: string | null;
  restricted: boolean; administrativeGender: string; dob: string | null;
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
  /**
   * RC-4 T3 — THE PAID STAMP, AND IT WAS ALREADY ON THE WIRE. **Third time this series.**
   *
   * MEASURED before writing anything, because the phase doc told this task to: core's
   * `QueueEntryView` has carried `feeStatus` since RC-1 T3 (`opd/queue.ts:56`), `listQueue` fills it
   * from `encounterFeeStatuses` (`:92`), and `opd-queue.controller.ts:148` returns the result with
   * **no serializer between**. Two web screens have read that route the whole time and neither type
   * declared the field — so **no core change was needed here either**, exactly as with RC-3 T4's
   * `avgConsultMinutes` and `matchedOn` before it.
   *
   * `null` is a real value and not an absence: it means the encounter has no fee status to report,
   * which is different from `"unsettled"`. A consumer that treats `null` as unpaid would stamp
   * UNPAID on a row the server declined to characterise.
   *
   * DERIVED, NEVER STORED — which is why RC-3 T3 could make the event flip BOTH ways and why a
   * client must never recompute paid-ness from an invoice. `encounterFeeStatuses` is the one
   * projection; a second truth function is a board that can disagree with the gate.
   */
  feeStatus: "free" | "settled" | "credit" | "unsettled" | null;
};

/**
 * PLAN 07d T5 / DD4 — one advised test. The price is a SNAPSHOT taken when the doctor advised it,
 * never a live lookup: the slip is a quotation from a particular afternoon and the counter reprices.
 */
export type WireAdvisedTest = { serviceId: string; code: string; name: string; pricePaise: number };

/** PLAN 07d T5 — `GET /tariff/price-list`: the active version's list price per active service. */
export type WirePriceListRow = {
  serviceId: string; code: string; name: string; category: string; pricePaise: number;
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
  /**
   * RC-3 T4 / D7 — the wait model's pace term, and it was ALREADY ON THE WIRE.
   *
   * MEASURED before writing anything, because the phase doc told this task to: RC-1 T5 put
   * `avgConsultMinutes` on `DoctorSummary` (`opd/queue.ts:252`), `summaryByDoctor` batches the
   * department read and fills it (`queue.ts:293-306`), and `opd-queue.controller.ts:109` returns
   * `DoctorSummary[]` with no serializer between. So `GET /opd/queues/summary` has been sending
   * this number since RC-1 and **the web type was the only thing that could not see it** — no
   * core change was needed for the wait model, only a type that stopped being narrower than its
   * producer. That is the eight-rails finding of §1 in its smallest possible form.
   *
   * REQUIRED, not optional: the column is `NOT NULL DEFAULT 6` (`0048_counter_flow.sql`) and the
   * mapper falls back to 6 for a department it could not read, so every row the server emits
   * carries a number. Declaring it optional would let a consumer write `?? 6` and quietly reinvent
   * the fallback in a second place.
   */
  avgConsultMinutes: number;
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

// VD-1 T1 — `muacCm` appended, because the SERVER can now emit it: a supplied MUAC under six is
// flagged at the zone it breached (11.5 SAM, 12.5 MAM). Widened here in the same task that made
// the server able to send it — a wire union narrower than its producer is a type that lies, and it
// lies silently until the first child is measured.
// VD-1 CLOSE / F1 — `severity` appended for the same reason `muacCm` was in T1: the SERVER can now
// emit it, and a wire union narrower than its producer is a type that lies until the first case
// arrives. `danger` moves the queue; `notice` reaches the doctor and does not — a paediatric fever
// is flagged ahead of the call without seating a toddler ahead of a stroke. Optional so every flag
// already persisted reads back unchanged; absent means `danger`, which is the shipped meaning.
export type WireDangerFlag = { vital: "sbp" | "dbp" | "pulse" | "rr" | "spo2" | "tempC" | "muacCm"; value: number; bound: "min" | "max"; limit: number; severity?: "danger" | "notice" };

export type WireVitals = {
  id: string; encounterId: string; patientId: string;
  heightCm: number | null; weightKg: number | null; sbp: number | null; dbp: number | null;
  pulse: number | null; rr: number | null; spo2: number | null; tempC: number | null;
  muacCm: number | null; notes: string | null;
  ageYearsAtRecord: number | null; band: "infant" | "child_1_5" | "child_6_12" | "adult";
  dangerFlags: WireDangerFlag[]; recordedBy: string; recordedAt: string;
  /**
   * VD-1 T1 / D1 — the reading beside the scalars. The scalars above carry the OPERATIVE take and
   * every shipped consumer keeps reading them; this is where the pair, the source and the values
   * a sanity gate held out of the chart live. `unknown` until VD-2 renders it — a wire type that
   * guesses at a shape nobody reads yet is a type that will be wrong by the time somebody does.
   */
  readings: unknown; contextChips: unknown; carriedForward: string[];
  supersedesVitalsId: string | null; amendmentReason: string | null;
  status: "active" | "superseded"; emergency: boolean;
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
  patient: { uhid: string; name: string | null; alias: string | null; restricted: boolean; ageYears: number | null; administrativeGender: string };
  doctor: { displayName: string; registrationNo: string | null; departmentName: string | null };
  encounter: {
    id: string; visitNo: string; serviceDate: string; diagnosis: string | null; icd10Code: string | null;
    advice: string | null; followUpDays: number | null; chiefComplaint: string | null;
    /** PLAN 07d T5 — advised tests with the price AS OF the service date (DD4, E-9). */
    advisedTests: WireAdvisedTest[];
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

/**
 * PLAN 07b T6/T3 — THE WALK-IN, AS ONE CALL.
 *
 * The counter used to make this journey out of several requests the browser sequenced itself, which
 * is how a patient ended up registered with no visit when one of them failed. `POST /opd/walk-in`
 * registers-or-attaches AND opens the visit in one transaction; the idempotency key is what makes a
 * retry after a timeout safe, and it is minted in ONE place so thirteen call sites cannot forget it.
 */
export type WireWalkInPatient = { existingId: string } | { register: Record<string, unknown> };

export type WireWalkInBody = {
  patient: WireWalkInPatient;
  departmentId: string;
  doctorId: string;
  intendedPayer?: string;
  referralSource?: string;
  referrerName?: string;
  acknowledgedDuplicates?: boolean;
  /** RC-1 CLOSE M2 — bill-first defers the queue join; a caller that sends "defer" reads WireWalkInDeferredResult. */
  join?: "queue" | "defer";
};

export type WireWalkInResult = WireOpenVisitResult & { patientId: string; registered: boolean };
/**
 * RC-1 CLOSE M2 — what `join: "defer"` (bill-first, RC-3's flow) returns: NULL token/session/
 * entry until POST /opd/visits/:id/join-queue fills them. The shipped counter never sends `join`,
 * so WireWalkInResult stays true for it; a caller that defers MUST read this shape instead.
 */
export type WireWalkInDeferredResult = Omit<WireOpenVisitResult, "queueEntry" | "tokenNo" | "sessionId"> & {
  queueEntry: null; tokenNo: null; sessionId: null; patientId: string; registered: boolean;
};

/** The near-matches a refused registration comes back with (`duplicate_suspected`). */
export type WireDuplicateCandidate = { id: string; uhid: string; name: string | null };

/**
 * RC-4 T2 — the overloads say which shape comes back, so a bill-first caller cannot read `tokenNo`
 * as a number: it is `null` until `joinQueue` fills it, and the type now says so at the call site.
 */
export function walkIn(body: WireWalkInBody & { join: "defer" }, idempotencyKey: string): Promise<WireWalkInDeferredResult>;
export function walkIn(body: WireWalkInBody & { join?: "queue" }, idempotencyKey: string): Promise<WireWalkInResult>;
export function walkIn(body: WireWalkInBody, idempotencyKey: string): Promise<WireWalkInResult | WireWalkInDeferredResult>;
export function walkIn(body: WireWalkInBody, idempotencyKey: string): Promise<WireWalkInResult | WireWalkInDeferredResult> {
  return api("POST", "/opd/walk-in", body, idempotencyKey);
}

/**
 * RC-4 T2 — THE SECOND HALF OF A BILL-FIRST WALK-IN, and the first consumer of a route RC-1 wrote.
 *
 * `POST /opd/visits/:id/join-queue` (`encounters.ts:joinQueue`) has NO settlement gate, and that is
 * correct rather than a hole: the PAID stamp is DERIVED from `encounterFeeStatuses`, never stored,
 * so a token joined after payment reads PAID and one joined before reads UNPAID — both truthfully.
 * The discipline of "the token leaves the printer already PAID" therefore lives entirely in WHEN
 * the client calls this, which is `shouldJoinNow` in the seat. Idempotent: a replay answers the
 * existing live entry with `alreadyJoined: true`.
 */
export type WireJoinQueueResult = {
  encounter: WireEncounter; queueEntry: WireQueueEntry; tokenNo: number; sessionId: string;
  roomId: string | null; alreadyJoined: boolean;
};

export function joinQueue(encounterId: string): Promise<WireJoinQueueResult> {
  return api("POST", `/opd/visits/${encodeURIComponent(encounterId)}/join-queue`);
}

/**
 * PLAN 07d T1 — the two cross-visit histories. `lines` is the prescription writer's persisted shape
 * read back verbatim; the reader does not reinterpret it, which is why the fields are optional here
 * rather than restated as a second, drifting copy of `RxLine`.
 */
export type WireRxHistoryLine = {
  drug: string;
  dose: string | null;
  route: string | null;
  frequency: string | null;
  durationDays: number | null;
  instructions: string | null;
};

export type WireRxHistoryItem = {
  prescriptionId: string;
  encounterId: string;
  serviceDate: string;
  issuedAt: string;
  doctorId: string | null;
  doctorName: string | null;
  status: string;
  version: number;
  lines: WireRxHistoryLine[];
};

export type WireVitalsHistoryItem = {
  vitalsId: string;
  encounterId: string;
  serviceDate: string;
  recordedAt: string;
  sbp: number | null;
  dbp: number | null;
  pulse: number | null;
  rr: number | null;
  spo2: number | null;
  tempC: number | null;
  band: string;
  dangerFlags: unknown[];
};

// ——— VD-2 T1 — the bench, the pre-stage reader, and the escalation state, on the wire ———
/**
 * VD-1 shipped these three shapes on the server (`bench.ts:46`, `prestage.ts:49`,
 * `escalation.ts:71`) and NO web type declared them — the `feeStatus` / `avgConsultMinutes` /
 * `matchedOn` finding for the fourth time. Declared here in the PR of the screen that reads them,
 * so a rail and its consumer cannot drift apart again. Dates arrive as ISO strings.
 */
export type WireBenchState = "resting" | "away";
export type WireEscalationState = "none" | "recheck_demanded" | "escalated" | "cancelled";
export type WireBenchRow = {
  encounterId: string; entryId: string; tokenNo: number; seq: number;
  doctorId: string; doctorName: string; serviceDate: string;
  patient: WirePatientSummary | null;
  benchState: WireBenchState | null;
  recallAt: string | null;
  vitalsDone: boolean;
  vitalsId: string | null;
  escalation: WireEscalationState;
  cancelMsRemaining: number;
  recallDue: boolean;
};
export function fetchBench(filter: { departmentId?: string; doctorId?: string; serviceDate: string }): Promise<{ items: WireBenchRow[] }> {
  const qs = new URLSearchParams({ serviceDate: filter.serviceDate });
  if (filter.departmentId !== undefined) qs.set("departmentId", filter.departmentId);
  if (filter.doctorId !== undefined) qs.set("doctorId", filter.doctorId);
  return api("GET", `/opd/bench?${qs.toString()}`);
}

export type WireVitalKey = "heightCm" | "weightKg" | "sbp" | "dbp" | "pulse" | "rr" | "spo2" | "tempC" | "muacCm";
export type WireBandKey = "infant" | "child_1_5" | "child_6_12" | "adult";
export type WirePreStage = {
  patientId: string;
  ageYears: number | null;
  band: WireBandKey;
  required: WireVitalKey[];
  notRoutine: WireVitalKey[];
  last: {
    vitalsId: string; recordedAt: string; serviceDate: string;
    heightCm: number | null; weightKg: number | null; sbp: number | null; dbp: number | null;
    pulse: number | null; rr: number | null; spo2: number | null; tempC: number | null; muacCm: number | null;
  } | null;
  carryCandidates: WireVitalKey[];
  expectedFlags: WireDangerFlag[];
};
/** `opd.vitals.history.read` — the last chart, the band and the carry candidates, nothing else (VD-1 D6). */
export function fetchPreStage(encounterId: string): Promise<WirePreStage> {
  return api("GET", `/opd/visits/${encodeURIComponent(encounterId)}/prestage`);
}

// ——— VD-2 T2 — the capture body, the save result, and the danger-range config the tiles mirror ———
export type WireRange = { min?: number; max?: number };
export type WireBandConfig = {
  key: WireBandKey; upToAgeYears: number | null;
  required: WireVitalKey[]; notRoutine: WireVitalKey[];
  ranges: Partial<Record<WireVitalKey, WireRange>>;
  noticeRanges: Partial<Record<WireVitalKey, WireRange>>;
};
/** `GET /opd/config`'s `dangerRanges`, typed at last — the bay's client-side mirrors read it; the server stays the authority. */
export type WireDangerRanges = {
  weightRequiredUnderYears: number;
  bands: WireBandConfig[];
  gates: { adultWeightFloorKg: number; heightDeltaCm: number; spo2ProbeFloorPct: number };
  muacBands: { samUnderCm: number; mamUnderCm: number };
};
export type WireReadingSource = "typed" | "device" | "counted";
export type WireReading = { takes: number[]; source: WireReadingSource; held?: number[]; note?: string };
export type WireBpReading = { takes: [number, number][]; source: WireReadingSource; held?: number[]; note?: string };
export type WireReadings = Partial<Record<Exclude<WireVitalKey, "sbp" | "dbp">, WireReading>> & { bp?: WireBpReading };
export const UNLOCK_REASONS = ["yearly_remeasure_due", "patient_disputes_old_value", "posture_or_device_changed", "surgical_or_limb_change"] as const;
export type WireUnlockReason = (typeof UNLOCK_REASONS)[number];
export type WireVitalsPostBody = Partial<Record<WireVitalKey, number | null>> & {
  notes?: string | null;
  readings?: WireReadings;
  contextChips?: { key: string; question: string; answer: string }[];
  carriedForward?: WireVitalKey[];
  emergency?: boolean;
  overrides?: Partial<Record<WireVitalKey, string>>;
  unlockReasons?: Partial<Record<WireVitalKey, WireUnlockReason>>;
};
export type WireVitalsGate = { key: WireVitalKey; kind: "slipped_digit" | "shrinking_adult" | "probe_error"; value: number; suggestion?: number; message: string };
export type WireVitalsSaveResult = { vitals: WireVitals; flags: WireDangerFlag[]; encounter: WireEncounter };
export function postVitals(encounterId: string, body: WireVitalsPostBody): Promise<WireVitalsSaveResult> {
  return api("POST", `/opd/visits/${encodeURIComponent(encounterId)}/vitals`, body);
}
