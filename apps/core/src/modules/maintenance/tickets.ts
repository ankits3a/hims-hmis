import { and, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import {
  MAINTENANCE_KINDS, MAINTENANCE_REPEAT_THRESHOLD, MAINTENANCE_REPEAT_WINDOW_DAYS, MAINTENANCE_RETURN_HOURS,
  cancelTicketInput, defaultCategory, newId, raiseTicketInput, ticketRefInput,
} from "@hmis/contracts";
import { raiseNotice } from "../../kernel/alerts/notices";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { ipdBedBlocks, maintenanceTickets, resources, tasks } from "../../kernel/db/schema";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { IpdBedAttributesSchema, IpdRefusal, blockBedIn } from "../ipd";
import { SERVICES_SUPERVISOR_ROLE, cancelTask, getTask, raiseTask, verifyTask } from "../tasks";
import "./kinds";
import { MaintenanceRefusal } from "./errors";
import { MAINTENANCE_FALLBACK_ROLE, MAINTENANCE_MANAGE, MAINTENANCE_RAISE } from "./names";
import { logTicketEvent, releaseRepairBlock, updateTicket } from "./store";
import type {
  Actor, MaintenanceBedEffect, MaintenanceCategory, MaintenanceItemKind, MaintenanceUrgency, RaiseTicketResult, TaskPriority,
} from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { TicketRow } from "./store";

/**
 * ═══ THE MAINTENANCE INTENTS ═══
 *
 * `raiseTicket` — a fault reported at a place (a bed, room or ward), by a person or a device. In ONE transaction:
 *   · a second report of the same item at the same place while the first is still open is the SAME ticket
 *     (`reported_again`), so a fault reported twice never counts twice toward replacement;
 *   · the repeat rule: with ≥ 2 earlier non-cancelled tickets on the same item (same tag when one is given, else the
 *     same place and item kind) in the previous 30 days, this third one flags the item for replacement and tells
 *     the services supervisors (the admins when there are none) — no job, computed here;
 *   · a bed: an available or cleaning bed is BLOCKED (reason maintenance, expected back at now + the urgency's
 *     hours); an occupied bed gets a block that applies on release (the beds block-on-release path); a bed already
 *     blocked for maintenance by hand is joined (source `block`); a reserved bed is not blocked (said in the answer);
 *   · the repair task is raised on the task engine (skill by category), due at now + the urgency's hours.
 * `confirmTicket` — the nurse's confirmation: the repair task's check (`verifyTask`, the kind's verifier list and
 *   the doer rule), whose `onVerified` closes the ticket and ends the bed's block.
 * `cancelTicket` — raised in error (maintenance.manage): the ticket, its open task and its bed block end.
 * `dispatchTicket` — the repair task was cancelled on the task board while the fault is still open: raise it again.
 */
type Opts = { now?: Date };

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new MaintenanceRefusal("bad_input", { issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  return r.data;
}

async function requirePermission(db: Db | Tx, actor: Actor, permission: string): Promise<void> {
  if (actor.type === "system") return;
  if (!(await hasPermission(db as Db, actor.id, permission, "hospital"))) throw new MaintenanceRefusal("forbidden", { permission });
}

const PRIORITY: Record<MaintenanceUrgency, TaskPriority> = { critical: "stat", urgent: "urgent", routine: "routine" };
const ITEM_WORDS: Record<MaintenanceItemKind, string> = {
  bed: "Bed", oxygen_point: "Oxygen point", suction: "Suction", monitor: "Monitor", fixture: "Fixture",
  electrical: "Electrical", plumbing: "Plumbing", ac: "AC", other: "Other",
};

/** The task's note: what the technician reads on their card. Never a patient. */
function taskNote(number: number, item: MaintenanceItemKind, tag: string | null, description: string): string {
  const head = `#${String(number)} ${ITEM_WORDS[item]}${tag === null ? "" : ` (${tag})`}: `;
  return (head + description).slice(0, 280);
}

function kindFor(category: MaintenanceCategory): string {
  return category === "biomedical" ? MAINTENANCE_KINDS.biomedical : MAINTENANCE_KINDS.general;
}

/** How many earlier non-cancelled tickets the same item had in the 30 days before `now`. */
async function earlierFaults(tx: Tx, placeId: string, item: MaintenanceItemKind, tag: string | null, now: Date): Promise<number> {
  const since = new Date(now.getTime() - MAINTENANCE_REPEAT_WINDOW_DAYS * 86_400_000);
  const same = tag !== null
    ? sql`lower(${maintenanceTickets.itemTag}) = lower(${tag})`
    : and(eq(maintenanceTickets.placeResourceId, placeId), eq(maintenanceTickets.itemKind, item));
  const r = await tx.select({ n: sql<number>`count(*)::int` }).from(maintenanceTickets).where(and(
    same, ne(maintenanceTickets.state, "cancelled"), gte(maintenanceTickets.createdAt, since), lt(maintenanceTickets.createdAt, now),
  ));
  return r[0]?.n ?? 0;
}

async function tellReplacement(tx: Tx, ticket: TicketRow, placeName: string, now: Date): Promise<void> {
  let holders = await usersHoldingRole(tx, SERVICES_SUPERVISOR_ROLE);
  if (holders.length === 0) holders = await usersHoldingRole(tx, MAINTENANCE_FALLBACK_ROLE);
  const item = `${ITEM_WORDS[ticket.itemKind as MaintenanceItemKind]}${ticket.itemTag === null ? "" : ` ${ticket.itemTag}`}`;
  for (const userId of [...new Set(holders)]) {
    await raiseNotice(tx as unknown as Db, {
      userId, kind: "maintenance.replacement", title: `Replace? ${item}`,
      body: `${placeName} · ${String(MAINTENANCE_REPEAT_THRESHOLD)} faults in ${String(MAINTENANCE_REPEAT_WINDOW_DAYS)} days · repair #${String(ticket.number)}`,
      refType: "maintenance_ticket", refId: ticket.id, sourceKey: `maintenance:${ticket.id}:replacement`, at: now,
    });
  }
}

/** Block the bed for this ticket, or say why not. Runs under the bed's own locks (taken by `blockBedIn`). */
async function blockForTicket(
  tx: Tx, actor: Actor, bedId: string, number: number, item: MaintenanceItemKind, expectedReturnAt: Date, now: Date,
): Promise<{ effect: MaintenanceBedEffect; blockId: string | null }> {
  try {
    const r = await blockBedIn(tx, actor, {
      bedId, reason: "maintenance", note: `Repair #${String(number)}: ${ITEM_WORDS[item]}`, expectedReturnAt: expectedReturnAt.toISOString(),
    }, now);
    return { effect: r.status === "blocked" ? "blocked" : "block_on_release", blockId: r.blockId };
  } catch (e) {
    if (!(e instanceof IpdRefusal)) throw e;
    if (e.code === "bed_reserved") return { effect: "not_blocked_reserved", blockId: null };
    const blockId = typeof e.detail?.blockId === "string" ? e.detail.blockId : null;
    if (e.code === "state_changed" && blockId !== null) {
      // Already blocked (the bed's row lock is ours now): a maintenance block is joined; any other reason stays its own.
      const block = (await tx.select({ reason: ipdBedBlocks.reason }).from(ipdBedBlocks).where(eq(ipdBedBlocks.id, blockId)))[0];
      if (block?.reason === "maintenance") return { effect: "joined_block", blockId };
      return { effect: "already_blocked", blockId: null };
    }
    // Any other refusal (a bed in a status the beds module does not block from): the fault is still recorded — a
    // report is never lost — and the answer says the bed was not blocked. ipd refuses assigning it while open.
    return { effect: "not_blocked_status", blockId: null };
  }
}

export async function raiseTicket(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<RaiseTicketResult> {
  const input = parse(raiseTicketInput, raw);
  await requirePermission(db, actor, MAINTENANCE_RAISE);
  const now = opts.now ?? new Date();
  const tag = input.itemTag === undefined || input.itemTag === "" ? null : input.itemTag;
  const category = input.category ?? defaultCategory(input.itemKind);
  const source = input.source ?? (actor.type === "system" ? "device" : "person");
  return withTx(db, async (tx) => {
    const place = (await tx.select().from(resources).where(eq(resources.id, input.placeResourceId)))[0];
    if (place === undefined) throw new MaintenanceRefusal("unknown_place", { placeResourceId: input.placeResourceId });
    if (place.status === "retired") throw new MaintenanceRefusal("place_retired", { placeResourceId: place.id });
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`maintenance:place:${place.id}`}))`);
    if (tag !== null) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`maintenance:tag:${tag.toLowerCase()}`}))`);

    // The same fault, still open: the same ticket, reported again.
    const twin = (await tx.select().from(maintenanceTickets).where(and(
      eq(maintenanceTickets.placeResourceId, place.id), eq(maintenanceTickets.itemKind, input.itemKind),
      tag === null ? isNull(maintenanceTickets.itemTag) : sql`lower(${maintenanceTickets.itemTag}) = lower(${tag})`,
      eq(maintenanceTickets.state, "open"),
    )).limit(1).for("update"))[0];
    if (twin !== undefined) {
      const row = await updateTicket(tx, twin.id, {}, "reported_again", actor, now, { note: input.description, by: actor.id });
      return { ticketId: row.id, number: row.number, merged: true, bed: row.bedBlockId === null ? "not_a_bed" : "joined_block", replacementFlag: row.replacementFlag };
    }

    // Flagged from the third fault on; the supervisors are told once, by the ticket that CROSSES the threshold.
    const earlier = await earlierFaults(tx, place.id, input.itemKind, tag, now);
    const replacementFlag = earlier >= MAINTENANCE_REPEAT_THRESHOLD - 1;
    const crossesThreshold = earlier === MAINTENANCE_REPEAT_THRESHOLD - 1;
    const number = Number((await tx.execute<{ n: string }>(sql`select nextval(pg_get_serial_sequence('maintenance_tickets', 'number')) as n`)).rows[0]!.n);
    const dueAt = new Date(now.getTime() + MAINTENANCE_RETURN_HOURS[input.urgency] * 3_600_000);

    let bed: { effect: MaintenanceBedEffect; blockId: string | null } = { effect: "not_a_bed", blockId: null };
    if (place.kind === "bed" && IpdBedAttributesSchema.safeParse(place.attributes).success) {
      bed = await blockForTicket(tx, actor, place.id, number, input.itemKind, dueAt, now);
    }
    const ticketId = newId();
    // One task per ticket: the ticket's own key, not the engine's ten-minute merge window (two faults at one bed
    // are two repairs).
    const { task } = await raiseTask(tx, actor, {
      kind: kindFor(category), placeResourceId: place.id, priority: PRIORITY[input.urgency], dueAt: dueAt.toISOString(),
      sourceRef: `maintenance-ticket:${ticketId}`, raisedAt: now.toISOString(),
      note: taskNote(number, input.itemKind, tag, input.description), source: source === "device" ? "device" : undefined,
    }, now);
    const row = (await tx.insert(maintenanceTickets).values({
      id: ticketId, number, placeResourceId: place.id, itemKind: input.itemKind, itemTag: tag, category, urgency: input.urgency,
      description: input.description, raisedBy: actor.id, source: bed.effect === "joined_block" ? "block" : source,
      bedBlockId: bed.blockId, taskId: task.id, state: "open", dueAt, replacementFlag, createdAt: now, updatedAt: now, version: 1,
    }).returning())[0]!;
    await logTicketEvent(tx, row, "raised", actor, now, { bed: bed.effect, taskId: task.id, replacementFlag });
    if (crossesThreshold) await tellReplacement(tx, row, place.name, now);
    return { ticketId: row.id, number: row.number, merged: false, bed: bed.effect, replacementFlag };
  });
}

async function lockTicket(tx: Tx, ticketId: string): Promise<TicketRow> {
  const row = (await tx.select().from(maintenanceTickets).where(eq(maintenanceTickets.id, ticketId)).for("update"))[0];
  if (row === undefined) throw new MaintenanceRefusal("ticket_not_found", { ticketId });
  return row;
}

/** The nurse's confirmation of a fixed ticket: the repair task's check. Its `onVerified` closes the ticket. */
export async function confirmTicket(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<TicketRow> {
  const input = parse(ticketRefInput, raw);
  const now = opts.now ?? new Date();
  const ticket = (await db.select().from(maintenanceTickets).where(eq(maintenanceTickets.id, input.ticketId)))[0];
  if (ticket === undefined) throw new MaintenanceRefusal("ticket_not_found", { ticketId: input.ticketId });
  if (ticket.state === "closed" || ticket.state === "cancelled") throw new MaintenanceRefusal("ticket_closed", { ticketId: ticket.id });
  if (ticket.state !== "fixed" || ticket.taskId === null) throw new MaintenanceRefusal("not_fixed_yet", { ticketId: ticket.id });
  await verifyTask(db, actor, { taskId: ticket.taskId }, now);
  return (await db.select().from(maintenanceTickets).where(eq(maintenanceTickets.id, ticket.id)))[0]!;
}

/** DECIDED: only an OPEN ticket is cancelled (raised in error, a duplicate); a fixed one is confirmed instead. */
export async function cancelTicket(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<TicketRow> {
  const input = parse(cancelTicketInput, raw);
  await requirePermission(db, actor, MAINTENANCE_MANAGE);
  const now = opts.now ?? new Date();
  return withTx(db, async (tx) => {
    const ticket = await lockTicket(tx, input.ticketId);
    if (ticket.state === "closed" || ticket.state === "cancelled") throw new MaintenanceRefusal("ticket_closed", { ticketId: ticket.id });
    if (ticket.state === "fixed") throw new MaintenanceRefusal("already_fixed", { ticketId: ticket.id });
    const row = await updateTicket(tx, ticket.id, { state: "cancelled", cancelReason: input.reason }, "cancelled", actor, now, { reason: input.reason });
    if (row.taskId !== null) {
      const sharing = await tx.select({ id: maintenanceTickets.id }).from(maintenanceTickets).where(and(
        eq(maintenanceTickets.taskId, row.taskId), ne(maintenanceTickets.id, row.id), inArray(maintenanceTickets.state, ["open", "fixed"]),
      )).limit(1);
      const task = await getTask(tx, row.taskId);
      if (sharing.length === 0 && task !== null && ["created", "assigned", "accepted", "in_progress"].includes(task.state)) {
        await cancelTask(tx, actor, { taskId: task.id, reason: `Repair #${String(row.number)} cancelled: ${input.reason}`.slice(0, 280) }, now);
      }
    }
    await releaseRepairBlock(tx, actor, row, now);
    return row;
  });
}

/** The fault is open but its repair task was cancelled on the task board: raise the task again. */
export async function dispatchTicket(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<TicketRow> {
  const input = parse(ticketRefInput, raw);
  await requirePermission(db, actor, MAINTENANCE_MANAGE);
  const now = opts.now ?? new Date();
  return withTx(db, async (tx) => {
    const ticket = await lockTicket(tx, input.ticketId);
    if (ticket.state !== "open") throw new MaintenanceRefusal(ticket.state === "fixed" ? "already_fixed" : "ticket_closed", { ticketId: ticket.id });
    if (ticket.taskId !== null) {
      const state = (await tx.select({ state: tasks.state }).from(tasks).where(eq(tasks.id, ticket.taskId)))[0]?.state;
      if (state !== undefined && state !== "cancelled") throw new MaintenanceRefusal("task_still_open", { ticketId: ticket.id });
    }
    const { task } = await raiseTask(tx, actor, {
      kind: kindFor(ticket.category as MaintenanceCategory), placeResourceId: ticket.placeResourceId,
      priority: PRIORITY[ticket.urgency as MaintenanceUrgency],
      dueAt: new Date(Math.max(ticket.dueAt.getTime(), now.getTime() + 60_000)).toISOString(),
      note: taskNote(ticket.number, ticket.itemKind as MaintenanceItemKind, ticket.itemTag, ticket.description),
      sourceRef: `maintenance-ticket:${ticket.id}:dispatch:${String(ticket.version + 1)}`, raisedAt: now.toISOString(),
    }, now);
    return updateTicket(tx, ticket.id, { taskId: task.id }, "dispatched", actor, now, { taskId: task.id });
  });
}
