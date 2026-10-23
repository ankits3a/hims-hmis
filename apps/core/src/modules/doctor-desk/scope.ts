import { and, eq, gt, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { orgDepartments, roleAssignments, rolePermissions, rosterOfficiating, rosterTeams, users } from "../../kernel/db/schema";
import { ROSTER_PUBLISH, doctorUnitsOn, istDateOfInstant, membershipsOf, teamMembers } from "../roster";
import type { DoctorUnit, TeamMember } from "../roster";
import type { Actor, DeskLevel, WireDeskScope } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * DD-0.3 (plan D-C) — WHOSE DESK THIS IS, AND WHICH UNIT IT LOOKS AT, decided at READ time.
 *
 * The unit is the roster's answer for the IST day (`doctorUnitsOn`: the parent clinical-unit
 * membership that counts, judged at noon IST), never a column stamped on a visit — so a doctor who
 * moved units mid-month is read against the old unit for the old days and the new one for today, and
 * a doctor in no unit (visiting faculty) gets `unit: null` and their own rows only (plan E17, E18).
 */
export type DeskScope = {
  userId: string;
  name: string;
  grade: string | null;
  istDate: string;
  unit: DoctorUnit | null;
  /** The unit's members at `at`, officiating preferred (`teamMembers`), with names. Empty without a unit. */
  members: (TeamMember & { name: string })[];
};

export async function namesOf(exec: Db | Tx, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await (exec as Db).select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name] as const));
}

/** The unit a user belongs to on `istDate`, or null. */
export async function unitOfOn(exec: Db | Tx, userId: string, istDate: string): Promise<DoctorUnit | null> {
  return (await doctorUnitsOn(exec, istDate)).find((u) => u.userId === userId) ?? null;
}

export async function deskScope(exec: Db | Tx, actor: Actor, at: Date): Promise<DeskScope> {
  const istDate = istDateOfInstant(at);
  const userId = actor.id;
  const unit = actor.type === "user" ? await unitOfOn(exec, userId, istDate) : null;
  const grade = actor.type === "user" ? (await membershipsOf(exec, userId, at)).find((m) => m.kind === "parent")?.grade ?? null : null;
  const team = unit === null ? [] : await teamMembers(exec, unit.teamId, at);
  const names = await namesOf(exec, [userId, ...team.map((m) => m.userId)]);
  return {
    userId, name: names.get(userId) ?? "", grade, istDate, unit,
    members: team.map((m) => ({ ...m, name: names.get(m.userId) ?? "" })),
  };
}

/** A patient as a Desk line shows them: a confidential patient by their alias, never their name. */
export function patientOf(
  s: { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean } | undefined, fallbackId: string,
): { id: string; uhid: string | null; name: string | null; restricted: boolean } {
  if (s === undefined) return { id: fallbackId, uhid: null, name: null, restricted: false };
  return { id: s.id, uhid: s.uhid, name: s.restricted ? s.alias : s.name, restricted: s.restricted };
}

/**
 * ═══ DD-1.1 (plan D11) — THE SCOPE A DESK READS AT, derived, never chosen ═══
 *
 *   hospital   — holds the `medical_superintendent` role (any scope).
 *   department — HOD: an officiating `hod` row in force NOW on one of the department's teams, or a
 *                department-scoped grant of `roster.periods.publish` (the rule `leaveDeciders` uses for
 *                "the department head"). DECIDED: there is no substantive HOD column anywhere, and
 *                these are the two records the hospital already keeps about who heads a department.
 *   unit       — the head of the unit: `teamMembers` already returns an officiating head AS head only
 *                inside the officiating window (plan E07), so an Asst Prof standing in gets the scope
 *                for those days and loses it the minute the window ends.
 *   member     — anyone else in a unit: her items, and her unit's clocks.
 *   own        — in no unit (visiting faculty): own rows only.
 * The highest that applies wins.
 */
export const MS_ROLE_KEY = "medical_superintendent";

export async function deskLevel(exec: Db | Tx, actor: Actor, scope: DeskScope, at: Date): Promise<WireDeskScope> {
  const none: WireDeskScope = { level: "own", officiating: false, departmentId: null, departmentName: null };
  if (actor.type !== "user") return none;
  const db = exec as Db;
  const ms = await db.select({ id: roleAssignments.id }).from(roleAssignments)
    .where(and(eq(roleAssignments.userId, actor.id), eq(roleAssignments.roleKey, MS_ROLE_KEY))).limit(1);
  if (ms.length > 0) return { level: "hospital", officiating: false, departmentId: null, departmentName: null };

  const hodStandIn = await db.select({ departmentId: rosterTeams.departmentId }).from(rosterOfficiating)
    .innerJoin(rosterTeams, eq(rosterTeams.id, rosterOfficiating.teamId))
    .where(and(
      eq(rosterOfficiating.userId, actor.id), eq(rosterOfficiating.role, "hod"),
      // Nobody appoints themselves: a row its own holder approved gives no scope.
      ne(rosterOfficiating.approvedBy, rosterOfficiating.userId),
      lte(rosterOfficiating.startsAt, at), or(isNull(rosterOfficiating.endsAt), gt(rosterOfficiating.endsAt, at)),
    )).limit(1);
  const publish = hodStandIn.length > 0 ? [] : await db.select({ departmentId: roleAssignments.scopeId }).from(roleAssignments)
    .innerJoin(rolePermissions, eq(rolePermissions.roleKey, roleAssignments.roleKey))
    .where(and(eq(roleAssignments.userId, actor.id), eq(roleAssignments.scopeType, "department"), eq(rolePermissions.permission, ROSTER_PUBLISH)))
    .limit(1);
  const dept = hodStandIn[0]?.departmentId ?? publish[0]?.departmentId ?? null;
  if (dept !== null) {
    const name = (await db.select({ name: orgDepartments.name }).from(orgDepartments).where(eq(orgDepartments.id, dept)))[0]?.name ?? null;
    return { level: "department", officiating: hodStandIn.length > 0, departmentId: dept, departmentName: name };
  }
  if (scope.unit === null) return none;
  const me = scope.members.find((m) => m.userId === actor.id);
  const base = { departmentId: scope.unit.departmentId, departmentName: scope.unit.departmentName };
  if (me?.roleInTeam === "head") {
    // An officiating head counts only on a row somebody else approved: nobody appoints themselves.
    if (!me.officiating || await approvedStandIn(db, actor.id, scope.unit.teamId, at)) return { level: "unit", officiating: me.officiating, ...base };
  }
  return { level: "member", officiating: false, ...base };
}

/** Is there an officiating row in force for this person on this team that somebody ELSE approved? */
export async function approvedStandIn(exec: Db | Tx, userId: string, teamId: string, at: Date): Promise<boolean> {
  const db = exec as Db;
  const rows = await db.select({ id: rosterOfficiating.id }).from(rosterOfficiating).where(and(
    eq(rosterOfficiating.userId, userId), eq(rosterOfficiating.teamId, teamId), ne(rosterOfficiating.approvedBy, rosterOfficiating.userId),
    lte(rosterOfficiating.startsAt, at), or(isNull(rosterOfficiating.endsAt), gt(rosterOfficiating.endsAt, at)),
  )).limit(1);
  return rows.length > 0;
}

/**
 * The unit's heads at `at` who may ACT as head: a substantive head, or an officiating head on a row somebody
 * else approved. Nobody appoints themselves (#904 refuses new self-approved rows; older ones may still exist).
 */
export async function headsInForce(
  exec: Db | Tx, members: readonly Pick<TeamMember, "userId" | "roleInTeam" | "officiating">[], teamId: string, at: Date,
): Promise<string[]> {
  const out: string[] = [];
  for (const m of members) {
    if (m.roleInTeam !== "head") continue;
    if (!m.officiating || await approvedStandIn(exec, m.userId, teamId, at)) out.push(m.userId);
  }
  return [...new Set(out)];
}

/** At least `level` (`own` < `member` < `unit` < `department` < `hospital`). */
export function atLeast(have: DeskLevel, want: DeskLevel): boolean {
  const order: DeskLevel[] = ["own", "member", "unit", "department", "hospital"];
  return order.indexOf(have) >= order.indexOf(want);
}

/**
 * DD-report — WHO HEADS A DEPARTMENT at `at`, by the same two records `deskLevel` reads: an officiating
 * `hod` row in force on one of its teams, or a department-scoped grant of `roster.periods.publish`.
 */
export async function departmentHeads(exec: Db | Tx, departmentId: string, at: Date): Promise<string[]> {
  const db = exec as Db;
  const standIn = await db.select({ userId: rosterOfficiating.userId }).from(rosterOfficiating)
    .innerJoin(rosterTeams, eq(rosterTeams.id, rosterOfficiating.teamId))
    .where(and(
      eq(rosterTeams.departmentId, departmentId), eq(rosterOfficiating.role, "hod"),
      ne(rosterOfficiating.approvedBy, rosterOfficiating.userId),
      lte(rosterOfficiating.startsAt, at), or(isNull(rosterOfficiating.endsAt), gt(rosterOfficiating.endsAt, at)),
    ));
  const grants = await db.selectDistinct({ userId: roleAssignments.userId }).from(roleAssignments)
    .innerJoin(rolePermissions, eq(rolePermissions.roleKey, roleAssignments.roleKey))
    .where(and(eq(roleAssignments.scopeType, "department"), eq(roleAssignments.scopeId, departmentId), eq(rolePermissions.permission, ROSTER_PUBLISH)));
  return [...new Set([...standIn, ...grants].map((r) => r.userId))].sort();
}

/** DD-report — the Medical Superintendents (holders of the `medical_superintendent` role). */
export async function superintendents(exec: Db | Tx): Promise<string[]> {
  const rows = await (exec as Db).selectDistinct({ userId: roleAssignments.userId }).from(roleAssignments)
    .where(eq(roleAssignments.roleKey, MS_ROLE_KEY));
  return rows.map((r) => r.userId).sort();
}
