import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { absentUserIds } from "../roster";
import { raiseNotice } from "../../kernel/alerts/notices";
import { resources, taskEvents, tasks } from "../../kernel/db/schema";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { DEFAULT_LADDER_MIN, allSkills, taskKind, taskKinds } from "./kinds";
import { dutyCovering, onDutyForSkill, pickWorker } from "./dispatch";
import { appendTaskEvent, dispatchInto, lockTask, updateTaskRow } from "./engine";
import type { Actor } from "@hmis/contracts";
import type { SQL } from "drizzle-orm";
import type { Db, Tx } from "../../kernel/db/client";
import type { TaskRow } from "./engine";

/**
 * ═══ THE TASK CLOCK — `sweepTasks`, ONE WORKER JOB, EVERY MINUTE ═══
 *
 * Four passes, each over a small batch, each act in its own transaction with the row locked and its
 * precondition re-read under the lock — so a second run (or a second worker) finds nothing left to
 * do and writes nothing. Run it twice: the same result.
 *
 *   1. SHIFT OVER — a held task whose worker's rostered duty has ended, who is on approved leave now,
 *      or who holds it with no recorded shift and no duty now, goes back to the pool and the kind's
 *      supervisors are told. A worker on a back-to-back duty keeps it (the end moves on).
 *   2. NOT ACCEPTED — assigned and not accepted within the kind's window: offered to the next on-duty
 *      worker. With nobody else on, it stays and the window restarts (no event: nothing changed hands).
 *   3. POOL — unassigned tasks are offered again (someone may have come on duty). The worker it was
 *      last returned from is skipped.
 *   4. LATE — past due: the next rung of the kind's ladder fires ONCE (`escalated_rung` is the
 *      watermark, raised under the lock), as an `escalated` event and a bell notice to each holder of
 *      the kind's `escalateTo` role. A worker down for an hour jumps to the highest rung reached, once.
 *
 * Notices carry the task's kind, place and minutes late — never a patient (GC6).
 */
export const SWEEP_ACTOR: Actor = { type: "system", id: "tasks-sweep" };
export const SWEEP_BATCH = 50;

export type SweepResult = { returned: number; redispatched: number; dispatched: number; escalated: number; failed: number };

const tx = <T>(db: Db, fn: (t: Tx) => Promise<T>): Promise<T> => db.transaction(fn);
const HELD = ["assigned", "accepted", "in_progress"];
const OPEN = ["created", ...HELD];

const intArray = (xs: readonly number[]): SQL => sql`array[${sql.join(xs.map((x) => sql`${x}`), sql`, `)}]::int[]`;

/** Each kind's ladder as a SQL expression on the row's kind (unknown kinds: the default ladder). */
function ladderSql(): SQL {
  const kinds = taskKinds();
  if (kinds.length === 0) return intArray(DEFAULT_LADDER_MIN);
  return sql`(case ${tasks.kind} ${sql.join(kinds.map((k) => sql`when ${k.kind} then ${intArray(k.ladderMin ?? DEFAULT_LADDER_MIN)}`), sql` `)} else ${intArray(DEFAULT_LADDER_MIN)} end)`;
}

/** Each kind's accept window in minutes, as a SQL expression (unknown kinds: 5). */
function acceptWindowSql(): SQL {
  const kinds = taskKinds();
  if (kinds.length === 0) return sql`5`;
  return sql`(case ${tasks.kind} ${sql.join(kinds.map((k) => sql`when ${k.kind} then ${k.acceptWithinMin}`), sql` `)} else 5 end)`;
}

function log(pass: string, e: unknown, taskId?: string): void {
  console.error(`sweepTasks: ${pass}${taskId === undefined ? "" : ` (task ${taskId})`} failed: ${e instanceof Error ? e.message : String(e)}`);
}

/**
 * Every pass is isolated (a throw is logged and the next pass still runs), and every row inside a pass
 * too. Each pass SELECTS ONLY ROWS IT CAN ACT ON — the next rung actually due, the accept window actually
 * past, a skill somebody on duty holds — so a batch is never filled by rows it will skip, and one pile
 * cannot starve the rest (review of PR #747, RED 1 and 5).
 */
export async function sweepTasks(db: Db, now: Date = new Date()): Promise<SweepResult> {
  const out: SweepResult = { returned: 0, redispatched: 0, dispatched: 0, escalated: 0, failed: 0 };
  const passes: [string, () => Promise<void>][] = [
    ["shift over", () => passShiftOver(db, now, out)],
    ["not accepted", () => passNotAccepted(db, now, out)],
    ["pool", () => passPool(db, now, out)],
    ["late", () => passLate(db, now, out)],
  ];
  for (const [name, run] of passes) {
    try { await run(); } catch (e) { out.failed += 1; log(name, e); }
  }
  return out;
}

/* 1 · shift over, or on approved leave, or held with no known shift and no duty now */
async function passShiftOver(db: Db, now: Date, out: SweepResult): Promise<void> {
  const away = new Set(await absentUserIds(db, now, new Date(now.getTime() + 1)));
  const ending = await db.select().from(tasks).where(and(
    inArray(tasks.state, HELD), eq(tasks.assigneeKind, "person"),
    or(lte(tasks.shiftEndsAt, now), isNull(tasks.shiftEndsAt), ...(away.size === 0 ? [] : [inArray(tasks.assigneeId, [...away])])),
  )).orderBy(asc(tasks.shiftEndsAt)).limit(SWEEP_BATCH);
  for (const seen of ending) {
    try {
      const returned = await tx(db, async (t) => {
        const row = await lockTask(t, seen.id);
        if (!HELD.includes(row.state) || row.assigneeId === null) return null;
        const onLeave = away.has(row.assigneeId);
        if (!onLeave) {
          if (row.shiftEndsAt !== null && row.shiftEndsAt > now) return null;
          const duty = await dutyCovering(t, row.assigneeId, now);
          if (duty !== null) {
            // Still on (a back-to-back duty, or a shift never recorded): carry the end. Not a change of hands, no event.
            await t.update(tasks).set({ shiftEndsAt: duty.endsAt }).where(eq(tasks.id, row.id));
            return null;
          }
        }
        const next = await updateTaskRow(t, row.id, {
          state: "created", assigneeKind: null, assigneeId: null, assignedAt: null, shiftEndsAt: null,
        }, now);
        await appendTaskEvent(t, next, "returned", SWEEP_ACTOR, "system", now, { from: row.assigneeId, reason: onLeave ? "on_leave" : "shift_ended" });
        await tellSupervisors(t, next, "returned", now, `task:${next.id}:returned:${next.version}`);
        return next;
      });
      if (returned !== null) out.returned += 1;
    } catch (e) { out.failed += 1; log("shift over", e, seen.id); }
  }
}

/* 2 · assigned and not accepted within the kind's window */
async function passNotAccepted(db: Db, now: Date, out: SweepResult): Promise<void> {
  const waiting = await db.select().from(tasks).where(and(
    eq(tasks.state, "assigned"), eq(tasks.assigneeKind, "person"),
    sql`${tasks.assignedAt} + make_interval(mins => ${acceptWindowSql()}) <= ${now.toISOString()}::timestamptz`,
  )).orderBy(asc(tasks.assignedAt)).limit(SWEEP_BATCH);
  for (const seen of waiting) {
    try {
      const windowMs = (taskKind(seen.kind)?.acceptWithinMin ?? 5) * 60_000;
      const moved = await tx(db, async (t) => {
        const row = await lockTask(t, seen.id);
        if (row.state !== "assigned" || row.assignedAt === null || row.assignedAt.getTime() + windowMs > now.getTime()) return false;
        const next = await pickWorker(t, row.skill, now, row.assigneeId === null ? [] : [row.assigneeId]);
        if (next === null) {
          await t.update(tasks).set({ assignedAt: now }).where(eq(tasks.id, row.id));
          return false;
        }
        const after = await updateTaskRow(t, row.id, {
          assigneeKind: "person", assigneeId: next.userId, assignedAt: now, shiftEndsAt: next.shiftEndsAt,
        }, now);
        await appendTaskEvent(t, after, "redispatched", SWEEP_ACTOR, "system", now, { from: row.assigneeId, to: next.userId, reason: "not_accepted" });
        return true;
      });
      if (moved) out.redispatched += 1;
    } catch (e) { out.failed += 1; log("not accepted", e, seen.id); }
  }
}

/* 3 · the pool — only skills somebody on duty holds */
async function passPool(db: Db, now: Date, out: SweepResult): Promise<void> {
  const staffed: string[] = [];
  for (const skill of allSkills()) if ((await onDutyForSkill(db, skill, now)).length > 0) staffed.push(skill);
  if (staffed.length === 0) return;
  const pool = await db.select().from(tasks).where(and(eq(tasks.state, "created"), isNull(tasks.assigneeId), inArray(tasks.skill, staffed)))
    .orderBy(asc(tasks.dueAt)).limit(SWEEP_BATCH);
  for (const seen of pool) {
    try {
      const lastFrom = await lastReturnedFrom(db, seen.id);
      const done = await tx(db, async (t) => {
        const row = await lockTask(t, seen.id);
        if (row.state !== "created" || row.assigneeId !== null) return null;
        return dispatchInto(t, row, now, lastFrom === null ? [] : [lastFrom]);
      });
      if (done !== null) out.dispatched += 1;
    } catch (e) { out.failed += 1; log("pool", e, seen.id); }
  }
}

/* 4 · late: only rows whose NEXT rung is due */
async function passLate(db: Db, now: Date, out: SweepResult): Promise<void> {
  const ladder = ladderSql();
  const late = await db.select().from(tasks).where(and(
    inArray(tasks.state, OPEN),
    sql`${tasks.escalatedRung} < cardinality(${ladder})`,
    sql`${tasks.dueAt} + make_interval(mins => (${ladder})[${tasks.escalatedRung} + 1]) <= ${now.toISOString()}::timestamptz`,
  )).orderBy(asc(tasks.dueAt)).limit(SWEEP_BATCH);
  for (const seen of late) {
    try {
      const steps = taskKind(seen.kind)?.ladderMin ?? DEFAULT_LADDER_MIN;
      const rungFor = (row: TaskRow): number => steps.filter((m) => row.dueAt.getTime() + m * 60_000 <= now.getTime()).length;
      // The rung and its notices commit together: a bell that fails rolls the rung back, and the next tick retries both.
      const raised = await tx(db, async (t) => {
        const row = await lockTask(t, seen.id);
        const rung = rungFor(row);
        if (!OPEN.includes(row.state) || rung <= row.escalatedRung) return null;
        const next = await updateTaskRow(t, row.id, { escalatedRung: rung }, now);
        await appendTaskEvent(t, next, "escalated", SWEEP_ACTOR, "system", now, {
          rung, minutesLate: Math.floor((now.getTime() - row.dueAt.getTime()) / 60_000), to: taskKind(row.kind)?.escalateTo ?? null,
        });
        await tellSupervisors(t, next, "late", now, `task:${next.id}:rung:${next.escalatedRung}`);
        return next;
      });
      if (raised !== null) out.escalated += 1;
    } catch (e) { out.failed += 1; log("late", e, seen.id); }
  }
}

async function lastReturnedFrom(db: Db, taskId: string): Promise<string | null> {
  const ev = (await db.select({ detail: taskEvents.detail }).from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.act, "returned")))
    .orderBy(desc(taskEvents.seq)).limit(1))[0];
  const from = ev?.detail.from;
  return typeof from === "string" ? from : null;
}

/** The bell notice to every holder of the kind's escalation role. The key absorbs a second run. */
async function tellSupervisors(db: Db | Tx, row: TaskRow, why: "late" | "returned", now: Date, sourceKey: string): Promise<void> {
  const kind = taskKind(row.kind);
  const role = kind?.escalateTo;
  if (role === undefined) return;
  const holders = await usersHoldingRole(db as Tx, role);
  if (holders.length === 0) return;
  const place = row.placeResourceId === null ? null
    : (await (db as Db).select({ name: resources.name }).from(resources).where(eq(resources.id, row.placeResourceId)))[0]?.name ?? null;
  const label = kind?.label ?? row.kind;
  const minutes = Math.max(0, Math.floor((now.getTime() - row.dueAt.getTime()) / 60_000));
  const title = why === "late" ? `Task late: ${label}` : `Task back in pool: ${label}`;
  const body = [place, why === "late" ? `${minutes} min late` : "worker off shift"].filter((s) => s !== null).join(" · ");
  for (const userId of holders) {
    await raiseNotice(db as Db, {
      userId, kind: why === "late" ? "task.late" : "task.returned", title, body,
      refType: "task", refId: row.id, sourceKey, at: now,
    });
  }
}
