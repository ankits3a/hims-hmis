import { and, asc, desc, eq, gte } from "drizzle-orm";
import { HK_ROUND_GRACE_MIN, HOUSEKEEPING_KINDS, hkSlotAt, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { hkAreas, hkRounds } from "../../kernel/db/schema";
import { getTask, raiseTask } from "../tasks";
import { HOUSEKEEPING_ROUNDS_ACTOR } from "./names";
import type { HkAreaClass, HkRoundStatus, HkRoundView } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * HK-1 (#973) — THE ROUNDS CLOCK, one pass a minute in the worker. For every active area it raises the round of the
 * slot holding `now` (once: the round's (area, slot) is unique, and its task's `sourceRef` is `hk-round:<area>:<slot>`);
 * it never back-fills a slot the clock did not see, so a stopped worker does not flood the floor on restart. A round
 * whose task is not done by its due time plus `HK_ROUND_GRACE_MIN` is MISSED: the board shows it, and its task stays
 * open as late work (the kind's one-rung ladder tells the supervisor). The next slot is still raised.
 *
 * DECIDED: classes A and B are checked by the unit side (a `area_round_checked` task); toilets, public areas and support
 * areas are not checked per round (the supervisor's random inspection scores them, HK-2).
 */
export type RoundsResult = { raised: number; missed: number; done: number; failed: number };

export const roundKindFor = (areaClass: HkAreaClass): string =>
  areaClass === "A" || areaClass === "B" ? HOUSEKEEPING_KINDS.roundChecked : HOUSEKEEPING_KINDS.round;

const DONE_STATES = ["done", "verified"];

export async function runRoundsClock(db: Db, now: Date = new Date()): Promise<RoundsResult> {
  const out: RoundsResult = { raised: 0, missed: 0, done: 0, failed: 0 };
  const areas = await db.select().from(hkAreas).where(eq(hkAreas.active, true));
  for (const area of areas) {
    try {
      const slot = hkSlotAt(area.areaClass as HkAreaClass, now);
      const seen = await db.select({ id: hkRounds.id }).from(hkRounds)
        .where(and(eq(hkRounds.areaId, area.id), eq(hkRounds.slotStart, slot.slotStart)));
      if (seen.length > 0) continue;
      const raised = await withTx(db, async (tx) => {
        const { task } = await raiseTask(tx, HOUSEKEEPING_ROUNDS_ACTOR, {
          kind: roundKindFor(area.areaClass as HkAreaClass), placeResourceId: area.resourceId, dueAt: slot.dueAt.toISOString(),
          sourceRef: `hk-round:${area.id}:${slot.slotStart.toISOString()}`, raisedAt: slot.slotStart.toISOString(),
        }, now);
        const row = await tx.insert(hkRounds).values({ id: newId(), areaId: area.id, slotStart: slot.slotStart, dueAt: slot.dueAt, taskId: task.id })
          .onConflictDoNothing().returning({ id: hkRounds.id });
        return row.length;
      });
      out.raised += raised;
    } catch (e) {
      out.failed += 1;
      console.error(`runRoundsClock: area ${area.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Rounds still due: done when their task is, missed once the grace is over.
  const graceCut = new Date(now.getTime() - HK_ROUND_GRACE_MIN * 60_000);
  const due = await db.select().from(hkRounds).where(eq(hkRounds.status, "due")).orderBy(asc(hkRounds.dueAt)).limit(2000);
  for (const r of due) {
    try {
      const task = await getTask(db, r.taskId);
      if (task !== null && DONE_STATES.includes(task.state)) {
        await db.update(hkRounds).set({ status: "done" }).where(and(eq(hkRounds.id, r.id), eq(hkRounds.status, "due")));
        out.done += 1;
      } else if (r.dueAt <= graceCut) {
        await db.update(hkRounds).set({ status: "missed", missedAt: now }).where(and(eq(hkRounds.id, r.id), eq(hkRounds.status, "due")));
        out.missed += 1;
      }
    } catch (e) {
      out.failed += 1;
      console.error(`runRoundsClock: round ${r.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

const view = (r: typeof hkRounds.$inferSelect): HkRoundView => ({
  id: r.id, areaId: r.areaId, taskId: r.taskId, slotStart: r.slotStart.toISOString(), dueAt: r.dueAt.toISOString(),
  status: r.status as HkRoundStatus,
});

/** One area's rounds, oldest first. */
export async function roundsOf(db: Db, areaId: string, limit = 200): Promise<HkRoundView[]> {
  return (await db.select().from(hkRounds).where(eq(hkRounds.areaId, areaId)).orderBy(asc(hkRounds.slotStart)).limit(limit)).map(view);
}

/** Rounds marked missed at or after `since`, latest due first (the supervisor board). */
export async function missedRounds(db: Db, since: Date, limit = 200): Promise<(typeof hkRounds.$inferSelect)[]> {
  return db.select().from(hkRounds).where(and(eq(hkRounds.status, "missed"), gte(hkRounds.missedAt, since)))
    .orderBy(desc(hkRounds.dueAt)).limit(limit);
}
