import { and, eq, inArray, isNull } from "drizzle-orm";
import { IPD_EMAR_HORIZON_HOURS, newId } from "@hmis/contracts";
import { ipdEmarActs, ipdEmarAllergyFlags, ipdEmarDoses } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { provenanceOf } from "./admission-core";
import { emarDrugsOf } from "./emar-drug";
import { dosesCancelled } from "./emar-events";
import { dueTimesFor, windowMinutesFor } from "./emar-rules";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";
import type { IpdOrderRow } from "./orders";

/**
 * E4.3 (#735) — THE DOSE SLOTS: written when a pharmacist verifies an order and topped up by the minute sweep to
 * `IPD_EMAR_HORIZON_HOURS` ahead; cancelled when the order stops or is cancelled. Kept apart from `emar.ts` so `orders.ts`
 * (stop / cancel) can call `cancelFutureDosesIn` without an import cycle.
 */

/**
 * Writes the order's slots from `from` to `to` (idempotent: `(order_id, due_at)` is unique). SOS (PRN) writes none — a PRN
 * dose makes its own slot when given. STAT: one slot, at the start or — verified after the start — at `from`.
 */
export async function scheduleDosesIn(tx: Tx, o: IpdOrderRow, from: Date, to: Date, at: Date): Promise<number> {
  if (o.kind !== "drug" || o.startAt === null || o.frequency === null || o.frequency === "SOS") return 0;
  const drug = (await emarDrugsOf(tx, [o])).get(o.id);
  const windowMinutes = windowMinutesFor(drug?.timeCritical ?? o.antibiotic);
  const times = o.frequency === "STAT"
    ? [new Date(Math.max(o.startAt.getTime(), from.getTime()))]
    : dueTimesFor({ frequency: o.frequency, startAt: o.startAt, stopAt: o.stopAt, durationDays: o.durationDays }, from, to);
  if (times.length === 0) return 0;
  const rows = await tx.insert(ipdEmarDoses).values(times.map((dueAt) => ({
    id: newId(), orderId: o.id, admissionId: o.admissionId, patientId: o.patientId, dueAt, windowMinutes, prn: false,
    status: "scheduled", createdAt: at,
  }))).onConflictDoNothing().returning({ id: ipdEmarDoses.id });
  return rows.length;
}

/** The horizon a sweep or a verify fills to. */
export const horizonOf = (at: Date): Date => new Date(at.getTime() + IPD_EMAR_HORIZON_HOURS * 3_600_000);

/**
 * The order stopped or was cancelled: every OPEN slot (scheduled or held) is cancelled, each with its own `cancelled` act,
 * and the order's open allergy flags record the doctor's decision "stop". Called inside the stop / cancel transaction.
 */
export async function cancelFutureDosesIn(tx: Tx, actor: Actor, o: Pick<IpdOrderRow, "id" | "admissionId" | "patientId">, at: Date): Promise<number> {
  const open = await tx.select().from(ipdEmarDoses)
    .where(and(eq(ipdEmarDoses.orderId, o.id), inArray(ipdEmarDoses.status, ["scheduled", "held"]))).for("update");
  for (const d of open) {
    const actId = newId();
    await tx.insert(ipdEmarActs).values({
      id: actId, doseId: d.id, orderId: o.id, admissionId: o.admissionId, patientId: o.patientId, kind: "cancelled", slotSeq: d.slotSeq + 1,
      at, recordedAt: at, actorId: actor.id, provenance: provenanceOf(actor), reason: "order_ended",
    });
    await tx.update(ipdEmarDoses).set({ status: "cancelled", slotSeq: d.slotSeq + 1, lastActId: actId }).where(eq(ipdEmarDoses.id, d.id));
  }
  // E4.3 review: a stop IS the doctor's decision on an open allergy flag (recorded); the pharmacist still closes it.
  await tx.update(ipdEmarAllergyFlags).set({ doctorDecision: "stop", doctorReason: "order stopped", decidedBy: actor.id, decidedAt: at })
    .where(and(eq(ipdEmarAllergyFlags.orderId, o.id), isNull(ipdEmarAllergyFlags.resolvedAt), isNull(ipdEmarAllergyFlags.doctorDecision)));
  if (open.length > 0) {
    await appendEvent(tx, dosesCancelled.make({
      payload: { orderId: o.id, admissionId: o.admissionId, count: open.length, provenance: provenanceOf(actor) },
      actor, correlationId: o.admissionId, patientId: o.patientId, encounterId: o.admissionId, occurredAt: at,
    }));
  }
  return open.length;
}
