import { and, desc, eq, gte, ilike, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { MAINTENANCE_REPEAT_WINDOW_DAYS } from "@hmis/contracts";
import { ipdBedBlocks, maintenanceTickets, resources, tasks, users } from "../../kernel/db/schema";
import type {
  BedTicketsView, MaintenanceBoardView, MaintenanceCategory, MaintenanceItemKind, MaintenancePlace, MaintenanceSource,
  MaintenanceState, MaintenanceTicketView, MaintenanceUrgency, TaskState,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { TicketRow } from "./store";

/**
 * THE READS: the supervisor's board, the Beds board's ticket line per bed, and the raise sheet's place picker.
 * No patient and no money on any of them (the board is also a wall display); the raiser's and technician's names
 * are staff names, as on the task board.
 */
/** The most tickets the board sends (1920 × 1080 without scrolling); the counts are over every open ticket. */
export const MAINTENANCE_BOARD_LIMIT = 60;
const URGENCY_RANK: Record<string, number> = { critical: 0, urgent: 1, routine: 2 };

type Place = { name: string; code: string; kind: string; floorName: string | null };

/** Each place's name, code and kind, and the FLOOR node above it (walked up the registry's parents). */
async function placesOf(db: Db, ids: readonly string[]): Promise<Map<string, Place>> {
  const out = new Map<string, Place>();
  if (ids.length === 0) return out;
  const rows = await db.execute<{ start: string; kind: string; name: string; code: string; depth: number }>(sql`
    with recursive up as (
      select r.id as start, r.id, r.parent_id, r.kind, r.name, r.code, 0 as depth
        from resources r where r.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      union all
      select up.start, p.id, p.parent_id, p.kind, p.name, p.code, up.depth + 1
        from resources p join up on p.id = up.parent_id where up.depth < 8
    )
    select start, kind, name, code, depth from up order by depth`);
  for (const r of rows.rows) {
    const cur = out.get(r.start) ?? { name: "", code: "", kind: "", floorName: null };
    if (Number(r.depth) === 0) { cur.name = r.name; cur.code = r.code; cur.kind = r.kind; }
    if (r.kind === "floor" && cur.floorName === null) cur.floorName = r.name;
    out.set(r.start, cur);
  }
  return out;
}

function shownState(stored: string, taskState: string | null): MaintenanceState {
  if (stored !== "open") return stored as MaintenanceState;
  if (taskState === "assigned" || taskState === "accepted") return "assigned";
  if (taskState === "in_progress") return "in_progress";
  return "open";
}

async function views(db: Db, rows: readonly TicketRow[], now: Date): Promise<MaintenanceTicketView[]> {
  if (rows.length === 0) return [];
  const places = await placesOf(db, [...new Set(rows.map((r) => r.placeResourceId))]);
  const taskIds = [...new Set(rows.map((r) => r.taskId).filter((x): x is string => x !== null))];
  const taskRows = taskIds.length === 0 ? [] : await db.select({ id: tasks.id, state: tasks.state, assigneeId: tasks.assigneeId })
    .from(tasks).where(inArray(tasks.id, taskIds));
  const taskById = new Map(taskRows.map((t) => [t.id, t]));
  const blockIds = [...new Set(rows.map((r) => r.bedBlockId).filter((x): x is string => x !== null))];
  const blocks = blockIds.length === 0 ? [] : await db.select({ id: ipdBedBlocks.id, status: ipdBedBlocks.status })
    .from(ipdBedBlocks).where(inArray(ipdBedBlocks.id, blockIds));
  const blockById = new Map(blocks.map((b) => [b.id, b.status]));
  const people = [...new Set([...rows.map((r) => r.raisedBy), ...taskRows.map((t) => t.assigneeId).filter((x): x is string => x !== null)])];
  const names = new Map((await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, people))).map((u) => [u.id, u.name]));
  return rows.map((r) => {
    const place = places.get(r.placeResourceId);
    const task = r.taskId === null ? undefined : taskById.get(r.taskId);
    const taskState = task === undefined || task.state === "cancelled" ? null : task.state as TaskState;
    return {
      id: r.id, number: r.number, placeResourceId: r.placeResourceId, placeName: place?.name ?? "", placeCode: place?.code ?? "",
      placeKind: place?.kind ?? "", floorName: place?.floorName ?? null, itemKind: r.itemKind as MaintenanceItemKind, itemTag: r.itemTag,
      category: r.category as MaintenanceCategory, urgency: r.urgency as MaintenanceUrgency, description: r.description,
      source: r.source as MaintenanceSource, state: shownState(r.state, taskState), taskState, taskId: taskState === null ? null : r.taskId,
      bedBlockId: r.bedBlockId, blockOnRelease: r.bedBlockId !== null && blockById.get(r.bedBlockId) === "pending_release",
      replacementFlag: r.replacementFlag, assigneeName: task?.assigneeId == null ? null : names.get(task.assigneeId) ?? null,
      raisedByName: names.get(r.raisedBy) ?? null, raisedAt: r.createdAt.toISOString(), dueAt: r.dueAt.toISOString(),
      fixedAt: r.fixedAt?.toISOString() ?? null, closedAt: r.closedAt?.toISOString() ?? null,
      ageMinutes: Math.max(0, Math.floor((now.getTime() - r.createdAt.getTime()) / 60_000)),
      late: r.state === "open" && r.dueAt.getTime() <= now.getTime(),
    };
  });
}

/** Critical first, then the oldest. */
const boardOrder = (a: MaintenanceTicketView, b: MaintenanceTicketView): number =>
  (URGENCY_RANK[a.urgency]! - URGENCY_RANK[b.urgency]!) || (b.ageMinutes - a.ageMinutes);

export async function maintenanceBoard(db: Db, now: Date = new Date()): Promise<MaintenanceBoardView> {
  const openWhere = inArray(maintenanceTickets.state, ["open", "fixed"]);
  const counted = (await db.select({
    open: sql<number>`count(*) filter (where ${maintenanceTickets.state} = 'open')::int`,
    critical: sql<number>`count(*) filter (where ${maintenanceTickets.state} = 'open' and ${maintenanceTickets.urgency} = 'critical')::int`,
    late: sql<number>`count(*) filter (where ${maintenanceTickets.state} = 'open' and ${maintenanceTickets.dueAt} <= ${now.toISOString()}::timestamptz)::int`,
    toConfirm: sql<number>`count(*) filter (where ${maintenanceTickets.state} = 'fixed')::int`,
    all: sql<number>`count(*)::int`,
  }).from(maintenanceTickets).where(openWhere))[0]!;
  const rows = await db.select().from(maintenanceTickets).where(openWhere)
    .orderBy(sql`case ${maintenanceTickets.urgency} when 'critical' then 0 when 'urgent' then 1 else 2 end`, maintenanceTickets.createdAt)
    .limit(MAINTENANCE_BOARD_LIMIT);
  const all = await views(db, rows, now);
  const open = all.filter((v) => v.state !== "fixed").sort(boardOrder);
  const toConfirm = all.filter((v) => v.state === "fixed").sort((a, b) => b.ageMinutes - a.ageMinutes);

  const byFloor = new Map<string, MaintenanceBoardView["floors"][number]>();
  for (const v of open) {
    const key = v.floorName ?? "";
    const f = byFloor.get(key) ?? { floorName: v.floorName, tickets: [] };
    f.tickets.push(v);
    byFloor.set(key, f);
  }
  const floors = [...byFloor.values()].sort((a, b) =>
    (boardOrder(a.tickets[0]!, b.tickets[0]!)) || (a.floorName ?? "~").localeCompare(b.floorName ?? "~"));

  const blockedRows = await db.select({
    bedId: maintenanceTickets.placeResourceId, number: maintenanceTickets.number, state: maintenanceTickets.state,
    taskState: tasks.state, blockStatus: ipdBedBlocks.status, code: resources.code,
  }).from(maintenanceTickets)
    .innerJoin(ipdBedBlocks, eq(ipdBedBlocks.id, maintenanceTickets.bedBlockId))
    .innerJoin(resources, eq(resources.id, maintenanceTickets.placeResourceId))
    .leftJoin(tasks, eq(tasks.id, maintenanceTickets.taskId))
    .where(and(openWhere, inArray(ipdBedBlocks.status, ["active", "pending_release"])))
    .orderBy(resources.code);
  const seenBed = new Set<string>();
  const blockedBeds: MaintenanceBoardView["blockedBeds"] = [];
  for (const b of blockedRows) {
    if (seenBed.has(b.bedId)) continue;
    seenBed.add(b.bedId);
    blockedBeds.push({
      bedId: b.bedId, bedCode: b.code, ticketNumber: b.number, state: shownState(b.state, b.taskState),
      onRelease: b.blockStatus === "pending_release",
    });
  }

  const since = new Date(now.getTime() - MAINTENANCE_REPEAT_WINDOW_DAYS * 86_400_000);
  const flagged = await db.select({
    placeName: resources.name, itemKind: maintenanceTickets.itemKind, itemTag: maintenanceTickets.itemTag,
    number: maintenanceTickets.number, createdAt: maintenanceTickets.createdAt,
  }).from(maintenanceTickets).innerJoin(resources, eq(resources.id, maintenanceTickets.placeResourceId))
    .where(and(eq(maintenanceTickets.replacementFlag, true), gte(maintenanceTickets.createdAt, since), ne(maintenanceTickets.state, "cancelled")))
    .orderBy(desc(maintenanceTickets.createdAt)).limit(12);

  return {
    serverNow: now.toISOString(), floors, toConfirm, blockedBeds,
    replacement: flagged.map((f) => ({
      placeName: f.placeName, itemKind: f.itemKind as MaintenanceItemKind, itemTag: f.itemTag, ticketNumber: f.number,
      raisedAt: f.createdAt.toISOString(),
    })),
    counts: {
      open: counted.open, critical: counted.critical, late: counted.late, toConfirm: counted.toConfirm,
      blockedBeds: blockedBeds.length, notShown: Math.max(0, counted.all - rows.length),
    },
  };
}

/** The Beds board's line: per bed, its newest open ticket (open or fixed, waiting for the nurse). */
export async function bedTickets(db: Db, now: Date = new Date()): Promise<BedTicketsView> {
  const rows = await db.select().from(maintenanceTickets)
    .innerJoin(resources, eq(resources.id, maintenanceTickets.placeResourceId))
    .where(and(inArray(maintenanceTickets.state, ["open", "fixed"]), eq(resources.kind, "bed")))
    .orderBy(desc(maintenanceTickets.createdAt)).limit(2000);
  const newest = new Map<string, TicketRow>();
  for (const r of rows) if (!newest.has(r.maintenance_tickets.placeResourceId)) newest.set(r.maintenance_tickets.placeResourceId, r.maintenance_tickets);
  const v = await views(db, [...newest.values()], now);
  return {
    serverNow: now.toISOString(),
    tickets: v.map((t) => ({
      bedId: t.placeResourceId, ticketId: t.id, number: t.number, state: t.state, urgency: t.urgency, itemKind: t.itemKind,
      taskId: t.taskId, blockOnRelease: t.blockOnRelease,
    })),
  };
}

/** The raise sheet's picker: beds, rooms, wards, halls and floors in service whose code or name matches. */
export async function placesForRaise(db: Db, q: string): Promise<MaintenancePlace[]> {
  const term = q.trim();
  if (term.length === 0) return [];
  const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = await db.select({ id: resources.id, kind: resources.kind, code: resources.code, name: resources.name }).from(resources)
    .where(and(
      inArray(resources.kind, ["bed", "room", "ward", "hall", "floor"]), ne(resources.status, "retired"),
      or(ilike(resources.code, like), ilike(resources.name, like)), isNotNull(resources.code),
    )).orderBy(resources.code).limit(20);
  const floors = await placesOf(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, floorName: floors.get(r.id)?.floorName ?? null }));
}
