import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";
import type { StaffToday } from "@hmis/contracts";
import { orgDepartments, rosterAssignments, rosterCoverRequests, staffAbsences, users } from "../../kernel/db/schema";
import { requireRosterAct } from "./access";
import { BOARD_HORIZON_MS, onNowBoard } from "./board";
import { istDateOfInstant } from "./calendar";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ THE OWNER'S STAFF PAGE ═══ (owner, 2026-10-09: "Staff: who is absent, pending leave or cover
 * requests." · "Staff page without attendance, as described: acceptable for now.")
 *
 * THERE IS NO ATTENDANCE HERE, AND NONE IS INVENTED. This read cannot know who did not come. It says
 * what the roster's own records say:
 *   · onDuty   — how many different people the "who is on now" board names at this instant;
 *   · onLeave  — people with an APPROVED absence overlapping the IST day. Name only: D6 — that a
 *                person is away is the roster's business, the kind and the reason are not;
 *   · gaps     — the board's own holes in the next 24 hours (a hole is not a verdict on a person);
 *   · waiting  — cover and swap requests still open, and leave requests nobody has decided.
 * Read-only, composed from the board (`onNowBoard`) so the page and the board cannot disagree.
 */
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;
const LINES = 12;

export async function staffToday(exec: Db | Tx, actor: Actor, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<StaffToday> {
  await requireRosterAct(exec, actor, "read");
  const db = exec as Db;
  const day = istDateOfInstant(now);
  const dayStart = new Date(Date.parse(`${day}T00:00:00.000Z`) - IST_OFFSET_MS);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);

  const board = await onNowBoard(exec, now, env);
  const on = new Set<string>();
  for (const d of board.departments) {
    for (const p of d.inTheBuilding) on.add(p.userId);
    for (const r of d.facultyOnCall) if (r.userId !== null) on.add(r.userId);
    for (const s of d.inOpd ?? []) if (s.now) on.add(s.userId);
  }
  for (const d of board.departmentsWithoutUnit) for (const s of d.inOpd) if (s.now) on.add(s.userId);
  for (const s of board.services) for (const p of s.people) on.add(p.userId);

  const away = await db.select({ userId: staffAbsences.userId }).from(staffAbsences)
    .where(and(eq(staffAbsences.status, "approved"), lt(staffAbsences.startsAt, dayEnd), gt(staffAbsences.endsAt, dayStart)));
  const awayIds = [...new Set(away.map((a) => a.userId))];
  const names = awayIds.length === 0 ? new Map<string, string>()
    : new Map((await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, awayIds))).map((u) => [u.id, u.fullName]));

  const horizon = now.getTime() + BOARD_HORIZON_MS;
  const gaps = board.holes.filter((h) => h.to.getTime() > now.getTime() && h.from.getTime() < horizon)
    .sort((a, b) => a.from.getTime() - b.from.getTime())
    .map((h) => ({ department: h.departmentName, from: h.from.toISOString(), what: h.positionLabel }));

  const covers = await db.select({
    id: rosterCoverRequests.id, departmentId: rosterCoverRequests.departmentId, startsAt: rosterAssignments.startsAt,
  }).from(rosterCoverRequests).innerJoin(rosterAssignments, eq(rosterAssignments.id, rosterCoverRequests.assignmentId))
    .where(inArray(rosterCoverRequests.status, ["asked", "accepted"])).orderBy(asc(rosterAssignments.startsAt));
  const deptIds = [...new Set(covers.map((c) => c.departmentId))];
  const depts = deptIds.length === 0 ? new Map<string, string>()
    : new Map((await db.select({ id: orgDepartments.id, name: orgDepartments.name }).from(orgDepartments).where(inArray(orgDepartments.id, deptIds))).map((d) => [d.id, d.name]));
  const leaveAsked = await db.select({ id: staffAbsences.id }).from(staffAbsences)
    .where(and(eq(staffAbsences.status, "requested"), gt(staffAbsences.endsAt, now)));

  return {
    day,
    onDuty: on.size,
    onLeave: awayIds.map((id) => ({ userId: id, name: names.get(id) ?? id })).sort((a, b) => a.name.localeCompare(b.name)),
    gaps,
    waiting: {
      cover: covers.length,
      coverLines: covers.slice(0, LINES).map((c) => ({ department: depts.get(c.departmentId) ?? c.departmentId, day: istDateOfInstant(c.startsAt) })),
      leave: leaveAsked.length,
    },
  };
}
