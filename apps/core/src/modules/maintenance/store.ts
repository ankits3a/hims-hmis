import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { ipdBedBlocks, maintenanceTicketEvents, maintenanceTickets } from "../../kernel/db/schema";
import { unblockBedIn } from "../ipd";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * THE TICKET ROW'S ONE WRITER. Every change bumps `version` and appends exactly one `maintenance_ticket_events` row
 * with `seq = version`, in the caller's transaction — the task engine's rule, for the same reason (a skipped event
 * shows as a primary-key clash or a gap).
 */
export type TicketRow = typeof maintenanceTickets.$inferSelect;
export type TicketAct = "raised" | "reported_again" | "dispatched" | "fixed" | "closed" | "cancelled";

export async function logTicketEvent(
  tx: Db | Tx, row: TicketRow, act: TicketAct, actor: Actor, at: Date, detail: Record<string, unknown> = {},
): Promise<void> {
  await (tx as Db).insert(maintenanceTicketEvents).values({
    ticketId: row.id, seq: row.version, act, actorType: actor.type, actorId: actor.id, at, detail,
  });
}

export async function updateTicket(
  tx: Db | Tx, id: string, set: Partial<typeof maintenanceTickets.$inferInsert>, act: TicketAct, actor: Actor, at: Date,
  detail: Record<string, unknown> = {},
): Promise<TicketRow> {
  const row = (await (tx as Db).update(maintenanceTickets)
    .set({ ...set, version: sql`${maintenanceTickets.version} + 1`, updatedAt: at })
    .where(eq(maintenanceTickets.id, id)).returning())[0]!;
  await logTicketEvent(tx, row, act, actor, at, detail);
  return row;
}

/**
 * The bed's repair block ends when the LAST open ticket holding it is closed or cancelled: the beds seam
 * (`unblockBedIn`) moves the bed to cleaning (the beds rule after maintenance) or withdraws a block still waiting
 * for the bed's release. A block that is no longer live (ended by its own release path, or never applied) is left.
 * The caller has already moved its own ticket out of open/fixed in this transaction.
 */
export async function releaseRepairBlock(tx: Tx, actor: Actor, ticket: TicketRow, at: Date): Promise<boolean> {
  if (ticket.bedBlockId === null) return false;
  const others = await tx.select({ id: maintenanceTickets.id }).from(maintenanceTickets).where(and(
    eq(maintenanceTickets.bedBlockId, ticket.bedBlockId), ne(maintenanceTickets.id, ticket.id),
    inArray(maintenanceTickets.state, ["open", "fixed"]),
  )).limit(1);
  if (others.length > 0) return false;
  const block = (await tx.select({ status: ipdBedBlocks.status }).from(ipdBedBlocks).where(eq(ipdBedBlocks.id, ticket.bedBlockId)))[0];
  if (block === undefined || (block.status !== "active" && block.status !== "pending_release")) return false;
  await unblockBedIn(tx, actor, { bedId: ticket.placeResourceId, note: `Repair #${String(ticket.number)} ${ticket.state}` }, at);
  return true;
}
