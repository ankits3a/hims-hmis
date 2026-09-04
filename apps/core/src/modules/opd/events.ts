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
  // VD-1 T1 — `muacCm` APPENDED. A widened enum parses every flag already persisted, and MUAC's
  // zones fit the shape exactly: `bound: "min"` with the limit of the zone actually breached
  // (11.5 for SAM, 12.5 for MAM), so a consumer that knows nothing about malnutrition still
  // renders "below 11.5" correctly.
  vital: z.enum(["sbp", "dbp", "pulse", "rr", "spo2", "tempC", "muacCm"]),
  value: z.number(),
  bound: z.enum(["min", "max"]),
  limit: z.number(),
  /**
   * ═══ VD-1 CLOSE / F1 — A FLAG THE DOCTOR SEES IS NOT ALWAYS A FLAG THE QUEUE OBEYS ═══
   *
   * `danger` is the shipped meaning and stays the default, so every flag already persisted parses
   * unchanged and every existing consumer reads what it always read.
   *
   * `notice` is new and exists for one clinical rule the signed-off design has and this phase had
   * not built: **a paediatric fever is flagged to the doctor AHEAD OF THE CALL without moving the
   * queue.** A 4-year-old at 38.9 °C sits inside the `child_1_5` danger band (max 39.5) and so
   * produced NOTHING at all — no flag, no event, nothing on the doctor's screen — while demo story
   * 6 requires exactly that it reach them early.
   *
   * The distinction is load-bearing rather than cosmetic. Emitting it as a `danger` flag would have
   * been the easy fix and would be WRONG: `danger` sets `opd_queue_entries.danger`, which is queue
   * class 0, and a febrile toddler would then be seated ahead of a stroke. The prototype's own
   * treatment says the same thing in its own idiom — `note(…, "warn")`, never the brick.
   */
  severity: z.enum(["danger", "notice"]).default("danger"),
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
 * transaction (`registerFeeStatusHook`), only when the encounter's consult fee is actually
 * covered per `encounterFeeStatuses` — the one projection, so the flip cannot disagree with the
 * stamp a queue read would compute.
 */
/**
 * RC-3 T3 / D4 — M3 DISCHARGED. RENAMED FROM `queue.fee_settled`, AND THE RENAME HAD A DEADLINE.
 *
 * (Corrected at RC-3's close review, F10: a blanket find-and-replace rewrote this paragraph's own
 * HISTORY, so the docstring read "renamed from `queue.fee_status_changed`" — documenting the rename
 * as a no-op and leaving no way to recover what the old name had been. In a repository whose
 * censuses are text and whose docstrings ARE the contract, a global rename must stop at the prose
 * that describes the thing being renamed.)
 *
 * RC-1 shipped this as `queue.fee_settled` and its own CLOSE carried the defect as a named carry to
 * this phase: **nothing un-flips the board.** `emitFeeSettled` had two call sites, both on the way
 * IN — `invoices.ts` at issue and `receipts.ts` at allocation — while the three writers that move an
 * encounter OUT of settled (`reverseAllocation`, `markEnteredInError`, `issueCreditNote`) reached
 * neither. The derived read self-corrects on refetch, so the stamp was stale in the OPTIMISTIC
 * direction: **PAID still showing after the money had been reversed**, which is the direction that
 * matters.
 *
 * The rename happens NOW because RC-3 is the phase that gives the event its first consumer. An event
 * with no consumers is renamed by editing one file; an event with a board reading it is renamed by
 * migrating a meaning. RC-1's CLOSE said to do it "while it is still unconsumed" and this is the last
 * moment that is true.
 *
 * `status` gains `"unsettled"` and now spans the whole of `EncounterFeeStatus` — the truth function
 * has always had four states while this enum carried three, which is precisely why the hook could
 * not describe a reversal. `via` gains the three ways money leaves.
 */
export const queueFeeStatusChanged = defineEvent("queue.fee_status_changed", MODULE, z.object({
  encounterId: id, patientId: id, ...where,
  status: z.enum(["settled", "credit", "free", "unsettled"]),
  invoiceId: id,
  via: z.enum([
    "invoice", "credit_extended", "allocation",
    "allocation_reversed", "receipt_entered_in_error", "credit_note",
  ]),
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
  // RC-1 CLOSE C1 — a DEFERRED visit abandons with no session and no token, like visit.opened.
  sessionId: z.string().min(1).nullable(),
  tokenNo: z.number().int().positive().nullable(),
  fromState: z.enum(["registered", "waiting", "awaiting_results"]), reason: z.string().min(1),
}));

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-18 — THE DESK CORRECTS A MISREAD VISIT TYPE, IN THE OPEN
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner ruling 2026-09-04, choosing between three ways to build a billing override: *"re-classify
 * the visit, not the price"*, and *"cashier alone, fully audited"*.
 *
 * WHY THAT IS THE RIGHT SHAPE. The failure the owner described — a patient on a revisit being
 * charged — is a CLASSIFICATION that went wrong, not a price that needs adjusting. `classifyVisit`
 * needs the previous consult to be `completed` with a `consultCompletedAt`; when a doctor never
 * closed it properly the anchor does not exist, the visit reads `new`, and the fee follows
 * correctly from a wrong premise. Discounting the fee would paper over that and book the correction
 * as charity, overstating charity by exactly these mistakes forever after. Correcting the premise
 * lets `feeServiceFor` reach the free branch on its own, and the money reporting stays true.
 *
 * THE AUDIT IS THE CONTROL, because the owner ruled the cashier acts alone. With one supervisor in
 * the building an approval gate would strand the patient at the counter — the FD-11 drawer trap,
 * rebuilt. So every correction carries WHO, FROM WHAT, TO WHAT and WHY, and the reason is mandatory.
 */
export const visitReclassified = defineEvent("visit.reclassified", MODULE, z.object({
  encounterId: id, patientId: id,
  /*
    NOT the `...where` envelope the queue events carry. That one answers "which session, room and
    token" — a correction to what KIND of visit this is happens at a counter and has nothing to do
    with where the patient is sitting, and `sessionId`/`tokenNo` would be required and meaningless.
    Department and doctor travel because they are what the classification was made AGAINST, and both
    are nullable on an encounter.
  */
  departmentId: z.string().nullable(),
  doctorId: z.string().nullable(),
  serviceDate: isoDate,
  from: z.enum(["new", "revisit", "renewal"]),
  to: z.enum(["new", "revisit", "renewal"]),
  /** Free text: the clerk is explaining a judgement, and an enum cannot anticipate these. */
  reason: z.string().min(1),
}));

export const vitalsRecorded = defineEvent("vitals.recorded", MODULE, z.object({
  encounterId: id, patientId: id, vitalsId: id, ...where,
  band: z.enum(["infant", "child_1_5", "child_6_12", "adult"]),
  dangerCount: z.number().int().nonnegative(),
  /** F1 — flags the doctor should see that did NOT move the queue. Defaulted for rows written before. */
  noticeCount: z.number().int().nonnegative().default(0),
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
/**
 * ═══ VD-1 T3 — THE DANGER PROTOCOL, AS THREE FACTS ═══
 *
 * They carry the full `where` block, so `opdTopicsFor` routes them to `queue:<doctorId>:<date>`
 * like every other queue fact — which IS the doctor-board flash. An escalation the doctor's
 * screen does not hear about is not an escalation.
 *
 * **These three are also the audit trail, and that is deliberate.** RC-4 owns the `agent_ledger`
 * the footer bar reads, and it does not exist yet; every act the bay's agent takes is a domain
 * fact and belongs on the append-only log this module already writes to. RC-4 projects them.
 * Building a second store here would duplicate the one shared primitive the handoff forbids
 * duplicating — and a trail that can disagree with the record is worse than no trail.
 */
export const vitalsRecheckDemanded = defineEvent("vitals.recheck_demanded", MODULE, z.object({
  encounterId: id, patientId: id, ...where,
  flags: z.array(dangerFlagSchema).min(1),
  /** The arm/site the bay is being told to use. One danger reading demands the OTHER arm, now. */
  demand: z.literal("other_arm_now"),
  /** VD-2 T0 / F4 — the first reading, so the confirm can refuse its own replay. Optional: older rows lack it. */
  reading: z.record(z.string(), z.number()).optional(),
}));

/** VD-2 CLOSE — the other arm was inside the band: the demand is withdrawn, the pair goes to the doctor on the chart. */
export const vitalsRecheckWithdrawn = defineEvent("vitals.recheck_withdrawn", MODULE, z.object({
  encounterId: id, patientId: id, ...where,
  reading: z.record(z.string(), z.number()),
}));

export const queueEscalated = defineEvent("queue.escalated", MODULE, z.object({
  encounterId: id, patientId: id, ...where,
  entryId: id, fromClass: z.number().int().min(0).max(4), toClass: z.literal(0),
  flags: z.array(dangerFlagSchema).min(1),
  /** The instant the ten-second cancel window opened. A stored instant, never a server timer (D8). */
  escalatedAt: iso,
  /** The agent acted alone — the one case the ladder permits (design schema, divergence 3). */
  by: z.literal("agent"),
}));

export const queueEscalationCancelled = defineEvent("queue.escalation_cancelled", MODULE, z.object({
  encounterId: id, patientId: id, ...where,
  entryId: id, restoredClass: z.number().int().min(0).max(4),
  /** How far into the window the cancel landed — the honest measure of whether ten seconds is enough. */
  withinMs: z.number().int().nonnegative(),
}));

/**
 * VD-1 T4 — the bench. Where a patient physically is between arriving at the bay and having her
 * vitals taken: on the rest chairs with a recall time, or stepped out with her turn held. `state`
 * is nullable because coming BACK is the same act as going, and "she is at the bench again" is a
 * fact worth a row rather than an absence of one.
 */
export const benchStateSet = defineEvent("bench.state_set", MODULE, z.object({
  encounterId: id, patientId: id, ...where,
  state: z.enum(["resting", "away"]).nullable(),
  recallAt: iso.nullable(),
  note: z.string().nullable(),
}));

/**
 * VD-1 T5 / D2 — a chart corrected at the bay. The `where` fields are NULLABLE here and nowhere
 * else in this file, and that is deliberate: an amendment can outlive its queue entry — the token
 * is `done`, the patient has left the bench, and the nurse notices the transposed digit afterwards.
 * A required `tokenNo` would make the honest case unrecordable.
 *
 * `changed` is the field-level trail the owner ruled — each corrected value with both numbers —
 * carried on the event as well as derivable from the rows, because this is the payload a
 * supervisor's screen reads without joining anything.
 */
export const vitalsAmended = defineEvent("vitals.amended", MODULE, z.object({
  encounterId: id, patientId: id, vitalsId: id, supersededId: id,
  doctorId: id.nullable(), serviceDate: isoDate, sessionId: id.nullable(),
  roomId: z.string().nullable(), tokenNo: z.number().int().positive().nullable(),
  reason: z.string().min(1),
  changed: z.array(z.object({ field: z.string(), from: z.number().nullable(), to: z.number().nullable() })),
  dangerCount: z.number().int().nonnegative(),
}));

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
