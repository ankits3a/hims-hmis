import { eq } from "drizzle-orm";
import { withTx } from "../db/client";
import { approvals } from "../db/schema";
import { alertAcknowledged } from "../alerts/events";
import { cancelTimersOfKind } from "../workflow/timers";
import type { Db } from "../db/client";
import type { DispatchedEvent, Handler } from "../events/subscriptions";

/** The consumer key `obligationsManifest` declares and the worker's consumers map is keyed by. */
export const OBLIGATIONS_CONSUMER = "kernel.obligations";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PHASE O — THE FIRST FILE OF THE OBLIGATION SPINE'S OWN KERNEL AREA
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * One job today: **an acknowledgement stops the respond clock, and touches nothing else.**
 *
 * ═══ WHY THIS IS NOT DONE INSIDE `acknowledgeAlert` ═══
 *
 * Because an alert does not know it is an obligation. `kernel/alerts` is a per-user inbox with
 * no idea that some of its rows point at workflow instances carrying timers, and teaching it
 * would put the spine's arithmetic inside the bell. The event is the seam that already exists:
 * `alert.acknowledged` is appended in the acknowledging transaction, and this consumer reads it
 * out of the same log every other cross-module reaction is built on.
 *
 * ═══ WHICH ACKS STOP THE CLOCK, AND WHICH DELIBERATELY DO NOT ═══
 *
 *   seen         stops it — somebody has looked and said so.
 *   owned        stops it — somebody has taken it on, with a deadline.
 *   handed_over  DOES NOT. Handing a thing to somebody else is not answering it, and G6 is the
 *                reason the distinction is worth code: "hand over to dodge" is a named way of
 *                making a queue look attended. The clock keeps running and the ladder climbs on
 *                schedule; what the handover buys is a record of who passed it to whom.
 *
 * ═══ AND IT STOPS ONLY THE RESPOND CLOCK ═══
 *
 * `cancelTimersOfKind(…, "respond")`, never `cancelOpenTimers`. Silence and lateness are two
 * failures: somebody saying "I have got this" is not the work being done, and the budget's
 * timers — the sla timer and every ladder rung — go on exactly as they were.
 */
export function obligationsConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    if (e.name !== alertAcknowledged.name) return;
    const payload = alertAcknowledged.payloadSchema.parse(e.payload);
    if (payload.kind !== "seen" && payload.kind !== "owned") return;

    const instanceId = await instanceBehind(db, payload.refType, payload.refId);
    if (instanceId === null) return;

    // Naturally idempotent: `cancelTimersOfKind` only touches timers that are still open, so a
    // redelivery cancels nothing a second time and writes nothing. At-least-once is safe here
    // without a claim of its own.
    await withTx(db, (tx) => cancelTimersOfKind(tx, instanceId, "respond", e.occurredAt));
  };
}

/**
 * An alert points at the thing a human OPENS, and that is not always the workflow instance the
 * timers hang off. T2 files an approval's alert against the APPROVAL row, because `/approvals`
 * is what an approver opens and the instance is a detail of how the request is timed.
 *
 * Anything else — a patient ref from the manual-notify branch, an imaging study, an operating
 * mode — has no instance behind it and no clock to stop. Returning null rather than guessing is
 * the whole of that branch.
 */
async function instanceBehind(
  db: Db,
  refType: string | null,
  refId: string | null,
): Promise<string | null> {
  if (refId === null) return null;
  if (refType === "workflow_instance") return refId;
  if (refType === "approval") {
    const rows = await db
      .select({ instanceId: approvals.instanceId })
      .from(approvals)
      .where(eq(approvals.id, refId));
    return rows[0]?.instanceId ?? null;
  }
  return null;
}
