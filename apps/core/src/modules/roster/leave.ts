import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { orgDepartments } from "../../kernel/db/schema/org";
import { roleAssignments, rolePermissions, users } from "../../kernel/db/schema/auth";
import { rosterTeamMemberships, rosterTeams, staffAbsences } from "../../kernel/db/schema/roster";
import { RosterError } from "./errors";
import { ROSTER_PUBLISH, requireRosterAct } from "./access";
import { approveAbsence, cancelAbsence, rejectAbsence, requestAbsence } from "./absences";
import { addIstDays, istDateOfInstant, istMidnightUtc } from "./calendar";
import type { RosterVia } from "./policy";
import type { StaffAbsenceKind } from "../../kernel/db/schema/roster";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * ═══ E2.2 — MY LEAVE, AND THE LIST IT WAITS IN (owner 2026-10-11) ═══
 * (spec /opt/hmis-context/SPEC-copilot-leave-swap-2026-10-11.md)
 *
 * Until now a member of staff could not ask for leave anywhere: `requestAbsence` existed and nothing
 * called it. This is the person's door to it — their own leave, by IST day — and the decider's list.
 *
 * WHO DECIDES: whoever holds `roster.periods.publish` for the department the person belonged to when
 * they filed (their unit's, else a department-scoped role's), or holds it hospital-wide. The person
 * never decides their own (`absences.ts`' segregation rule — the same function both doors call).
 *
 * WHAT A PERSON MAY FILE THEMSELVES (DECIDED, owner's delegation): CL, EL, ML and comp off. Maternity,
 * deputation, academic and the rest stay a manager's entry. No balance is checked: none is held.
 *
 * THE REASON is the person's own text, read by them and their decider only. It never comes from the
 * copilot (E2.2's chat card has no reason field) and never rides an event or a notice.
 */

export const SELF_LEAVE_KINDS = ["CL", "EL", "ML", "comp_off"] as const satisfies readonly StaffAbsenceKind[];
export type SelfLeaveKind = (typeof SELF_LEAVE_KINDS)[number];
/** The longest single request, in days — a longer one is a manager's entry, not a form. */
export const MAX_LEAVE_DAYS = 90;
/** How far ahead a request may start. */
export const LEAVE_AHEAD_DAYS = 180;
/** How long a decided or past request stays on the person's screen. */
const KEEP_DAYS = 60;
export const LEAVE_REASON_MAX = 500;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isSelfKind = (k: string): k is SelfLeaveKind => (SELF_LEAVE_KINDS as readonly string[]).includes(k);

export type LeaveStatus = "requested" | "approved" | "rejected" | "cancelled";

/** One request as its owner sees it. `from`/`to` are IST days, both inclusive. */
export type MyLeaveView = {
  id: string; kind: string; from: string; to: string; days: number; status: LeaveStatus;
  reason: string | null; refusal: string | null; decidedBy: string | null; decidedAt: string | null;
  canCancel: boolean;
};

/** One request as a decider sees it. */
export type LeaveToDecideView = {
  id: string; userId: string; name: string; department: string | null;
  kind: string; from: string; to: string; days: number; reason: string | null; requestedAt: string;
};

type Row = typeof staffAbsences.$inferSelect;

const daysOf = (from: string, to: string): number =>
  Math.round((istMidnightUtc(to).getTime() - istMidnightUtc(from).getTime()) / 86_400_000) + 1;
const toOf = (r: Row): string => istDateOfInstant(new Date(r.endsAt.getTime() - 1));

async function dbToday(exec: Db | Tx): Promise<{ now: Date; today: string }> {
  const r = await (exec as Db).execute(sql`select now() as "now"`);
  const raw = (r.rows[0] as { now: unknown }).now;
  const now = raw instanceof Date ? raw : new Date(String(raw));
  return { now, today: istDateOfInstant(now) };
}

/**
 * The department a person's leave waits in: their PARENT unit's at that instant, else the one
 * department a department-scoped role of theirs names. Two candidates or none → null (hospital-wide
 * deciders only), rather than a guess that sends it to the wrong head.
 */
export async function homeDepartmentOf(exec: Db | Tx, userId: string, at: Date): Promise<string | null> {
  const units = await (exec as Db).selectDistinct({ departmentId: rosterTeams.departmentId })
    .from(rosterTeamMemberships).innerJoin(rosterTeams, eq(rosterTeams.id, rosterTeamMemberships.teamId))
    .where(and(
      eq(rosterTeamMemberships.userId, userId), eq(rosterTeamMemberships.kind, "parent"),
      sql`${rosterTeamMemberships.startsAt} <= ${at}`,
      or(isNull(rosterTeamMemberships.endsAt), gt(rosterTeamMemberships.endsAt, at)),
    ));
  if (units.length === 1) return units[0]!.departmentId;
  if (units.length > 1) return null;
  const scoped = await (exec as Db).selectDistinct({ scopeId: roleAssignments.scopeId }).from(roleAssignments)
    .innerJoin(orgDepartments, eq(orgDepartments.id, roleAssignments.scopeId))
    .where(and(eq(roleAssignments.userId, userId), eq(roleAssignments.scopeType, "department")));
  return scoped.length === 1 ? scoped[0]!.scopeId : null;
}

export type FileLeaveInput = { kind: string; from: string; to: string; reason?: string | null };

/**
 * File MY OWN leave. `via` is "copilot" only when a copilot drafts; an E0.2-confirmed act is the
 * person's own tap and arrives `direct` (decision 0069) — and either way the matrix decides.
 */
export async function fileOwnLeave(
  tx: Tx, actor: Actor, input: FileLeaveInput, via: RosterVia = "direct",
): Promise<{ absenceId: string }> {
  if (actor.type !== "user") throw new RosterError("act_not_available_to_actor", undefined, { act: "request_absence", actorType: actor.type });
  const v = await checkLeave(tx, actor.id, input);
  const reason = input.reason == null || input.reason.trim() === "" ? null : input.reason.trim();
  if (reason !== null && reason.length > LEAVE_REASON_MAX) {
    throw new RosterError("invalid_window", `a reason is ${String(LEAVE_REASON_MAX)} characters or fewer`, { reasonLength: reason.length });
  }
  return requestAbsence(tx, actor, {
    userId: actor.id, kind: v.kind, startsAt: v.startsAt, endsAt: v.endsAt, reason, source: "manual",
    departmentId: await homeDepartmentOf(tx, actor.id, v.startsAt),
  }, via);
}

/**
 * Everything a request must satisfy before it is filed — shared by the screen's door and the
 * copilot's recheck, so a chat card and a form are refused for the same things in the same words.
 */
export async function checkLeave(
  exec: Db | Tx, userId: string, input: { kind: string; from: string; to: string },
): Promise<{ kind: SelfLeaveKind; startsAt: Date; endsAt: Date; days: number }> {
  if (!isSelfKind(input.kind)) throw new RosterError("unknown_absence_kind", "that kind of leave is entered by your department, not filed here", { kind: input.kind });
  if (!DATE.test(input.from) || !DATE.test(input.to)) throw new RosterError("invalid_window", "name the first and the last day of the leave");
  if (input.to < input.from) throw new RosterError("invalid_window", "the last day is before the first");
  const { today } = await dbToday(exec);
  if (input.from < today) throw new RosterError("leave_in_past", undefined, { from: input.from });
  if (input.from > addIstDays(today, LEAVE_AHEAD_DAYS)) throw new RosterError("invalid_window", `leave may be asked up to ${String(LEAVE_AHEAD_DAYS)} days ahead`);
  const days = daysOf(input.from, input.to);
  if (days > MAX_LEAVE_DAYS) throw new RosterError("invalid_window", `one request is at most ${String(MAX_LEAVE_DAYS)} days`);
  const startsAt = istMidnightUtc(input.from);
  const endsAt = istMidnightUtc(addIstDays(input.to, 1));
  const clash = (await (exec as Db).select({ id: staffAbsences.id }).from(staffAbsences).where(and(
    eq(staffAbsences.userId, userId), inArray(staffAbsences.status, ["requested", "approved"]),
    lt(staffAbsences.startsAt, endsAt), gt(staffAbsences.endsAt, startsAt),
  )).limit(1))[0];
  if (clash !== undefined) throw new RosterError("leave_overlaps", undefined, { absenceId: clash.id });
  return { kind: input.kind, startsAt, endsAt, days };
}

/** Take back MY OWN request — any not yet begun, decided or not. */
export async function cancelOwnLeave(tx: Tx, actor: Actor, absenceId: string): Promise<void> {
  const row = (await (tx as Db).select().from(staffAbsences).where(eq(staffAbsences.id, absenceId)))[0];
  if (row === undefined || actor.type !== "user" || row.userId !== actor.id) throw new RosterError("unknown_absence", undefined, { absenceId });
  const { now } = await dbToday(tx);
  if (row.startsAt <= now) throw new RosterError("leave_in_past", "a leave already begun is changed by your department", { absenceId });
  await cancelAbsence(tx, actor, absenceId);
}

/** My requests: every one not yet over, and the last {@link KEEP_DAYS} days' others. */
export async function myLeave(exec: Db | Tx, actor: Actor): Promise<MyLeaveView[]> {
  if (actor.type !== "user") return [];
  const { now } = await dbToday(exec);
  const since = new Date(now.getTime() - KEEP_DAYS * 86_400_000);
  const rows = await (exec as Db).select().from(staffAbsences)
    .where(and(eq(staffAbsences.userId, actor.id), gt(staffAbsences.endsAt, since)))
    .orderBy(desc(staffAbsences.startsAt));
  const deciders = await namesOf(exec, rows.flatMap((r) => (r.approvedBy === null ? [] : [r.approvedBy])));
  return rows.map((r) => {
    const from = istDateOfInstant(r.startsAt);
    const to = toOf(r);
    return {
      id: r.id, kind: r.kind, from, to, days: daysOf(from, to), status: r.status as LeaveStatus,
      reason: r.reason, refusal: r.status === "rejected" ? r.decisionNote : null,
      decidedBy: r.approvedBy === null ? null : deciders.get(r.approvedBy) ?? null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      canCancel: (r.status === "requested" || r.status === "approved") && r.startsAt > now,
    };
  });
}

async function namesOf(exec: Db | Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await (exec as Db).select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, [...new Set(ids)]));
  return new Map(rows.map((u) => [u.id, u.fullName]));
}

async function mayDecide(exec: Db | Tx, actor: Actor, departmentId: string | null): Promise<boolean> {
  try {
    await requireRosterAct(exec, actor, "publish", departmentId === null ? {} : { departmentId });
    return true;
  } catch (e) {
    if (e instanceof RosterError) return false;
    throw e;
  }
}

/**
 * The requests waiting for THIS reader's yes or no: every `requested` leave whose department they
 * publish for (or any, hospital-wide), never their own. The reason is shown — they are its decider.
 */
export async function leaveToDecide(exec: Db | Tx, actor: Actor): Promise<LeaveToDecideView[]> {
  if (actor.type !== "user") return [];
  const rows = await (exec as Db).select().from(staffAbsences)
    .where(eq(staffAbsences.status, "requested")).orderBy(staffAbsences.startsAt);
  const mine: Row[] = [];
  const verdict = new Map<string, boolean>();
  for (const r of rows) {
    if (r.userId === actor.id || r.requestedBy === actor.id) continue;
    const key = r.departmentId ?? "";
    if (!verdict.has(key)) verdict.set(key, await mayDecide(exec, actor, r.departmentId));
    if (verdict.get(key) === true) mine.push(r);
  }
  const names = await namesOf(exec, mine.map((r) => r.userId));
  const deptIds = [...new Set(mine.flatMap((r) => (r.departmentId === null ? [] : [r.departmentId])))];
  const depts = new Map(deptIds.length === 0 ? [] : (await (exec as Db).select({ id: orgDepartments.id, name: orgDepartments.name })
    .from(orgDepartments).where(inArray(orgDepartments.id, deptIds))).map((d) => [d.id, d.name]));
  return mine.map((r) => {
    const from = istDateOfInstant(r.startsAt);
    const to = toOf(r);
    return {
      id: r.id, userId: r.userId, name: names.get(r.userId) ?? r.userId,
      department: r.departmentId === null ? null : depts.get(r.departmentId) ?? null,
      kind: r.kind, from, to, days: daysOf(from, to), reason: r.reason, requestedAt: r.createdAt.toISOString(),
    };
  });
}

/** Approve, or refuse WITH a reason (the screen requires one; the reason goes back to the person). */
export async function decideLeave(tx: Tx, actor: Actor, absenceId: string, input: { approve: boolean; note?: string | null }): Promise<void> {
  if (input.approve) return approveAbsence(tx, actor, absenceId);
  if (input.note == null || input.note.trim() === "") throw new RosterError("invalid_window", "say why the leave is refused — the person reads it");
  return rejectAbsence(tx, actor, absenceId, input.note);
}

/** Who is told a leave is waiting: the department's publishers and the hospital-wide ones. */
export async function leaveDeciders(exec: Db | Tx, departmentId: string | null, exceptUserId: string): Promise<string[]> {
  const rows = await (exec as Db).selectDistinct({ userId: roleAssignments.userId }).from(roleAssignments)
    .innerJoin(rolePermissions, eq(rolePermissions.roleKey, roleAssignments.roleKey))
    .innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(and(
      eq(rolePermissions.permission, ROSTER_PUBLISH), eq(users.active, true),
      departmentId === null
        ? eq(roleAssignments.scopeType, "hospital")
        : or(eq(roleAssignments.scopeType, "hospital"), and(eq(roleAssignments.scopeType, "department"), eq(roleAssignments.scopeId, departmentId))),
    ));
  return rows.map((r) => r.userId).filter((id) => id !== exceptUserId).sort();
}

const KIND_LABEL: Record<string, string> = { CL: "Casual leave", EL: "Earned leave", ML: "Medical leave", comp_off: "Comp off" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type LeaveForAlert = {
  userId: string; name: string; departmentId: string | null; days: number; kindLabel: string; fromLabel: string;
  /** The person filed it themselves (My leave or the copilot) — the only kind anybody is told about. */
  ownFiling: boolean;
};

/** One leave, worded for a bell row: a name, a kind, a number of days, a first day. Never the reason. */
export async function leaveForAlert(exec: Db | Tx, absenceId: string): Promise<LeaveForAlert | null> {
  const r = (await (exec as Db).select().from(staffAbsences).where(eq(staffAbsences.id, absenceId)))[0];
  if (r === undefined) return null;
  const from = istDateOfInstant(r.startsAt);
  return {
    userId: r.userId, name: (await namesOf(exec, [r.userId])).get(r.userId) ?? r.userId, departmentId: r.departmentId,
    days: daysOf(from, toOf(r)), kindLabel: KIND_LABEL[r.kind] ?? "Leave",
    fromLabel: `${from.slice(8, 10)} ${MONTHS[Number(from.slice(5, 7)) - 1]!}`,
    ownFiling: r.source === "manual" && r.requestedBy === r.userId,
  };
}
