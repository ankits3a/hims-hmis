import { alertRaised } from "../alerts/events";
import { relayAlertToPhones } from "./phone-push";
import type { Db } from "../db/client";
import type { DispatchedEvent } from "../events/subscriptions";
import type { PhonePushSource } from "./sender";

/** The consumer key `phonePushManifest` declares for `alert.raised`; `workerConsumers` supplies the handler. */
export const PHONE_PUSH_CONSUMER = "kernel.phone_push";

/**
 * `alert.raised` → the person's signed-in phones (MOBILE M6b). With no Firebase key the handler
 * returns at once and the delivery is DONE — the cursor advances either way, so the day the key
 * appears the phones get what is raised from then on, and nothing from before is replayed at them.
 *
 * It reads three fields of the event (`alertId`, `userId`, `kind`) and nothing of the alert's row:
 * what the phone is told is chosen from a fixed table (`phoneMessage`).
 */
/**
 * A NOTIFICATION IS ABOUT NOW. An `alert.raised` older than this is not relayed — measured from the
 * EVENT'S OWN instant, never the worker's clock, so a backlog replayed after an outage (or a cursor
 * that was never seeded) fills the bell, where it belongs, and nobody's lock screen.
 */
export const PHONE_PUSH_FRESH_MS = 30 * 60 * 1000;

export function phonePushConsumer(db: Db, source: PhonePushSource, now: () => number = Date.now): (e: DispatchedEvent) => Promise<void> {
  return async (e) => {
    const sender = source.current();
    if (sender === null) return;
    if (now() - e.occurredAt.getTime() > PHONE_PUSH_FRESH_MS) return;
    const p = alertRaised.payloadSchema.parse(e.payload);
    await relayAlertToPhones(db, sender, { id: p.alertId, userId: p.userId, kind: p.kind });
  };
}
