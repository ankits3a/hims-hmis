import { withTx } from "../../kernel/db/client";
import { eventIdempotency } from "../../kernel/db/schema";
import { prescriptionIssued } from "../opd";
import { enqueueDispense } from "./queue";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { DispatchedEvent, Handler } from "../../kernel/events/subscriptions";

export const PHARMACY_RX_ISSUED_CONSUMER = "pharmacy.rx_issued";

const SYSTEM: Actor = { type: "system", id: "pharmacy-queue" };

/** The `ot/consumers.ts` claim: one row per (consumer, event), the unique key is the arbiter. */
async function claimFor(tx: Tx, consumer: string, eventId: string): Promise<boolean> {
  const claimed = await tx.insert(eventIdempotency)
    .values({ idempotencyKey: `${consumer}:${eventId}`, eventId })
    .onConflictDoNothing({ target: eventIdempotency.idempotencyKey })
    .returning({ eventId: eventIdempotency.eventId });
  return claimed.length > 0;
}

/**
 * PLAN 16c D10 — `prescription.issued` → a QUEUED dispense, so the Rx is at the counter before the
 * patient is (doc 16 §3.1's first arrow). Idempotent twice over: the claim row here, and
 * `enqueueDispense`'s one-live-row rule beneath it, because the same Rx may also arrive by scan.
 */
export async function handlePrescriptionIssued(tx: Tx, eventId: string, payload: unknown, now: Date): Promise<{ handled: boolean; dispenseId: string | null }> {
  if (!(await claimFor(tx, PHARMACY_RX_ISSUED_CONSUMER, eventId))) return { handled: false, dispenseId: null };
  const parsed = prescriptionIssued.payloadSchema.safeParse(payload);
  if (!parsed.success) return { handled: true, dispenseId: null };
  const p = parsed.data;
  const { dispenseId } = await enqueueDispense(tx, SYSTEM, {
    prescriptionId: p.prescriptionId, prescriptionVersion: p.version, patientId: p.patientId, encounterId: p.encounterId,
    source: "prescription_issued",
  }, now);
  return { handled: true, dispenseId };
}

export function rxIssuedConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    if (e.name !== prescriptionIssued.name) return;
    await withTx(db, (tx) => handlePrescriptionIssued(tx, e.eventId, e.payload, new Date()));
  };
}
