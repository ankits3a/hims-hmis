import { and, asc, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { raiseNotice } from "../../kernel/alerts/notices";
import { resources, taskEvents, tasks } from "../../kernel/db/schema";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { DEFAULT_LADDER_MIN, taskKind } from "./kinds";
import { dutyCovering, pickWorker } from "./dispatch";
import { appendTaskEvent, dispatchInto, lockTask, updateTaskRow } from "./engine";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { TaskRow } from "./engine";

/**
 * ═══ THE TASK CLOCK — `sweepTasks`, ONE WORKER JOB, EVERY MINUTE ═══
 *
 * Four passes, each over a small batch, each act in its own transaction with the row locked and its
 * precondition re-read under the lock — so a second run (or a second worker) finds nothing left to
 * do and writes nothing. Run it twice: the same result.
 *
 *   1. SHIFT OVER — a held task whose worker's rostered duty has ended goes back to the pool and the
 *      kind's supervisors are told. A worker on a back-to-back duty keeps it (the end moves on).
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

export type SweepResult = { returned: number; redispatched: number; dispatched: number; escalated: number };

const tx = <T>(db: Db, fn: (t: Tx) => Promise<T>): Promise<T> => db.transaction(fn);
const HELD = ["assigned", "accepted", "in_progress"];
const OPEN = ["created", ...HELD];

export async function sweepTasks(db: Db, now: Date = new Date()): Promise<SweepResult> {
  const out: SweepResult = { returned: 0, redispatched: 0, dispatched: 0, escalated: 0 };

  /* 1 · shift over */
  const ending = await db.select().from(tasks).where(and(
    inArray(tasks.state, HELD), eq(tasks.assigneeKind, "person"), lte(tasks.shiftEndsAt, now),
  )).orderBy(asc(tasks.shiftEndsAt)).limit(SWEEP_BATCH);
  for (const seen of ending) {
    const returned = await tx(db, async (t) => {
      const row = await lockTask(t, seen.id);
      if (!HELD.includes(row.state) || row.shiftEndsAt === null || row.shiftEndsAt > now || row.assigneeId === null) return null;
      const duty = await dutyCovering(t, row.assigneeId, now);
      if (duty !== null) {
        // Still on (a back-to-back duty): carry the end forward. Not a change of hands, so no event.
        await t.update(tasks).set({ shiftEndsAt: duty.endsAt }).where(eq(tasks.id, row.id));
        return null;
      }
      const next = await updateTaskRow(t, row.id, {
        state: "created", assigneeKind: null, assigneeId: null, assignedAt: null, shiftEndsAt: null,
      }, now);
      await appendTaskEvent(t, next, "returned", SWEEP_ACTOR, "system", now, { from: row.assigneeId, reason: "shift_ended" });
      return next;
    });
    if (returned !== null) {
      out.returned += 1;
      await tellSupervisors(db, returned, "returned", now, `task:${returned.id}:returned:${returned.version}`);
    }
  }

  /* 2 · not accepted in time */
  const waiting = await db.select().from(tasks).where(and(eq(tasks.state, "assigned"), eq(tasks.assigneeKind, "person")))
    .orderBy(asc(tasks.assignedAt)).limit(SWEEP_BATCH);
  for (const seen of waiting) {
    const windowMs = (taskKind(seen.kind)?.acceptWithinMin ?? 5) * 60_000;
    if (seen.assignedAt === null || seen.assignedAt.getTime() + windowMs > now.getTime()) continue;
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
  }

  /* 3 · the pool */
  const pool = await db.select().from(tasks).where(and(eq(tasks.state, "created"), isNull(tasks.assigneeId)))
    .orderBy(asc(tasks.dueAt)).limit(SWEEP_BATCH);
  for (const seen of pool) {
    const lastFrom = await lastReturnedFrom(db, seen.id);
    const done = await tx(db, async (t) => {
      const row = await lockTask(t, seen.id);
      if (row.state !== "created" || row.assigneeId !== null) return null;
      return dispatchInto(t, row, now, lastFrom === null ? [] : [lastFrom]);
    });
    if (done !== null) out.dispatched += 1;
  }

  /* 4 · late: the ladder */
  const late = await db.select().from(tasks).where(and(inArray(tasks.state, OPEN), lte(tasks.dueAt, now)))
    .orderBy(asc(tasks.dueAt)).limit(SWEEP_BATCH);
  for (const seen of late) {
    const ladder = taskKind(seen.kind)?.ladderMin ?? DEFAULT_LADDER_MIN;
    const rungFor = (row: TaskRow): number => ladder.filter((m) => row.dueAt.getTime() + m * 60_000 <= now.getTime()).length;
    if (rungFor(seen) <= seen.escalatedRung) continue;
    const raised = await tx(db, async (t) => {
      const row = await lockTask(t, seen.id);
      const rung = rungFor(row);
      if (!OPEN.includes(row.state) || rung <= row.escalatedRung) return null;
      const next = await updateTaskRow(t, row.id, { escalatedRung: rung }, now);
      await appendTaskEvent(t, next, "escalated", SWEEP_ACTOR, "system", now, {
        rung, minutesLate: Math.floor((now.getTime() - row.dueAt.getTime()) / 60_000), to: taskKind(row.kind)?.escalateTo ?? null,
      });
      return next;
    });
    if (raised !== null) {
      out.escalated += 1;
      await tellSupervisors(db, raised, "late", now, `task:${raised.id}:rung:${raised.escalatedRung}`);
    }
  }
  return out;
}

async function lastReturnedFrom(db: Db, taskId: string): Promise<string | null> {
  const ev = (await db.select({ detail: taskEvents.detail }).from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.act, "returned")))
    .orderBy(desc(taskEvents.seq)).limit(1))[0];
  const from = ev?.detail.from;
  return typeof from === "string" ? from : null;
}

/** The bell notice to every holder of the kind's escalation role. The key absorbs a second run. */
async function tellSupervisors(db: Db, row: TaskRow, why: "late" | "returned", now: Date, sourceKey: string): Promise<void> {
  const kind = taskKind(row.kind);
  const role = kind?.escalateTo;
  if (role === undefined) return;
  const holders = await tx(db, (t) => usersHoldingRole(t, role));
  if (holders.length === 0) return;
  const place = row.placeResourceId === null ? null
    : (await db.select({ name: resources.name }).from(resources).where(eq(resources.id, row.placeResourceId)))[0]?.name ?? null;
  const label = kind?.label ?? row.kind;
  const minutes = Math.max(0, Math.floor((now.getTime() - row.dueAt.getTime()) / 60_000));
  const title = why === "late" ? `Task late: ${label}` : `Task back in pool: ${label}`;
  const body = [place, why === "late" ? `${minutes} min late` : "worker off shift"].filter((s) => s !== null).join(" · ");
  for (const userId of holders) {
    await raiseNotice(db, {
      userId, kind: why === "late" ? "task.late" : "task.returned", title, body,
      refType: "task", refId: row.id, sourceKey, at: now,
    });
  }
}
