import { eq, sql } from "drizzle-orm";
import { raiseNotice } from "../../kernel/alerts/notices";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { transportRequests } from "../../kernel/db/schema";
import { resolveBandScan } from "../ipd";
import { TransportRefusal } from "./errors";
import { isHighRiskForTransport } from "./risk";
import type { Actor, TaskProof } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { TaskRow } from "../tasks";

export type TransportRequestRow = typeof transportRequests.$inferSelect;

/** The transport row of a task, locked FOR UPDATE when `lock` (the intents that change it). */
export async function requestOfTask(exec: Db | Tx, taskId: string, lock = false): Promise<TransportRequestRow | null> {
  const q = (exec as Db).select().from(transportRequests).where(eq(transportRequests.taskId, taskId));
  const row = (await (lock ? q.for("update") : q))[0];
  return row ?? null;
}

/**
 * Is an escort needed for this move NOW? The request's own flag, or the risk seam at this moment — a patient moved
 * into an ICU bed after the request still needs one at start.
 */
export async function escortNeeded(exec: Db | Tx, req: TransportRequestRow): Promise<boolean> {
  if (req.escortRequired) return true;
  if (req.admissionId === null) return false;
  return (await isHighRiskForTransport(exec, req.admissionId)).highRisk;
}

/**
 * THE START RULE (spec §6), run inside the engine's `startTask` transaction (`beforeStart`). A patient move with an
 * escort required cannot start until an escort is recorded; an oxygen move cannot start before the cylinder check.
 */
export async function patientMoveMayStart(tx: Tx, task: TaskRow): Promise<void> {
  const req = await requestOfTask(tx, task.id, true);
  if (req === null) throw new TransportRefusal("not_transport", { taskId: task.id });
  if (req.escortUserId === null && await escortNeeded(tx, req)) {
    throw new TransportRefusal("escort_required", { taskId: task.id, escortReason: req.escortReason ?? "critical_care_bed" });
  }
  if (req.oxygen && req.oxygenCheckedAt === null) throw new TransportRefusal("oxygen_not_checked", { taskId: task.id });
}

/**
 * THE HANDOVER RULE (spec §6), run inside the engine's `completeTask` transaction (`beforeDone`): the wristband
 * scanned at the destination must be a live band of the SAME admission. A different patient's band is refused
 * `wrong_patient`; the handover (serial and time) is written in the same transaction as the done.
 */
export async function patientMoveHandover(tx: Tx, task: TaskRow, proof: TaskProof | undefined, actor: Actor, now: Date): Promise<void> {
  const req = await requestOfTask(tx, task.id, true);
  if (req === null) throw new TransportRefusal("not_transport", { taskId: task.id });
  if (proof === undefined || proof.kind !== "scan") throw new TransportRefusal("scan_required", { taskId: task.id });
  const band = await resolveBandScan(tx, proof.code);
  if (band === null) throw new TransportRefusal("band_unknown", { taskId: task.id });
  if (band.admissionId !== req.admissionId) {
    const refusal = new TransportRefusal("wrong_patient", { taskId: task.id });
    const record = { at: now.toISOString(), actorId: actor.id, scannedAdmissionId: band.admissionId, serial: band.serial };
    refusal.afterRefusal = (db) => recordRefusedHandover(db, req.id, task, record, now);
    throw refusal;
  }
  if (!band.live) throw new TransportRefusal("band_void", { taskId: task.id });
  await (tx as Db).update(transportRequests).set({
    handoverBandSerial: band.serial, handoverAt: now, updatedAt: now,
  }).where(eq(transportRequests.id, req.id));
}

/** Who is told of a refused handover: the transport / services supervisor and the duty manager. */
export const HANDOVER_REFUSED_ROLES = ["services_supervisor", "duty_manager"] as const;

/**
 * A WRONG-PATIENT HANDOVER IS A SAFETY EVENT. The refused `completeTask` rolls back, so this runs afterwards in its
 * own short transaction (the engine's `afterRefusal`): the scan is appended to the request's `handover_refusals`, and
 * every services supervisor and duty manager gets a bell — place names only, never a patient's name.
 */
export async function recordRefusedHandover(
  db: Db, requestId: string, task: TaskRow,
  record: { at: string; actorId: string; scannedAdmissionId: string; serial: string }, now: Date,
): Promise<void> {
  await db.transaction(async (t) => {
    await t.update(transportRequests).set({
      handoverRefusals: sql`${transportRequests.handoverRefusals} || ${JSON.stringify([record])}::jsonb`, updatedAt: now,
    }).where(eq(transportRequests.id, requestId));
  });
  const holders = new Set<string>();
  for (const role of HANDOVER_REFUSED_ROLES) for (const u of await usersHoldingRole(db as unknown as Tx, role)) holders.add(u);
  for (const userId of holders) {
    await raiseNotice(db, {
      userId, kind: "transport.handover_refused", title: "Wrong patient at handover",
      body: "A porter scanned another patient's wristband at handover. The move was not completed.",
      refType: "task", refId: task.id, sourceKey: `transport:handover_refused:${task.id}:${record.at}`, at: now,
    });
  }
}

/** True when any open transport task is waiting for its escort — SQL over every open row (the board's count). */
export const WAITING_ESCORT_SQL = sql`${transportRequests.escortRequired} and ${transportRequests.escortUserId} is null`;
