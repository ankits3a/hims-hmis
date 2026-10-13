import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { istDayString } from "../../kernel/approvals/cumulative";
import { ipdConsults, opdDoctors, roleAssignments, rosterTeamMemberships } from "../../kernel/db/schema";
import { absentUserIds, doctorUnitsOn, teamMembers } from "../roster";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * E4.2 (#734) — WHO IS ON A PATIENT'S TREATING TEAM, AND WHO IS A CONSULTANT (spec §4.5A).
 *
 * CONSULTANT CADRE (DECIDED, review of 72f10b68): an active doctor-master row (`opd_doctors`) is NECESSARY but not
 * enough. The cadre comes from the roster — the person's live team memberships' `grade` at the instant: professor,
 * associate or assistant professor = consultant; senior / junior resident, intern, medical officer = not. A person with
 * NO live roster membership (guest faculty, a unit not yet confirmed) falls back to the role key: holding `resident`,
 * `intern` or `radiology_resident` = not a consultant, otherwise (`doctor`) = consultant. ONE function decides it for the
 * round (draft or signed), the co-sign, the fit and the charges seam's visit (`postConsultantVisit`), so they never
 * disagree.
 *
 * TREATING TEAM (DECIDED, Indian teaching-hospital practice): the admitting consultant, the consultant covering for
 * them (`ipd_admissions.covering_for`, set by the 08:00 cover hand-over), every member of the admitting consultant's
 * clinical unit on the day (roster parent membership — the unit's residents and interns too), and every consultant with
 * an OPEN consult request on the patient. Co-sign belongs to the unit's CONSULTANTS (admitting, covering, or a
 * consultant-cadre member of that unit).
 */
export const CONSULTANT_GRADES: readonly string[] = ["professor", "associate_professor", "assistant_professor"];
export const NON_CONSULTANT_ROLE_KEYS: readonly string[] = ["resident", "intern", "radiology_resident"];

export async function consultantIdsAmong(exec: Db | Tx, userIds: readonly string[], at: Date): Promise<Set<string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Set();
  const onMaster = new Set((await (exec as Db).select({ userId: opdDoctors.userId }).from(opdDoctors)
    .where(and(inArray(opdDoctors.userId, ids), eq(opdDoctors.active, true)))).map((r) => r.userId).filter((u): u is string => u !== null));
  if (onMaster.size === 0) return new Set();
  const live = await (exec as Db).select({ userId: rosterTeamMemberships.userId, grade: rosterTeamMemberships.grade }).from(rosterTeamMemberships)
    .where(and(
      inArray(rosterTeamMemberships.userId, [...onMaster]), lte(rosterTeamMemberships.startsAt, at),
      or(isNull(rosterTeamMemberships.endsAt), gt(rosterTeamMemberships.endsAt, at)),
    ));
  const roles = await (exec as Db).select({ userId: roleAssignments.userId }).from(roleAssignments)
    .where(and(inArray(roleAssignments.userId, [...onMaster]), inArray(roleAssignments.roleKey, [...NON_CONSULTANT_ROLE_KEYS])));
  const residentByRole = new Set(roles.map((r) => r.userId));
  const out = new Set<string>();
  for (const u of onMaster) {
    const grades = live.filter((m) => m.userId === u).map((m) => m.grade);
    if (grades.length > 0 ? grades.some((g) => CONSULTANT_GRADES.includes(g)) : !residentByRole.has(u)) out.add(u);
  }
  return out;
}

export async function isConsultant(exec: Db | Tx, userId: string, at: Date): Promise<boolean> {
  return (await consultantIdsAmong(exec, [userId], at)).has(userId);
}

/** Each person's parent clinical unit on the IST day (roster), as userId → teamId. */
export async function unitsOn(exec: Db | Tx, istDate: string): Promise<Map<string, string>> {
  return new Map((await doctorUnitsOn(exec, istDate)).map((u) => [u.userId, u.teamId] as const));
}

export type TreatingTeam = {
  consultantId: string;
  coveringId: string | null;
  /** The admitting consultant's unit members on the day (empty when the consultant is in no unit). */
  unitMemberIds: Set<string>;
  consultedIds: Set<string>;
};

export async function treatingTeamOf(exec: Db | Tx, a: AdmissionRow, at: Date, units?: Map<string, string>): Promise<TreatingTeam> {
  const byUser = units ?? await unitsOn(exec, istDayString(at));
  const unit = byUser.get(a.consultantId);
  const unitMemberIds = new Set(unit === undefined ? [] : [...byUser.entries()].filter(([, t]) => t === unit).map(([u]) => u));
  const consulted = await (exec as Db).select({ consultantId: ipdConsults.consultantId }).from(ipdConsults)
    .where(and(eq(ipdConsults.admissionId, a.id), eq(ipdConsults.status, "open")));
  return { consultantId: a.consultantId, coveringId: a.coveringFor, unitMemberIds, consultedIds: new Set(consulted.map((c) => c.consultantId)) };
}

export function onTeam(team: TreatingTeam, userId: string): boolean {
  return userId === team.consultantId || userId === team.coveringId || team.unitMemberIds.has(userId) || team.consultedIds.has(userId);
}

/** May co-sign a draft round on this patient: a consultant who is the admitting, covering, or a unit consultant. */
export function mayCosign(team: TreatingTeam, userId: string, userIsConsultant: boolean): boolean {
  if (!userIsConsultant) return false;
  return userId === team.consultantId || userId === team.coveringId || team.unitMemberIds.has(userId);
}

/**
 * The unit's head on the instant — an officiating head first (roster `teamMembers` prefers the officiating row) — other
 * than `exceptUserId` and not on approved leave at `at`. Null when the unit has none (or the consultant is in no unit).
 */
export async function unitHeadFor(exec: Db | Tx, consultantId: string, at: Date, units?: Map<string, string>): Promise<string | null> {
  const byUser = units ?? await unitsOn(exec, istDayString(at));
  const teamId = byUser.get(consultantId);
  if (teamId === undefined) return null;
  const away = new Set(await absentUserIds(exec, at, new Date(at.getTime() + 1)));
  const heads = (await teamMembers(exec, teamId, at)).filter((m) => m.roleInTeam === "head" && m.userId !== consultantId && !away.has(m.userId));
  heads.sort((x, y) => Number(y.officiating) - Number(x.officiating));
  return heads[0]?.userId ?? null;
}

/**
 * THE COVERING CONSULTANT (spec §4.5A edge "doctor on leave"; DECIDED, the roster seam): when the admitting consultant
 * is on APPROVED leave at `at`, the head of their unit covers (the officiating head when the head is the one away); the
 * roster has no per-doctor cover for inpatients, so the unit head is the standard answer. Null when they are not away
 * or nobody can cover.
 */
export async function coveringConsultantFor(exec: Db | Tx, consultantId: string, at: Date, units?: Map<string, string>): Promise<string | null> {
  const away = await absentUserIds(exec, at, new Date(at.getTime() + 1));
  if (!away.includes(consultantId)) return null;
  return unitHeadFor(exec, consultantId, at, units);
}
