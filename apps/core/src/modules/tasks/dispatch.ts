import { and, eq, inArray, sql } from "drizzle-orm";
import { absentUserIds, dutiesOf } from "../roster";
import { tasks, users } from "../../kernel/db/schema";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { skillRoles, taskKind } from "./kinds";
import type { TaskEligibility } from "./kinds";
import type { TaskRow } from "./engine";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * WHO IS ON DUTY FOR A SKILL, AND WHO GETS THE NEXT TASK.
 *
 * On duty = holds one of the skill's roles, is active, is not on leave (roster `absentUserIds`), and
 * has a published PRESENCE duty covering the instant (roster `dutiesOf`). A person with no rostered
 * duty is never on duty here: the engine must not hand a cleaning task to someone at home.
 *
 * Dispatch = fewest open tasks (assigned, accepted, in progress); ties by earliest shift start, then
 * by id so the answer is deterministic.
 */
export type OnDutyWorker = { userId: string; shiftStartsAt: Date; shiftEndsAt: Date };

/** The presence duty covering `at` for this one person, or null. */
export async function dutyCovering(exec: Db | Tx, userId: string, at: Date): Promise<{ startsAt: Date; endsAt: Date } | null> {
  const duties = (await dutiesOf(exec, userId, at, new Date(at.getTime() + 1)))
    .filter((d) => d.kind !== "off" && d.mode === "presence" && d.startsAt <= at && d.endsAt > at);
  if (duties.length === 0) return null;
  return {
    startsAt: new Date(Math.min(...duties.map((d) => d.startsAt.getTime()))),
    endsAt: new Date(Math.max(...duties.map((d) => d.endsAt.getTime()))),
  };
}

export async function onDutyForSkill(exec: Db | Tx, skill: string, at: Date): Promise<OnDutyWorker[]> {
  const roles = skillRoles(skill);
  if (roles.length === 0) return [];
  const holders = new Set<string>();
  for (const role of roles) for (const u of await usersHoldingRole(exec as Tx, role)) holders.add(u);
  if (holders.size === 0) return [];

  const active = await (exec as Db).select({ id: users.id }).from(users)
    .where(and(inArray(users.id, [...holders]), eq(users.active, true)));
  const away = new Set(await absentUserIds(exec, at, new Date(at.getTime() + 1)));

  const out: OnDutyWorker[] = [];
  for (const { id } of active) {
    if (away.has(id)) continue;
    const duty = await dutyCovering(exec, id, at);
    if (duty !== null) out.push({ userId: id, shiftStartsAt: duty.startsAt, shiftEndsAt: duty.endsAt });
  }
  return out;
}

/** Open tasks held per person (assigned, accepted or in progress). */
export async function openLoad(exec: Db | Tx, userIds: readonly string[]): Promise<Map<string, number>> {
  const load = new Map<string, number>(userIds.map((u) => [u, 0]));
  if (userIds.length === 0) return load;
  const rows = await (exec as Db)
    .select({ userId: tasks.assigneeId, n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(
      eq(tasks.assigneeKind, "person"),
      inArray(tasks.assigneeId, [...userIds]),
      inArray(tasks.state, ["assigned", "accepted", "in_progress"]),
    ))
    .groupBy(tasks.assigneeId);
  for (const r of rows) if (r.userId !== null) load.set(r.userId, r.n);
  return load;
}

/** HK-1 (#973) — the owning kind's answer to who may hold this task, or null (anyone with the skill). */
export async function eligibilityOf(exec: Db | Tx, row: TaskRow, now: Date): Promise<TaskEligibility | null> {
  const decl = taskKind(row.kind);
  return decl?.eligible === undefined ? null : decl.eligible(exec, row, now);
}

/** HK-1 (#973) — true while new tasks of this kind wait in the pool for their group instead of going to one person. */
export async function poolOnly(exec: Db | Tx, kind: string, now: Date): Promise<boolean> {
  const decl = taskKind(kind);
  return decl?.poolOnly === undefined ? false : decl.poolOnly(exec, now);
}

/**
 * The worker the next task of this skill goes to, or null (the task stays in the pool). With an eligibility (HK-1), only
 * those people, and among them the preferred group first.
 */
export async function pickWorker(
  exec: Db | Tx, skill: string, at: Date, exclude: readonly string[] = [], eligibility: TaskEligibility | null = null,
): Promise<OnDutyWorker | null> {
  let onDuty = (await onDutyForSkill(exec, skill, at)).filter((w) => !exclude.includes(w.userId));
  if (eligibility !== null) {
    const allowed = new Set(eligibility.userIds);
    onDuty = onDuty.filter((w) => allowed.has(w.userId));
    const preferred = new Set(eligibility.preferred ?? []);
    const first = onDuty.filter((w) => preferred.has(w.userId));
    if (first.length > 0) onDuty = first;
  }
  if (onDuty.length === 0) return null;
  const load = await openLoad(exec, onDuty.map((w) => w.userId));
  onDuty.sort((a, b) =>
    (load.get(a.userId)! - load.get(b.userId)!)
    || (a.shiftStartsAt.getTime() - b.shiftStartsAt.getTime())
    || a.userId.localeCompare(b.userId));
  return onDuty[0]!;
}
