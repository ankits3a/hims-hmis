import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import type { Actor, WireDeskScope, WirePersonWeek, WireUnitBoard, WireUnitSummary, WorkRating } from "@hmis/contracts";
import { doctorDeskRatings, orgDepartments, userDayFacts } from "../../kernel/db/schema";
import { doctorDayLines } from "../opd";
import { addIstDays, countingUnits, shortUnitName, teamMembers } from "../roster";
import { deskLevel, deskScope, namesOf } from "./scope";
import type { DeskScope } from "./scope";
import { mayHoldCritical, owedByUnit, restrictedReaders, withNudgedBy } from "./owed";
import { criticalCallsByIds } from "../lab";
import { mayMove } from "./moves";
import { actsBy, actsInTeam, medianMinutes } from "./acts";
import { onDutyUntil } from "./tower";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ DD-1.2 — THE UNIT BOARD (`UnitBoard.dc.html`): what the unit owes, and your people this week ═══
 *
 * Left column of the board, OPD + roster rows only (the unit report on the right is DD-report):
 *   · "What Unit II owes, and who owes it" — the Clocks reader at full length, OLDEST FIRST (C26),
 *     Nudge (DD-0.6) and Move (`moves.ts`). The BED column is absent until DD-IPD. Rows name no patient
 *     and no test (Clocks rule), so the restricted-test and confidential rules have nothing to hide here.
 *   · "Your people · this week" — counts of ACTS, never of screens (D6). Horizon (DECIDED spec 2): a JR or
 *     intern sees her own row; an SR sees hers and the unit's JRs and interns; the head (and a HOD/MS
 *     reading their own unit) sees the unit.
 *   · HOD / MS — the units of the department / hospital side by side, counts only.
 */
export const WEEK_DAYS = 7;
const RESIDENT_ROLES = new Set(["junior_resident", "intern"]);

export function horizonOf(scope: DeskScope, level: WireDeskScope, me: string): string[] {
  if (scope.unit === null) return [me];
  const mine = scope.members.find((m) => m.userId === me);
  if (level.level !== "member" && level.level !== "own") return scope.members.map((m) => m.userId);
  if (mine?.roleInTeam === "senior_resident") {
    return [me, ...scope.members.filter((m) => RESIDENT_ROLES.has(m.roleInTeam) && m.userId !== me).map((m) => m.userId)];
  }
  return [me];
}

/** OPD visits finished per person over the window: settled days from the rollup, today from the queue. */
async function visitsDone(db: Db, userIds: string[], istDate: string, at: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>(userIds.map((id) => [id, 0] as const));
  if (userIds.length === 0) return out;
  const from = addIstDays(istDate, -(WEEK_DAYS - 1));
  const rows = await db.select({ userId: userDayFacts.userId, facts: userDayFacts.facts }).from(userDayFacts)
    .where(and(inArray(userDayFacts.userId, userIds), gte(userDayFacts.day, from), lt(userDayFacts.day, istDate)));
  for (const r of rows) {
    const n = (r.facts as Record<string, number>)["opd.consultsCompleted"];
    if (typeof n === "number") out.set(r.userId, (out.get(r.userId) ?? 0) + n);
  }
  for (const l of await doctorDayLines(db, userIds, istDate, at).catch(() => [])) out.set(l.userId, (out.get(l.userId) ?? 0) + l.seen);
  return out;
}

async function lastWords(db: Db, raterId: string, ratedIds: string[]): Promise<Map<string, { rating: WorkRating; workDate: string }>> {
  if (ratedIds.length === 0) return new Map();
  const rows = await db.select({ rated: doctorDeskRatings.ratedUserId, rating: doctorDeskRatings.rating, workDate: doctorDeskRatings.workDate })
    .from(doctorDeskRatings)
    .where(and(eq(doctorDeskRatings.raterId, raterId), inArray(doctorDeskRatings.ratedUserId, ratedIds)))
    .orderBy(desc(doctorDeskRatings.createdAt));
  const out = new Map<string, { rating: WorkRating; workDate: string }>();
  for (const r of rows) if (!out.has(r.rated)) out.set(r.rated, { rating: r.rating as WorkRating, workDate: r.workDate });
  return out;
}

export async function unitSummaries(db: Db, level: WireDeskScope, istDate: string, at: Date): Promise<WireUnitSummary[]> {
  if (level.level !== "department" && level.level !== "hospital") return [];
  const units = (await countingUnits(db, at)).filter((u) => level.level === "hospital" || u.departmentId === level.departmentId);
  if (units.length === 0) return [];
  const depts = new Map((await db.select({ id: orgDepartments.id, name: orgDepartments.name }).from(orgDepartments)
    .where(inArray(orgDepartments.id, [...new Set(units.map((u) => u.departmentId))]))).map((d) => [d.id, d.name] as const));
  const weekAgo = new Date(at.getTime() - WEEK_DAYS * 86_400_000);
  const out: WireUnitSummary[] = [];
  for (const u of units) {
    const members = (await teamMembers(db, u.id, at)).map((m) => ({ userId: m.userId, name: "" }));
    const owed = await owedByUnit(db, members, at).catch(() => []);
    const lines = await doctorDayLines(db, members.map((m) => m.userId), istDate, at).catch(() => []);
    const deptName = depts.get(u.departmentId) ?? "";
    out.push({
      teamId: u.id, name: u.name, short: shortUnitName(u.name, deptName), departmentName: deptName,
      members: members.length, open: owed.length, past: owed.filter((r) => Date.parse(r.dueAt) < at.getTime()).length,
      seenToday: lines.reduce((n, l) => n + l.seen, 0),
      criticalToActMedian: medianMinutes(await actsInTeam(db, [u.id], weekAgo)),
    });
  }
  return out;
}

export async function unitBoard(db: Db, actor: Actor, at: Date): Promise<WireUnitBoard> {
  const scope = await deskScope(db, actor, at);
  const level = await deskLevel(db, actor, scope, at);
  const owedRaw = scope.unit === null ? [] : await owedByUnit(db, scope.members, at).catch(() => []);
  const owed = (await withNudgedBy(db, owedRaw, actor.id)).sort((a, b) => a.since.localeCompare(b.since));
  const mover = scope.unit !== null && await mayMove(db, scope, actor.id, at);
  // DD-1b — for a restricted critical, the members who may not take it (greyed on the Move picker).
  const cannotTake = new Map<string, string[]>();
  if (mover) {
    const calls = await criticalCallsByIds(db, owed.filter((r) => r.kind === "lab_critical").map((r) => r.key.slice("lab_critical:".length))).catch(() => []);
    const restricted = calls.filter((c) => c.restricted);
    const readers = restricted.length === 0 ? new Set<string>() : await restrictedReaders(db, scope.members.map((m) => m.userId));
    for (const c of restricted) {
      const rule = { restricted: true, orderer: c.orderingClinicianId };
      cannotTake.set(`lab_critical:${c.id}`, scope.members.map((m) => m.userId).filter((id) => !mayHoldCritical(rule, id, readers)).sort());
    }
  }

  const horizon = horizonOf(scope, level, actor.id);
  const names = await namesOf(db, horizon);
  const holds = new Map<string, number>();
  for (const r of owedRaw) holds.set(r.holder.userId, (holds.get(r.holder.userId) ?? 0) + 1);
  const done = await visitsDone(db, horizon, scope.istDate, at);
  const acts = await actsBy(db, horizon, new Date(at.getTime() - WEEK_DAYS * 86_400_000));
  const words = await lastWords(db, actor.id, horizon.filter((id) => id !== actor.id));
  const people: WirePersonWeek[] = await Promise.all(horizon.map(async (id): Promise<WirePersonWeek> => {
    const m = scope.members.find((x) => x.userId === id);
    const mine = acts.filter((a) => a.actorId === id);
    return {
      userId: id, name: m?.name ?? names.get(id) ?? "", role: m?.roleInTeam ?? "member", officiating: m?.officiating ?? false,
      onDutyUntil: await onDutyUntil(db, id, at), open: holds.get(id) ?? 0, visitsDone: done.get(id) ?? 0,
      criticalToActMedian: medianMinutes(mine), criticalActs: mine.length, lastWord: words.get(id) ?? null,
    };
  }));

  return {
    at: at.toISOString(), istDate: scope.istDate,
    you: { userId: actor.id, name: scope.name, grade: scope.grade },
    unit: scope.unit === null ? null : {
      teamId: scope.unit.teamId, name: scope.unit.unitName, short: scope.unit.short, departmentName: scope.unit.departmentName,
    },
    scope: level,
    owed: owed.map((r) => { const no = cannotTake.get(r.key); return { ...r, mayMove: mover, ...(no !== undefined ? { cannotTake: no } : {}) }; }),
    moveTo: mover ? scope.members.map((m) => ({ userId: m.userId, name: m.name, role: m.roleInTeam })) : [],
    people,
    units: await unitSummaries(db, level, scope.istDate, at),
  };
}
