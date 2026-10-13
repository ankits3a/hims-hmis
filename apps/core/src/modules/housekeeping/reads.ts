import { and, eq, inArray } from "drizzle-orm";
import { BED_CLEAN_KINDS, HOUSEKEEPING_KINDS, HOUSEKEEPING_KIND_LIST, OPEN_TASK_STATES } from "@hmis/contracts";
import { resources, users } from "../../kernel/db/schema";
import { findTasks, taskBoard } from "../tasks";
import type { BedCleanView, BedCleansView, HousekeepingBoardView, HousekeepingKind, TaskState } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * THE TWO READS. `bedCleans` feeds the Beds board's cleaning clocks: for every bed with a clean still owed (open,
 * or done and waiting for its check), the newest such task. `housekeepingBoard` is the task board over
 * housekeeping's kinds only. Neither carries a patient or money; the Beds board sees the cleaner's INITIALS only
 * (it is also a wall display).
 */
export function initials(name: string): string {
  const words = name.split(/[\s.]+/).filter((w) => /^[\p{L}]/u.test(w));
  return words.slice(0, 3).map((w) => `${w.charAt(0).toUpperCase()}.`).join(" ") || "—";
}

export async function bedCleans(db: Db, now: Date = new Date()): Promise<BedCleansView> {
  const rows = await findTasks(db, { kinds: BED_CLEAN_KINDS, states: [...OPEN_TASK_STATES, "done"], limit: 2000 });
  // Only beds still waiting to be cleaned: a bed the board shows available or occupied has no clock, whatever a
  // not-yet-cancelled task says (the consumer may be a tick behind).
  const places = [...new Set(rows.map((r) => r.placeResourceId).filter((x): x is string => x !== null))];
  const cleaning = places.length === 0 ? new Set<string>() : new Set((await db.select({ id: resources.id }).from(resources)
    .where(and(inArray(resources.id, places), eq(resources.status, "cleaning")))).map((r) => r.id));
  const newest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (r.placeResourceId === null || !cleaning.has(r.placeResourceId)) continue;
    const cur = newest.get(r.placeResourceId);
    if (cur === undefined || r.createdAt > cur.createdAt) newest.set(r.placeResourceId, r);
  }
  const ids = [...new Set([...newest.values()].map((r) => r.assigneeId).filter((x): x is string => x !== null))];
  const names = ids.length === 0 ? new Map<string, string>()
    : new Map((await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]));
  const cleans: BedCleanView[] = [...newest.values()].map((r) => {
    // Stored when raised (the bed's release); a row from before the column falls back to its creation.
    const raisedAt = r.raisedAt ?? r.createdAt;
    return {
      bedId: r.placeResourceId!, taskId: r.id, kind: r.kind as HousekeepingKind, terminal: r.kind === HOUSEKEEPING_KINDS.terminal,
      state: r.state as TaskState, raisedAt: raisedAt.toISOString(), dueAt: r.dueAt.toISOString(),
      minutes: Math.max(0, Math.floor((now.getTime() - raisedAt.getTime()) / 60_000)),
      late: r.state !== "done" && r.dueAt.getTime() <= now.getTime(),
      assigneeInitials: r.assigneeId === null ? null : initials(names.get(r.assigneeId) ?? ""),
      escalatedRung: r.escalatedRung, version: r.version,
    };
  });
  cleans.sort((a, b) => b.minutes - a.minutes);
  return { serverNow: now.toISOString(), cleans };
}

export async function housekeepingBoard(db: Db, now: Date = new Date()): Promise<HousekeepingBoardView> {
  return taskBoard(db, now, { kinds: HOUSEKEEPING_KIND_LIST });
}
