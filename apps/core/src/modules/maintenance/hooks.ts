import { and, eq } from "drizzle-orm";
import { maintenanceTickets } from "../../kernel/db/schema";
import { releaseRepairBlock, updateTicket } from "./store";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";
import type { TaskRow } from "../tasks";

/**
 * THE TWO TASK-ENGINE HOOKS, each inside the engine's own transaction:
 *   · `ticketsFixedIn` (the kind's `onDone`) — the technician pressed Done: every OPEN ticket on that task is FIXED.
 *     A fixed ticket still holds its bed: fixed alone never unblocks.
 *   · `ticketsClosedIn` (the kind's `onVerified`) — a nurse confirmed: every FIXED ticket on that task is CLOSED by
 *     that nurse, and a bed block no other open ticket holds ends through the beds seam (to cleaning).
 * Each ticket raises its own task (`sourceRef` = the ticket), so this is one ticket in practice; the loop keeps the
 * hooks safe if a task ever carries more than one.
 */
export async function ticketsFixedIn(tx: Tx, task: TaskRow, actor: Actor, now: Date): Promise<void> {
  const open = await tx.select().from(maintenanceTickets)
    .where(and(eq(maintenanceTickets.taskId, task.id), eq(maintenanceTickets.state, "open"))).for("update");
  for (const t of open) {
    await updateTicket(tx, t.id, { state: "fixed", fixedBy: actor.id, fixedAt: now }, "fixed", actor, now, { taskId: task.id });
  }
}

export async function ticketsClosedIn(tx: Tx, task: TaskRow, actor: Actor, now: Date): Promise<void> {
  const fixed = await tx.select().from(maintenanceTickets)
    .where(and(eq(maintenanceTickets.taskId, task.id), eq(maintenanceTickets.state, "fixed"))).for("update");
  for (const t of fixed) {
    const closed = await updateTicket(tx, t.id, { state: "closed", closedBy: actor.id, closedAt: now }, "closed", actor, now, { taskId: task.id });
    await releaseRepairBlock(tx, actor, closed, now);
  }
}
