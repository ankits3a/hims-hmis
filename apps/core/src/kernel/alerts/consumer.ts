import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../db/client";
import { alerts } from "../db/schema";
import { appendEvent } from "../events/append";
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
 * owner-SMS half of fix 11 is Plan 10's and is not built here.
 */
export const OWNER_ROLE = "owner";

const ALERT_KIND_ESCALATION = "escalation";
const ALERT_REF_TYPE = "workflow_instance";
const ALERTS_ACTOR: Actor = { type: "system", id: "kernel-alerts" };

/**
 * The one consumer (D6): `escalation.triggered` becomes a row in front of a human being.
 *
 * NO ALERT COLUMN EVER CARRIES PATIENT IDENTITY (Global Constraint 6, spec §14's public-surface
 * rule). The title and body below are built EXCLUSIVELY from payload fields that are structural
 * — defKey, state, rung, role. `DispatchedEvent.patientId` is right there on the argument and
 * the wrong implementation is ONE PROPERTY ACCESS away: alerts are a per-user push surface (the
 * tail fans `alert.raised` straight to a browser), and the recipient reaches the patient only
 * through permission-checked routes. Mutant-enforced, not comment-enforced (Assertion Book L8 /
 * M-A2, which copies `e.patientId`, resolves the patient and renders the NAME into the title).
 *
 * AT-LEAST-ONCE IS THE CONTRACT (D4), so THE SAME EVENT WILL ARRIVE TWICE and this handler must
 * absorb it: the dispatcher claims on SUCCESS, and two concurrent cycles have been observed
 * invoking one handler twice for one event. The idempotency unit is the (source_event_id,
 * user_id) PAIR, never source_event_id alone — one escalation fans to every id in
 * `resolvedUserIds`, so a per-row unique would cap one escalation at ONE recipient.
 */
export function alertsConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    const payload = escalationTriggered.payloadSchema.parse(e.payload);

    // Resolved in its own read transaction because `usersHoldingRole` is Tx-typed. The
    // per-recipient WRITE below deliberately gets a transaction of its own: one recipient's
    // conflict must never roll back another recipient's alert.
    const recipients = payload.fallbackExhausted
      ? await withTx(db, (tx) => usersHoldingRole(tx, OWNER_ROLE))
      : payload.resolvedUserIds;

    const title = `Escalation: ${payload.defKey} · ${payload.state} · rung ${payload.rung}`;
    const body = payload.fallbackExhausted
      ? `Escalation ladder exhausted at role ${payload.role} — routed to the ${OWNER_ROLE} role.`
      : `Escalated to role ${payload.role}.`;

    for (const userId of recipients) {
      await withTx(db, async (tx) => {
        const inserted = await tx
          .insert(alerts)
          .values({
            id: newId(),
            userId,
            kind: ALERT_KIND_ESCALATION,
            title,
            body,
            refType: ALERT_REF_TYPE,
            refId: payload.instanceId,
            sourceEventId: e.eventId,
          })
          .onConflictDoNothing({ target: [alerts.sourceEventId, alerts.userId] })
          .returning({ id: alerts.id });

        // ONLY A WON INSERT APPENDS. A redelivery inserts nothing and must append nothing —
        // that is precisely what makes D4's at-least-once safe. Append on every call and every
        // redelivery would re-notify the same human about the same escalation.
        const row = inserted[0];
        if (row === undefined) return;

        await appendEvent(
          tx,
          alertRaised.make({
            actor: ALERTS_ACTOR,
            correlationId: e.correlationId ?? undefined,
            causationId: e.eventId,
            // patientId is deliberately NOT carried onto this event either: it is fanned to a
            // per-user WS topic. Causation is the audit path back to the escalation, and THAT
            // event carries the patient.
            payload: {
              alertId: row.id,
              userId,
              kind: ALERT_KIND_ESCALATION,
              refType: ALERT_REF_TYPE,
              refId: payload.instanceId,
              sourceEventId: e.eventId,
            },
          }),
        );
      });
    }
  };
}
