import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { tasks, users } from "../../kernel/db/schema";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { allSkills, skillRoles, taskKind } from "./kinds";
import { eligibilityOf, onDutyForSkill, openLoad } from "./dispatch";
import type { BoardFloor, BoardWorker, MyTasksView, TaskBoardView, TaskCard, TaskPriority, TaskProofKind, TaskState } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { TaskRow } from "./engine";

/**
 * THE TWO READ MODELS: a worker's own list and the supervisor's board. Neither carries a patient's
 * identity (a wall board shows no names, spec IPD core §0A.9) nor any money.
 */
const OPEN = ["created", "assigned", "accepted", "in_progress"];
const PRIORITY_RANK: Record<string, number> = { stat: 0, urgent: 1, routine: 2 };
const PRIORITY_SQL = sql`case ${tasks.priority} when 'stat' then 0 when 'urgent' then 1 else 2 end`;
/** The most rows the board sends; the counts are over every open task regardless. */
export const BOARD_ROW_LIMIT = 400;

type Place = { name: string; code: string; floorId: string | null; floorName: string | null };

/** Each place's own name and code, and the FLOOR node above it in the registry (walked up the parents). */
async function placesOf(exec: Db | Tx, ids: readonly string[]): Promise<Map<string, Place>> {
  const out = new Map<string, Place>();
  if (ids.length === 0) return out;
  const rows = await (exec as Db).execute<{ start: string; id: string; kind: string; name: string; code: string; depth: number }>(sql`
    with recursive up as (
      select r.id as start, r.id, r.parent_id, r.kind, r.name, r.code, 0 as depth
        from resources r where r.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      union all
      select up.start, p.id, p.parent_id, p.kind, p.name, p.code, up.depth + 1
        from resources p join up on p.id = up.parent_id where up.depth < 8
    )
    select start, id, kind, name, code, depth from up`);
  for (const r of rows.rows) {
    const cur = out.get(r.start) ?? { name: "", code: "", floorId: null, floorName: null };
    if (r.depth === 0) { cur.name = r.name; cur.code = r.code; }
    if (r.kind === "floor" && cur.floorId === null) { cur.floorId = r.id; cur.floorName = r.name; }
    out.set(r.start, cur);
  }
  return out;
}

async function namesOf(exec: Db | Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await (exec as Db).select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** `withNote: false` for the board and the wall: free text typed by a requester stays on the worker's own card. */
async function cards(exec: Db | Tx, rows: readonly TaskRow[], opts: { withNote: boolean }): Promise<TaskCard[]> {
  const places = await placesOf(exec, [...new Set(rows.map((r) => r.placeResourceId).filter((p): p is string => p !== null))]);
  const names = await namesOf(exec, [...new Set(rows.filter((r) => r.assigneeKind === "person").map((r) => r.assigneeId!))]);
  return rows.map((r) => {
    const place = r.placeResourceId === null ? undefined : places.get(r.placeResourceId);
    return {
      id: r.id, kind: r.kind, label: taskKind(r.kind)?.label ?? r.kind,
      priority: r.priority as TaskPriority, state: r.state as TaskState,
      placeResourceId: r.placeResourceId, placeName: place?.name ?? null, placeCode: place?.code ?? null,
      floorName: place?.floorName ?? null, note: opts.withNote ? r.note : null,
      dueAt: r.dueAt.toISOString(), createdAt: r.createdAt.toISOString(),
      assigneeId: r.assigneeId, assigneeName: r.assigneeId === null ? null : names.get(r.assigneeId) ?? null,
      proofNeeded: r.proofNeeded as TaskProofKind, verifyRequired: r.verifyRequired,
      mergedCount: r.mergedCount, escalatedRung: r.escalatedRung, version: r.version,
    };
  });
}

const urgentFirst = (a: TaskRow, b: TaskRow): number =>
  (PRIORITY_RANK[a.priority]! - PRIORITY_RANK[b.priority]!) || (a.dueAt.getTime() - b.dueAt.getTime());

/** The pool rows a worker's list shows, and how many are read to find them once eligibility narrows the pool. */
const POOL_SHOWN = 20;
const POOL_SCAN = 200;

/** My held tasks, then the pool tasks of the skills my roles carry (Accept takes one from the pool). */
export async function myTasks(db: Db, userId: string, now: Date = new Date()): Promise<MyTasksView> {
  const mine = (await db.select().from(tasks).where(and(
    eq(tasks.assigneeKind, "person"), eq(tasks.assigneeId, userId), inArray(tasks.state, ["assigned", "accepted", "in_progress"]),
  ))).sort(urgentFirst);

  const mySkills: string[] = [];
  for (const skill of allSkills()) {
    for (const role of skillRoles(skill)) {
      if ((await db.transaction((t) => usersHoldingRole(t, role))).includes(userId)) { mySkills.push(skill); break; }
    }
  }
  // Ordered by priority THEN due time in the database, before the limit: a STAT task is never cut off
  // behind twenty earlier routine ones.
  const candidates = mySkills.length === 0 ? [] : await db.select().from(tasks).where(and(
    eq(tasks.state, "created"), isNull(tasks.assigneeId), inArray(tasks.skill, mySkills),
  )).orderBy(PRIORITY_SQL, asc(tasks.dueAt)).limit(POOL_SCAN);
  // HK-1 (#973): a kind with an eligibility shows its pool task only to the people who may take it.
  const pool: TaskRow[] = [];
  for (const r of candidates) {
    if (pool.length >= POOL_SHOWN) break;
    const eligible = await eligibilityOf(db, r, now);
    if (eligible === null || eligible.userIds.includes(userId)) pool.push(r);
  }

  return { serverNow: now.toISOString(), mine: await cards(db, mine, { withNote: true }), pool: await cards(db, pool, { withNote: true }) };
}

/**
 * The supervisor's board: open tasks grouped by floor, LATE FIRST (most late on top), then by
 * priority and due time; floors with the most late work first. Workers: everyone on duty for any
 * skill, plus anyone still holding an open task, with their load.
 */
export async function taskBoard(db: Db, now: Date = new Date(), opts: { kinds?: readonly string[] } = {}): Promise<TaskBoardView> {
  // An owning module's board (housekeeping) is the same board over its own kinds only.
  const ofKinds = opts.kinds === undefined ? [] : [inArray(tasks.kind, [...opts.kinds])];
  const open = await db.select().from(tasks).where(and(inArray(tasks.state, OPEN), ...ofKinds)).orderBy(asc(tasks.dueAt)).limit(BOARD_ROW_LIMIT);
  const totals = (await db.select({
    open: sql<number>`count(*)::int`,
    late: sql<number>`count(*) filter (where ${tasks.dueAt} <= ${now.toISOString()}::timestamptz)::int`,
    pool: sql<number>`count(*) filter (where ${tasks.state} = 'created')::int`,
  }).from(tasks).where(and(inArray(tasks.state, OPEN), ...ofKinds)))[0]!;
  const toVerify = await db.select().from(tasks).where(and(eq(tasks.state, "done"), eq(tasks.verifyRequired, true), ...ofKinds))
    .orderBy(asc(tasks.doneAt)).limit(50);
  const openCards = await cards(db, open, { withNote: false });
  const isLate = (c: TaskCard): boolean => Date.parse(c.dueAt) <= now.getTime();
  const sortCards = (a: TaskCard, b: TaskCard): number =>
    (Number(isLate(b)) - Number(isLate(a)))
    || (Date.parse(a.dueAt) - Date.parse(b.dueAt))
    || (PRIORITY_RANK[a.priority]! - PRIORITY_RANK[b.priority]!);

  const byFloor = new Map<string, BoardFloor>();
  for (const c of openCards) {
    const key = c.floorName ?? "";
    const floor = byFloor.get(key) ?? { floorId: null, floorName: c.floorName, tasks: [] };
    floor.tasks.push(c);
    byFloor.set(key, floor);
  }
  const floors = [...byFloor.values()];
  for (const f of floors) f.tasks.sort(sortCards);
  const lateCount = (f: BoardFloor): number => f.tasks.filter(isLate).length;
  floors.sort((a, b) => (lateCount(b) - lateCount(a)) || (a.floorName ?? "~").localeCompare(b.floorName ?? "~"));

  const onDuty = new Set<string>();
  for (const skill of allSkills()) for (const w of await onDutyForSkill(db, skill, now)) onDuty.add(w.userId);
  const holders = new Set(open.filter((r) => r.assigneeKind === "person" && r.assigneeId !== null).map((r) => r.assigneeId!));
  const people = [...new Set([...onDuty, ...holders])];
  const load = await openLoad(db, people);
  const names = await namesOf(db, people);
  const inProgress = new Map<string, number>();
  for (const r of open) if (r.state === "in_progress" && r.assigneeId !== null) inProgress.set(r.assigneeId, (inProgress.get(r.assigneeId) ?? 0) + 1);
  const workers: BoardWorker[] = people.map((userId) => ({
    userId, name: names.get(userId) ?? "", onDuty: onDuty.has(userId), open: load.get(userId) ?? 0, inProgress: inProgress.get(userId) ?? 0,
  })).sort((a, b) => (b.open - a.open) || a.name.localeCompare(b.name));

  return {
    serverNow: now.toISOString(),
    floors,
    workers,
    toVerify: await cards(db, toVerify, { withNote: false }),
    counts: { open: totals.open, late: totals.late, pool: totals.pool, notShown: Math.max(0, totals.open - openCards.length) },
  };
}

/**
 * For an owning module: its own tasks, by kind and optionally place, state and age. Housekeeping asks
 * "is there already a clean for this bed since its release?" and "which cleans are open on this bed?".
 */
export async function findTasks(
  exec: Db | Tx,
  q: {
    kinds: readonly string[]; placeResourceId?: string; states?: readonly string[]; createdSince?: Date;
    /** Raised (or, for older rows, created) at or before this instant. */
    raisedUntil?: Date; limit?: number;
  },
): Promise<TaskRow[]> {
  if (q.kinds.length === 0) return [];
  return (exec as Db).select().from(tasks).where(and(
    inArray(tasks.kind, [...q.kinds]),
    ...(q.placeResourceId === undefined ? [] : [eq(tasks.placeResourceId, q.placeResourceId)]),
    ...(q.states === undefined ? [] : [inArray(tasks.state, [...q.states])]),
    ...(q.createdSince === undefined ? [] : [sql`${tasks.createdAt} >= ${q.createdSince.toISOString()}::timestamptz`]),
    ...(q.raisedUntil === undefined ? [] : [sql`coalesce(${tasks.raisedAt}, ${tasks.createdAt}) <= ${q.raisedUntil.toISOString()}::timestamptz`]),
  )).orderBy(desc(tasks.createdAt)).limit(q.limit ?? 500);
}

export async function getTask(exec: Db | Tx, taskId: string): Promise<TaskRow | null> {
  return (await (exec as Db).select().from(tasks).where(eq(tasks.id, taskId)))[0] ?? null;
}
