import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * The OPD module's complete event surface (Plan 07): seventeen §10.6 P1 names plus qr.signature_failed
 * (Plan 05's name and grammar, for e-Rx scans). queue.called, queue.skipped and visit.abandoned are catalog
 * ADDITIONS ratified by the owner on 2026-08-15 (the written catalog omitted the queue-call facts §11.1
 * describes). module "opd" on every one. Nothing else in this module emits.
 */
const MODULE = "opd";
const id = z.string().min(1);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/); // IST calendar date
const iso = z.string().min(1); // ISO instant

/** Doctor-day location fields — the realtime router topics on these. roomId is null when the doctor-day has no template room. */
const where = {
  doctorId: id,
  serviceDate: isoDate,
  sessionId: id,
  roomId: z.string().nullable(),
  tokenNo: z.number().int().positive(),
};

export const dangerFlagSchema = z.object({
  vital: z.enum(["sbp", "dbp", "pulse", "rr", "spo2", "tempC"]),
  value: z.number(),
  bound: z.enum(["min", "max"]),
  limit: z.number(),
});
export type DangerFlag = z.infer<typeof dangerFlagSchema>;

export const appointmentBooked = defineEvent("appointment.booked", MODULE, z.object({
  appointmentId: id, patientId: id, doctorId: id, departmentId: id, serviceDate: isoDate, slotStart: iso,
  source: z.enum(["desk", "phone"]),
}));

export const appointmentRescheduled = defineEvent("appointment.rescheduled", MODULE, z.object({
  fromAppointmentId: id, toAppointmentId: id, patientId: id, doctorId: id, departmentId: id,
  serviceDate: isoDate, slotStart: iso, previousDoctorId: id, previousSlotStart: iso,
}));

export const appointmentCancelled = defineEvent("appointment.cancelled", MODULE, z.object({
  appointmentId: id, patientId: id, doctorId: id, serviceDate: isoDate, slotStart: iso, reason: z.string().min(1),
}));

export const appointmentNoShow = defineEvent("appointment.no_show", MODULE, z.object({
  appointmentId: id, patientId: id, doctorId: id, serviceDate: isoDate, slotStart: iso,
}));

export const doctorLeaveScheduled = defineEvent("doctor_leave.scheduled", MODULE, z.object({
  leaveId: id, doctorId: id, fromDate: isoDate, toDate: isoDate, reason: z.string().min(1),
  affectedAppointmentIds: z.array(id), // marked needs_rebooking in the same transaction (§11.5 cascade)
}));

export const visitOpened = defineEvent("visit.opened", MODULE, z.object({
  encounterId: id, patientId: id, departmentId: id, ...where,
  // RC-1 T3 / D4 — a bill-first open has no queue join yet: null session/token means DEFERRED,
  // and `patient.checked_in` carries the real token when the join happens. Every queue-first
  // open still writes both, so nothing that reads the shipped shape loses a value it had.
  sessionId: z.string().min(1).nullable(),
  tokenNo: z.number().int().positive().nullable(),
  visitType: z.enum(["new", "revisit", "renewal"]),
  intendedPayer: z.enum(["self", "tpa", "pmjay", "corporate"]),
  kind: z.enum(["walk_in", "appointment"]),
  appointmentId: z.string().nullable(),
}));

/**
 * RC-1 T3 / D2 — the board flip. Appended by the OPD hook billing calls inside the settling
 * transaction (`registerFeeSettledHook`), only when the encounter's consult fee is actually
 * covered per `encounterFeeStatuses` — the one projection, so the flip cannot disagree with the
 * stamp a queue read would compute.
 */
export const queueFeeSettled = defineEvent("queue.fee_settled", MODULE, z.object({
  encounterId: id, patientId: id, ...where,
  status: z.enum(["settled", "credit", "free"]),
  invoiceId: id,
  via: z.enum(["invoice", "credit_extended", "allocation"]),
}));

export const patientCheckedIn = defineEvent("patient.checked_in", MODULE, z.object({
  encounterId: id, patientId: id, ...where,
  kind: z.enum(["arrival", "re_entry"]), // family lifecycle, type in payload (§10.5)
}));

export const visitTransferred = defineEvent("visit.transferred", MODULE, z.object({
  encounterId: id, patientId: id, serviceDate: isoDate,
  fromDoctorId: id, toDoctorId: id, fromSessionId: id, toSessionId: id,
  roomId: z.string().nullable(), tokenNo: z.number().int().positive(), // the NEW token in the target session
  consented: z.boolean(), reason: z.string().min(1),
}));

export const visitAbandoned = defineEvent("visit.abandoned", MODULE, z.object({
  encounterId: id, patientId: id, ...where,
  fromState: z.enum(["registered", "waiting", "awaiting_results"]), reason: z.string().min(1),
}));

export const vitalsRecorded = defineEvent("vitals.recorded", MODULE, z.object({
  encounterId: id, patientId: id, vitalsId: id, ...where,
  band: z.enum(["infant", "child_1_5", "child_6_12", "adult"]),
  dangerCount: z.number().int().nonnegative(),
}));

export const vitalsDangerFlagged = defineEvent("vitals.danger_flagged", MODULE, z.object({
  encounterId: id, patientId: id, vitalsId: id, ...where,
  flags: z.array(dangerFlagSchema).min(1),
}));

/**
 * PLAN 07c T6 — THE DOCTOR-DAY OPENING AND CLOSING, WHICH NOTHING EMITTED BEFORE.
 *
 * `setSessionStatus` was the only writer of `opd_queue_sessions.status` and it appended NO event,
 * so the single most useful thing a supervisor's desk can show — a session opened late, with no
 * delay declared — could not be computed from anything. It is not a missing audit trail so much as
 * a missing ALARM: a queue that was never opened raises no waiting alert, because nobody is waiting
 * on a queue that does not exist.
 *
 * They carry the full `where` block so `opdTopicsFor` routes them to `queue:<doctorId>:<date>` like
 * every other queue fact — minus `tokenNo`, which a session has none of. `scheduledStart` is the
 * template's own start time when the doctor-day has a schedule, so a consumer can compute lateness
 * without a second query; null when the doctor is unscheduled, where "late" has no meaning.
 */
export const queueSessionOpened = defineEvent("queue_session.opened", MODULE, z.object({
  sessionId: id, doctorId: id, serviceDate: isoDate, roomId: z.string().nullable(),
  openedAt: iso, scheduledStart: z.string().nullable(),
}));

export const queueSessionClosed = defineEvent("queue_session.closed", MODULE, z.object({
  sessionId: id, doctorId: id, serviceDate: isoDate, roomId: z.string().nullable(),
  closedAt: iso, seen: z.number().int().nonnegative(),
}));

export const queueCalled = defineEvent("queue.called", MODULE, z.object({
  encounterId: id, patientId: id, entryId: id, ...where,
  callCount: z.number().int().positive(),
}));

export const queueSkipped = defineEvent("queue.skipped", MODULE, z.object({
  encounterId: id, patientId: id, entryId: id, ...where,
  skips: z.number().int().positive(),
  left: z.boolean(), // true when max_skips_before_left was reached and the entry left the queue
}));

export const consultationStarted = defineEvent("consultation.started", MODULE, z.object({
  encounterId: id, patientId: id, departmentId: id, ...where,
}));

export const consultationCompleted = defineEvent("consultation.completed", MODULE, z.object({
  encounterId: id, patientId: id, departmentId: id, ...where,
  visitType: z.enum(["new", "revisit", "renewal"]),
  followUpDays: z.number().int().positive(),
  followUpExtended: z.boolean(), // §11.19-C fix 14: each extension is evented; the pattern report derives from this
  admissionAdvised: z.boolean(),
  referralIssued: z.boolean(),
  prescriptionCount: z.number().int().nonnegative(),
  icd10Code: z.string().nullable(),
}));

export const prescriptionIssued = defineEvent("prescription.issued", MODULE, z.object({
  prescriptionId: id, encounterId: id, patientId: id, doctorId: id,
  version: z.number().int().positive(), lineCount: z.number().int().positive(),
  allergyOverrideCount: z.number().int().nonnegative(), // the S10 override-rate KPI numerator
  /**
   * PLAN 16a T5 — two more numerators beside it, and `allergyOverrideCount` is UNTOUCHED so every
   * shipped reader of this payload keeps working. Separate counts rather than one total because
   * §1.4's calibration loop asks a per-KIND question: a severe interaction pair overridden 95% of
   * the time is mis-graded and needs a curator, while a duplicate override at the same rate means
   * something quite different about how refills are being written.
   */
  interactionOverrideCount: z.number().int().nonnegative().default(0),
  duplicateOverrideCount: z.number().int().nonnegative().default(0),
}));

export const referralIssued = defineEvent("referral.issued", MODULE, z.object({
  encounterId: id, patientId: id, doctorId: id, referralTo: z.string().min(1), note: z.string().nullable(),
}));

/** IPD-phase stub: records the intent only. Bed/admission machinery is rollout stage 4. */
export const admissionRequested = defineEvent("admission.requested", MODULE, z.object({
  encounterId: id, patientId: id, doctorId: id, departmentId: id, note: z.string().nullable(),
}));

/** Same catalog name and grammar as modules/patients (D-23) — the subject here is an e-Rx QR. */
export const rxQrSignatureFailed = defineEvent("qr.signature_failed", MODULE, z.object({
  reason: z.enum(["malformed", "invalid_signature", "stale_version", "unknown_prescription"]),
  payloadPrefix: z.string(),
  patientId: z.string().optional(), // only when the signature verified
}));
