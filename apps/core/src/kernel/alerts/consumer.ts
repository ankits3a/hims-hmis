import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../db/client";
import { alerts } from "../db/schema";
import { appendEvent } from "../events/append";
import { notificationFailed } from "../notify/events";
import { escalationTriggered } from "../workflow/events";
import { usersHoldingRole } from "../workflow/roles";
import { alertRaised } from "./events";
import type { Db } from "../db/client";
import type { DispatchedEvent, Handler } from "../events/subscriptions";

/** The consumer key `alertsManifest` declares and the worker's consumers map is keyed by (D6). */
export const ALERTS_CONSUMER = "kernel.alerts";

/**
 * `fallbackExhausted` means the ladder rung resolved to nobody AND duty_manager resolved to
 * nobody (§11.19-C fix 11). The last rung is the owner — every holder of this role. The
 * owner-SMS half of fix 11 is Plan 10's and lives in `kernel/notify/consumer.ts`.
 */
export const OWNER_ROLE = "owner";

/**
 * Plan 10 D6: who picks up the phone when the gateway could not reach a patient. No
 * registration/front-desk role is seeded today (measured at plan time), so the desk task lands
 * with the duty managers; when a front-desk role exists this constant is the one line to change.
 */
export const DUTY_MANAGER_ROLE = "duty_manager";

const ALERT_KIND_ESCALATION = "escalation";
const ALERT_REF_TYPE = "workflow_instance";
const ALERT_KIND_MANUAL_NOTIFY = "manual_notify";
/** D6: an ID, not an identity. The desk reaches the patient through permission-checked routes. */
const MANUAL_NOTIFY_REF_TYPE = "patient";
const ALERTS_ACTOR: Actor = { type: "system", id: "kernel-alerts" };

/**
 * The alerts consumer (D6-08.5 + Plan 10 D6): TWO subscriptions, one output — a row in front of
 * a human being.
 *
 * NO ALERT COLUMN EVER CARRIES PATIENT IDENTITY (Global Constraint 6, spec §14's public-surface
 * rule). Titles and bodies are built EXCLUSIVELY from structural payload fields — defKey, state,
 * rung, role for an escalation; `templateKey` and nothing else for a manual-notify task.
 * `DispatchedEvent.patientId` is right there on the argument and the wrong implementation is ONE
 * PROPERTY ACCESS away: alerts are a per-user push surface (the tail fans `alert.raised` straight
 * to a browser), and the recipient reaches the patient only through permission-checked routes.
 * Mutant-enforced, not comment-enforced (Assertion Book L8 / M-A2, which copies `e.patientId`,
 * resolves the patient and renders the NAME into the title).
 *
 * AT-LEAST-ONCE IS THE CONTRACT (D4), so THE SAME EVENT WILL ARRIVE TWICE and this handler must
 * absorb it: the dispatcher claims on SUCCESS, and two concurrent cycles have been observed
 * invoking one handler twice for one event. The idempotency unit is the (source_event_id,
 * user_id) PAIR, never source_event_id alone — one escalation fans to every id in
 * `resolvedUserIds`, so a per-row unique would cap one escalation at ONE recipient.
 */
export function alertsConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    if (e.name === notificationFailed.name) {
      await handleNotificationFailed(db, e);
      return;
    }
    await handleEscalationTriggered(db, e);
  };
}

/**
 * The fan-out, extracted so BOTH branches raise alerts through exactly one piece of code — the
 * uniqueness target, the won-insert guard and the `alert.raised` payload cannot drift apart
 * between an escalation and a desk task.
 *
 * The per-recipient WRITE deliberately gets a transaction of its own: one recipient's conflict
 * must never roll back another recipient's alert.
 *
 * ONLY A WON INSERT APPENDS. A redelivery inserts nothing and must append nothing — that is
 * precisely what makes D4's at-least-once safe. Appending on every call would re-notify the same
 * human about the same thing every time the dispatcher retried.
 */
async function raiseAlerts(
  db: Db,
  e: DispatchedEvent,
  recipients: string[],
  alert: { kind: string; title: string; body: string; refType: string; refId: string },
): Promise<void> {
  for (const userId of recipients) {
    await withTx(db, async (tx) => {
      const inserted = await tx
        .insert(alerts)
        .values({
          id: newId(),
          userId,
          kind: alert.kind,
          title: alert.title,
          body: alert.body,
          refType: alert.refType,
          refId: alert.refId,
          sourceEventId: e.eventId,
        })
        .onConflictDoNothing({ target: [alerts.sourceEventId, alerts.userId] })
        .returning({ id: alerts.id });

      const row = inserted[0];
      if (row === undefined) return;

      await appendEvent(
        tx,
        alertRaised.make({
          actor: ALERTS_ACTOR,
          correlationId: e.correlationId ?? undefined,
          causationId: e.eventId,
          // patientId is deliberately NOT carried onto this event either: it is fanned to a
          // per-user WS topic. Causation is the audit path back to the source event, and THAT
          // event carries the patient.
          payload: {
            alertId: row.id,
            userId,
            kind: alert.kind,
            refType: alert.refType,
            refId: alert.refId,
            sourceEventId: e.eventId,
          },
        }),
      );
    });
  }
}

/** D6-08.5, unchanged in behaviour: `escalation.triggered` becomes a row in front of a human. */
async function handleEscalationTriggered(db: Db, e: DispatchedEvent): Promise<void> {
  const payload = escalationTriggered.payloadSchema.parse(e.payload);

  // Resolved in its own read transaction because `usersHoldingRole` is Tx-typed.
  const recipients = payload.fallbackExhausted
    ? await withTx(db, (tx) => usersHoldingRole(tx, OWNER_ROLE))
    : payload.resolvedUserIds;

  const title = `Escalation: ${payload.defKey} · ${payload.state} · rung ${payload.rung}`;
  const body = payload.fallbackExhausted
    ? `Escalation ladder exhausted at role ${payload.role} — routed to the ${OWNER_ROLE} role.`
    : `Escalated to role ${payload.role}.`;

  await raiseAlerts(db, e, recipients, {
    kind: ALERT_KIND_ESCALATION,
    title,
    body,
    refType: ALERT_REF_TYPE,
    refId: payload.instanceId,
  });
}

/**
 * PLAN 10 D6 — THE LAST PATIENT RUNG. The gateway ran out of channels (or the patient has no
 * phone at all), so the message becomes a human task instead of a silent failure. The pump raises
 * no alert of its own: it appends `notification.failed` and this branch reuses 08.5's machinery.
 *
 * PATIENT AUDIENCE ONLY. A staff or owner failure raises NO desk flag — 08.5's D6 already
 * guarantees an in-app alert for every escalation, so the external channel is additive by design
 * and a phoneless owner degrades to exactly what shipped before this plan.
 *
 * THE TITLE IS BUILT FROM `templateKey` AND NOTHING ELSE, and `refId` is the patient's ID — an
 * ID, not an identity (GC5). The duty manager opens the patient through a permission-checked
 * route; the alert row itself never carries a name, a UHID or a phone number, and no column here
 * would be safe to widen with one: `alert.raised` is fanned to a browser.
 *
 * The uniqueness key is THIS event's id — the `notification.failed` row's own `event_id`, never
 * the escalation that may have caused the notification — so a desk task can never collide with
 * an escalation alert on the same source event and silently vanish.
 */
async function handleNotificationFailed(db: Db, e: DispatchedEvent): Promise<void> {
  const payload = notificationFailed.payloadSchema.parse(e.payload);
  if (payload.audience !== "patient") return;

  // Structurally unreachable: `enqueueNotification` refuses a patient-audience row with no
  // `patientId`, and the pump copies that column onto the envelope. If it ever happens, the desk
  // task cannot be built and the failure must be LOUD — a swallowed return here would drop the
  // one signal that exists to stop a patient being unreachable in silence.
  if (e.patientId === null) {
    throw new Error(
      `alerts consumer: notification.failed for a patient-audience notification ` +
        `(${payload.notificationId}) carries no patientId on its envelope`,
    );
  }

  const recipients = await withTx(db, (tx) => usersHoldingRole(tx, DUTY_MANAGER_ROLE));

  await raiseAlerts(db, e, recipients, {
    kind: ALERT_KIND_MANUAL_NOTIFY,
    title: `Notify manually: ${payload.templateKey}`,
    body: `The "${payload.templateKey}" message could not be delivered (${payload.reason}). Please contact the patient from the record linked below.`,
    refType: MANUAL_NOTIFY_REF_TYPE,
    refId: e.patientId,
  });
}
