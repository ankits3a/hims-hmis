import { withTx } from "../db/client";
import { escalationTriggered } from "../workflow/events";
import { usersHoldingRole } from "../workflow/roles";
import { appointmentBooked, appointmentCancelled, appointmentRescheduled } from "../../modules/opd/events";
import { patientRegistered } from "../../modules/patients/events";
import { enqueueNotification, expireByRef } from "./enqueue";
import type { Db, Tx } from "../db/client";
import type { DispatchedEvent, Handler } from "../events/subscriptions";

/** The consumer key `notifyManifest` declares and the worker's consumers map is keyed by (D13). */
export const NOTIFY_CONSUMER = "kernel.notify";

/**
 * The last rung of fix 11's ladder, and the role `alertsConsumer` already fans the in-app alert
 * to (`alerts/consumer.ts:20`). Its comment at :18 books the owner-SMS half for this plan; this
 * file is where that promise is kept.
 */
export const OWNER_ROLE = "owner";

/** D13's expire-by-ref handle: a booking's confirmation and its reminder both carry it. */
const APPOINTMENT_REF_TYPE = "appointment";

const HOUR_MS = 60 * 60 * 1000;
/** D13: the reminder goes out 24 h before the slot. */
const REMINDER_LEAD_MS = 24 * HOUR_MS;
/** D13: and only if that instant is still at least an hour ahead of the EVENT's own time. */
const MIN_REMINDER_NOTICE_MS = 1 * HOUR_MS;

const PATIENT_WELCOME = "patient_welcome";
const APPOINTMENT_CONFIRMED = "appointment_confirmed";
const APPOINTMENT_REMINDER = "appointment_reminder";
const STAFF_ESCALATION = "staff_escalation";
const OWNER_ESCALATION_SMS = "owner_escalation_sms";

/**
 * The at-least-once guard, in one place (GC15/N6). The EVENT's id is the first component, so a
 * redelivery of the same event re-computes the same key and `ON CONFLICT DO NOTHING` inserts
 * nothing; the template key and the recipient are the other two, so ONE event fanning to two
 * templates or to five owners produces five distinct keys rather than one row that silently caps
 * the fan-out at its first recipient.
 */
const dedupeKeyFor = (eventId: string, templateKey: string, recipientId: string): string =>
  `n:${eventId}:${templateKey}:${recipientId}`;

/**
 * `kernel.notify` (D13): five subscriptions, and the handler ENQUEUES AND DOES NOTHING ELSE.
 *
 * WHAT IS DELIBERATELY NOT HERE: rendering, contact lookup, quiet hours, the channel ladder,
 * deceased suppression, opt-in. All of it is the pump's, at SEND time, from contact truth that
 * does not exist yet at enqueue (D4) — so this handler has almost no surface on which to throw,
 * which matters because a throw here blocks this consumer's queue for ~30 s and then parks the
 * event (08.5's measured dispatcher behaviour).
 *
 * EVERY SCHEDULING DECISION READS `e.occurredAt`, NEVER THE WALL CLOCK (D5). That is the whole
 * replay defense and it is why `DispatchedEvent` was widened for this task: a booking replayed
 * next month must compute the same reminder instant and the same expiry it computed the first
 * time, so the pump expires it instead of messaging a patient about an appointment that is over.
 * A wall-clock read here would silently turn every replay into a fresh, live message.
 *
 * ONE TRANSACTION PER EVENT, not one per enqueue. `enqueueNotification` is `Tx`-typed precisely
 * so a caller can make its whole unit atomic, and a reschedule's expire-then-enqueue pair IS one
 * unit: a crash between the halves would leave the old slot's confirmation live beside the new
 * slot's. This differs from `alertsConsumer`'s per-recipient transaction on purpose — that one
 * fans to an unbounded roster of humans and wants partial progress; this one writes at most
 * three rows for an appointment, and its fan-outs are role holders (single digits).
 */
export function notifyConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    await withTx(db, async (tx) => {
      switch (e.name) {
        case patientRegistered.name:
          return handlePatientRegistered(tx, e);
        case appointmentBooked.name:
          return handleAppointmentBooked(tx, e);
        case appointmentRescheduled.name:
          return handleAppointmentRescheduled(tx, e);
        case appointmentCancelled.name:
          return handleAppointmentCancelled(tx, e);
        case escalationTriggered.name:
          return handleEscalationTriggered(tx, e);
        default:
          // Amendment 6 makes the reverse case — a declaration with no handler — a BOOT error.
          // This is the other direction and boot cannot catch it: the bus only routes what
          // `notifyManifest` declared, so an event arriving here that no branch serves means the
          // two halves have drifted. Fail loudly rather than drop the message.
          throw new Error(
            `notify consumer: no branch for event "${e.name}" — notifyManifest declares a ` +
              `subscription this handler does not serve`,
          );
      }
    });
  };
}

/**
 * D13 row 1. `params` carries ONLY what `patient_welcome` interpolates — the UHID. The event's
 * payload also holds the patient's NAME and PHONE and neither is copied: the outbox stores no
 * contact truth (D4), and the template renders no name (D8).
 */
async function handlePatientRegistered(tx: Tx, e: DispatchedEvent): Promise<void> {
  const payload = patientRegistered.payloadSchema.parse(e.payload);
  await enqueueNotification(tx, {
    templateKey: PATIENT_WELCOME,
    params: { uhid: payload.uhid },
    dedupeKey: dedupeKeyFor(e.eventId, PATIENT_WELCOME, payload.patientId),
    occurredAt: e.occurredAt,
    patientId: payload.patientId,
    sourceEventId: e.eventId,
  });
}

/**
 * D13 rows 2 and 3's shared half: the confirmation now, and the reminder at `slotStart − 24 h`
 * IF that instant is still at least an hour ahead of the event. Both carry the
 * (`appointment`, appointmentId) ref, which is the handle a cancellation or a reschedule uses to
 * expire them — a confirmation with no ref would outlive the appointment it confirms.
 *
 * THE NOTICE WINDOW IS MEASURED FROM `e.occurredAt`, NOT FROM NOW (D5). A booking made two hours
 * before its slot has no 24-hour reminder to give, and neither does the same booking replayed a
 * month later: the answer must not depend on when the worker got to it.
 */
async function enqueueForSlot(
  tx: Tx,
  e: DispatchedEvent,
  slot: { patientId: string; appointmentId: string; serviceDate: string; slotStart: string },
): Promise<void> {
  const params = { serviceDate: slot.serviceDate, slotStart: slot.slotStart };

  await enqueueNotification(tx, {
    templateKey: APPOINTMENT_CONFIRMED,
    params,
    dedupeKey: dedupeKeyFor(e.eventId, APPOINTMENT_CONFIRMED, slot.patientId),
    occurredAt: e.occurredAt,
    patientId: slot.patientId,
    sourceEventId: e.eventId,
    refType: APPOINTMENT_REF_TYPE,
    refId: slot.appointmentId,
  });

  const remindAt = new Date(new Date(slot.slotStart).getTime() - REMINDER_LEAD_MS);
  if (remindAt.getTime() - e.occurredAt.getTime() < MIN_REMINDER_NOTICE_MS) return;

  await enqueueNotification(tx, {
    templateKey: APPOINTMENT_REMINDER,
    params,
    dedupeKey: dedupeKeyFor(e.eventId, APPOINTMENT_REMINDER, slot.patientId),
    occurredAt: e.occurredAt,
    patientId: slot.patientId,
    sourceEventId: e.eventId,
    refType: APPOINTMENT_REF_TYPE,
    refId: slot.appointmentId,
    scheduledFor: remindAt,
  });
}

/** D13 row 2. */
async function handleAppointmentBooked(tx: Tx, e: DispatchedEvent): Promise<void> {
  const payload = appointmentBooked.payloadSchema.parse(e.payload);
  await enqueueForSlot(tx, e, {
    patientId: payload.patientId,
    appointmentId: payload.appointmentId,
    serviceDate: payload.serviceDate,
    slotStart: payload.slotStart,
  });
}

/**
 * D13 row 3: expire what the OLD appointment id still has queued, then enqueue the pair for the
 * new one. `expireByRef` is a conditional UPDATE over `status='queued'` rows only, so a
 * confirmation already `sending` or `sent` is never touched — it cannot be un-sent, and
 * pretending otherwise is how a patient is told about a slot they have already been messaged for.
 */
async function handleAppointmentRescheduled(tx: Tx, e: DispatchedEvent): Promise<void> {
  const payload = appointmentRescheduled.payloadSchema.parse(e.payload);
  await expireByRef(tx, APPOINTMENT_REF_TYPE, payload.fromAppointmentId, e.occurredAt);
  await enqueueForSlot(tx, e, {
    patientId: payload.patientId,
    appointmentId: payload.toAppointmentId,
    serviceDate: payload.serviceDate,
    slotStart: payload.slotStart,
  });
}

/** D13 row 4: expire only. There is no "your appointment was cancelled" template in this plan. */
async function handleAppointmentCancelled(tx: Tx, e: DispatchedEvent): Promise<void> {
  const payload = appointmentCancelled.payloadSchema.parse(e.payload);
  await expireByRef(tx, APPOINTMENT_REF_TYPE, payload.appointmentId, e.occurredAt);
}

/**
 * D13 row 5, and the owner-SMS half of fix 11 that `alerts/consumer.ts:18` has been promising.
 *
 * `params` IS EXACTLY THE FOUR STRUCTURAL FIELDS — defKey, state, rung, role — AND THAT IS AN
 * ASSERTION, NOT A CONVENTION (GC5, Assertion Book N10, 08.5's L8/M-A2 mutant class).
 * `e.patientId` is right there on the argument and the wrong implementation is ONE PROPERTY
 * ACCESS away: these params are rendered into a message that leaves the building on somebody
 * else's phone, and a staff or owner body may carry no patient identity at all. The recipient
 * reaches the patient through permission-checked routes, never through an SMS.
 *
 * `enqueueNotification` also REFUSES a `patientId` argument on a staff/owner-audience template,
 * so the leak has a second gate below this one — but a gate is not an assertion, and N10 asserts
 * the params object WHOLE so that an added field of any name fails.
 */
async function handleEscalationTriggered(tx: Tx, e: DispatchedEvent): Promise<void> {
  const payload = escalationTriggered.payloadSchema.parse(e.payload);
  const params = {
    defKey: payload.defKey,
    state: payload.state,
    rung: payload.rung,
    role: payload.role,
  };

  for (const userId of payload.resolvedUserIds) {
    await enqueueNotification(tx, {
      templateKey: STAFF_ESCALATION,
      params,
      dedupeKey: dedupeKeyFor(e.eventId, STAFF_ESCALATION, userId),
      occurredAt: e.occurredAt,
      userId,
      sourceEventId: e.eventId,
    });
  }

  // `fallbackExhausted` means the rung role resolved to nobody AND duty_manager resolved to
  // nobody (§11.19-C fix 11). 08.5 already raises the in-app alert for every owner; this is the
  // external channel behind it, and `owner_escalation_sms` narrows its own ladder to SMS because
  // SMS is the channel fix 11 names.
  if (!payload.fallbackExhausted) return;

  for (const userId of await usersHoldingRole(tx, OWNER_ROLE)) {
    await enqueueNotification(tx, {
      templateKey: OWNER_ESCALATION_SMS,
      params,
      dedupeKey: dedupeKeyFor(e.eventId, OWNER_ESCALATION_SMS, userId),
      occurredAt: e.occurredAt,
      userId,
      sourceEventId: e.eventId,
    });
  }
}
