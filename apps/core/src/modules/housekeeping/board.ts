import { eq, inArray } from "drizzle-orm";
import { HK_IN_HOUSE, HOUSEKEEPING_KIND_LIST, OPEN_TASK_STATES, hkShiftAt } from "@hmis/contracts";
import { hkAreas, resources, users } from "../../kernel/db/schema";
import { findTasks, getTask, openLoad, rejectionsOf, taskKinds } from "../tasks";
import { NEEDS_YOU_AFTER } from "./cleans";
import { ancestry } from "./places";
import { initials } from "./reads";
import { missedRounds } from "./rounds";
import { publishedRotaAt } from "./rota";
import { staffFacts } from "./setup";
import type { HkMissedRound, HkNeedsYou, HkPerson, HkSupervisorView } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { TaskRow } from "../tasks";

/**
 * HK-1 (#973) — THE SUPERVISOR BOARD's housekeeping read: rounds missed this shift, tasks that failed their check
 * twice ("Needs you"), and the people on the published rota with their company and open load. A wall display: the
 * people on a missed round or a failed task show as INITIALS; the people list is the supervisor's own (names).
 */
export async function supervisorBoard(db: Db, now: Date = new Date()): Promise<HkSupervisorView> {
  const shift = hkShiftAt(now);
  const missedRows = await missedRounds(db, shift.startsAt);
  const taskIds = [...new Set(missedRows.map((r) => r.taskId))];
  const held = (await Promise.all(taskIds.map((id) => getTask(db, id)))).filter((t): t is TaskRow => t !== null);
  const taskById = new Map(held.map((t) => [t.id, t]));
  const areaIds = [...new Set(missedRows.map((r) => r.areaId))];
  const areaRows = areaIds.length === 0 ? [] : await db.select({ id: hkAreas.id, resourceId: hkAreas.resourceId, floorId: hkAreas.floorId, name: resources.name })
    .from(hkAreas).innerJoin(resources, eq(resources.id, hkAreas.resourceId)).where(inArray(hkAreas.id, areaIds));
  const areaById = new Map(areaRows.map((a) => [a.id, a]));
  const floorIds = [...new Set(areaRows.map((a) => a.floorId).filter((f): f is string => f !== null))];
  const floorNames = floorIds.length === 0 ? new Map<string, string>()
    : new Map((await db.select({ id: resources.id, name: resources.name }).from(resources).where(inArray(resources.id, floorIds))).map((f) => [f.id, f.name]));

  const openTasks = await findTasks(db, { kinds: HOUSEKEEPING_KIND_LIST, states: [...OPEN_TASK_STATES, "done"], limit: 2000 });
  const fails = await rejectionsOf(db, openTasks.map((t) => t.id));
  const needy = openTasks.filter((t) => (fails.get(t.id)?.count ?? 0) >= NEEDS_YOU_AFTER);

  const nameIds = [...new Set([...held, ...needy].map((t) => t.assigneeId).filter((x): x is string => x !== null))];
  const names = nameIds.length === 0 ? new Map<string, string>()
    : new Map((await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, nameIds))).map((u) => [u.id, u.name]));
  const initialsOf = (id: string | null): string | null => (id === null ? null : initials(names.get(id) ?? ""));

  const missed: HkMissedRound[] = missedRows.map((r) => {
    const a = areaById.get(r.areaId);
    return {
      areaId: r.areaId, areaName: a?.name ?? "", floorName: a?.floorId ? floorNames.get(a.floorId) ?? null : null, taskId: r.taskId,
      slotStart: r.slotStart.toISOString(), dueAt: r.dueAt.toISOString(), assigneeInitials: initialsOf(taskById.get(r.taskId)?.assigneeId ?? null),
    };
  });

  const labels = new Map(taskKinds().map((k) => [k.kind, k.label]));
  const needsYou: HkNeedsYou[] = [];
  for (const t of needy) {
    const place = t.placeResourceId === null ? null : (await ancestry(db, t.placeResourceId))[0]?.name ?? null;
    needsYou.push({
      taskId: t.id, kind: labels.get(t.kind) ?? t.kind, placeName: place, fails: fails.get(t.id)!.count,
      reason: fails.get(t.id)!.lastReason, assigneeInitials: initialsOf(t.assigneeId),
    });
  }

  const rota = await publishedRotaAt(db, now);
  const people: HkPerson[] = [];
  if (rota !== null) {
    const ids = rota.places.map((p) => p.userId);
    const facts = await staffFacts(db, ids);
    const load = await openLoad(db, ids);
    const personNames = new Map((await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]));
    for (const p of rota.places) {
      const placement = p.mode === "floor" ? "Floor" : p.mode === "route" ? `Route · ${String(p.areaIds.length)} areas` : `Beds · ${String(p.bedIds.length)}`;
      people.push({ userId: p.userId, name: personNames.get(p.userId) ?? "", company: facts.get(p.userId)?.company ?? HK_IN_HOUSE, placement, load: load.get(p.userId) ?? 0 });
    }
    people.sort((a, b) => b.load - a.load || a.name.localeCompare(b.name));
  }
  return { serverNow: now.toISOString(), missed, needsYou, people };
}
