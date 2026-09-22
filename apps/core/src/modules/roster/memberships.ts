import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  ROSTER_GRADES, ROSTER_MEMBERSHIP_KINDS, ROSTER_TEAM_ROLES,
  rosterPositions, rosterTeamMemberships, rosterTeams,
} from "../../kernel/db/schema/roster";
import { users } from "../../kernel/db/schema/auth";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type {
  RosterGrade, RosterMembershipKind, RosterTeamRole,
} from "../../kernel/db/schema/roster";

/**
 * PHASE R (R3) — putting people into teams, and taking them out again.
 *
 * ═══ THE TWO EXCLUDES ARE SURFACED AS SENTENCES, AND THE SENTENCES ARE THE POINT ═══
 *
 * A person belongs to ONE unit at a time, and a team has ONE substantive head at a time. Both are
 * exclusion constraints — they must be unrepresentable, because a roster built on top of a person
 * who belongs to two units cannot be reasoned about at all. But the person hitting them is a clerk
 * typing a transfer, and *"conflicting key value violates exclusion constraint
 * roster_team_memberships_one_parent_excl"* tells them nothing they can act on. So each is caught
 * and re-said: **close the place they hold now, or post them on rotation instead.**
 *
 * ═══ ROTATION, AND THE NIGHTS THAT DO NOT MOVE WITH IT ═══
 *
 * A JR posted to ICU for three months is still Medicine's for the night pool, because the pool is
 * the DEPARTMENT's and the rotation is inside it. `retains_parent_nights` carries that, and the
 * constraint refuses it on a `parent` or a `float` — a float is one night by definition and a
 * parent's nights were never in question.
 */

export type RosterMembershipRow = typeof rosterTeamMemberships.$inferSelect;

export interface AddMembershipInput {
  teamId: string;
  userId: string;
  positionKey: string;
  grade: RosterGrade;
  roleInTeam: RosterTeamRole;
  kind?: RosterMembershipKind;
  retainsParentNights?: boolean;
  supernumeraryUntil?: Date | null;
  patternOffset?: number | null;
  startsAt: Date;
  endsAt?: Date | null;
  source?: "manual" | "import" | "academic";
}

export async function addMembership(
  tx: Tx, actor: Actor, input: AddMembershipInput,
): Promise<{ membershipId: string }> {
  const team = (await (tx as Db).select().from(rosterTeams).where(eq(rosterTeams.id, input.teamId)))[0];
  if (team === undefined) throw new RosterError("unknown_team", undefined, { teamId: input.teamId });
  await requireRosterAct(tx, actor, "publish", { departmentId: team.departmentId });

  const kind = input.kind ?? "parent";
  if (!(ROSTER_MEMBERSHIP_KINDS as readonly string[]).includes(kind)
    || !(ROSTER_TEAM_ROLES as readonly string[]).includes(input.roleInTeam)
    || !(ROSTER_GRADES as readonly string[]).includes(input.grade)) {
    throw new RosterError("invalid_window", "kind, role or grade is not one the roster knows", {
      kind, roleInTeam: input.roleInTeam, grade: input.grade,
    });
  }
  if (input.endsAt != null && input.endsAt <= input.startsAt) {
    throw new RosterError("invalid_window", "a place in a team cannot end before it begins", {
      startsAt: input.startsAt.toISOString(), endsAt: input.endsAt.toISOString(),
    });
  }
  if ((input.retainsParentNights ?? false) && kind !== "rotation") {
    throw new RosterError(
      "invalid_window",
      "only a ROTATION keeps its parent unit's nights — a float is one night, and a parent's nights were never in question",
      { kind },
    );
  }

  const person = (await (tx as Db).select({ id: users.id, active: users.active }).from(users).where(eq(users.id, input.userId)))[0];
  if (person === undefined || !person.active) throw new RosterError("unknown_user", undefined, { userId: input.userId });
  const position = (await (tx as Db).select({ key: rosterPositions.key }).from(rosterPositions).where(eq(rosterPositions.key, input.positionKey)))[0];
  if (position === undefined) throw new RosterError("unknown_position", undefined, { positionKey: input.positionKey });

  const membershipId = newId();
  try {
    await tx.insert(rosterTeamMemberships).values({
      id: membershipId, teamId: input.teamId, userId: input.userId, positionKey: input.positionKey,
      grade: input.grade, roleInTeam: input.roleInTeam, kind,
      retainsParentNights: input.retainsParentNights ?? false,
      supernumeraryUntil: input.supernumeraryUntil ?? null,
      patternOffset: input.patternOffset ?? null,
      startsAt: input.startsAt, endsAt: input.endsAt ?? null,
      source: input.source ?? "manual", createdBy: actor.id, updatedBy: actor.id,
    });
  } catch (e) {
    if (isExclusion(e, "roster_team_memberships_one_parent_excl")) {
      throw new RosterError("parent_membership_overlap", undefined, { userId: input.userId, teamId: input.teamId });
    }
    if (isExclusion(e, "roster_team_memberships_one_head_excl")) {
      throw new RosterError("head_already_held", undefined, { teamId: input.teamId });
    }
    throw e;
  }
  return { membershipId };
}

/** Closing a place is dating it, never deleting it: last year's roster names the person who held it. */
export async function endMembership(tx: Tx, actor: Actor, membershipId: string, endsAt: Date): Promise<void> {
  const row = (await tx.select().from(rosterTeamMemberships).where(eq(rosterTeamMemberships.id, membershipId)).for("update"))[0];
  if (row === undefined) throw new RosterError("unknown_membership", undefined, { membershipId });
  const team = (await (tx as Db).select().from(rosterTeams).where(eq(rosterTeams.id, row.teamId)))[0]!;
  await requireRosterAct(tx, actor, "publish", { departmentId: team.departmentId });
  if (endsAt <= row.startsAt) {
    throw new RosterError("invalid_window", "a place in a team cannot end before it begins", { membershipId });
  }
  await tx.update(rosterTeamMemberships).set({ endsAt, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(rosterTeamMemberships.id, membershipId));
}

/* ═══════════════════════════════ reads ═══════════════════════════════ */

const liveAt = (at: Date) => and(
  sql`${rosterTeamMemberships.startsAt} <= ${at}`,
  or(isNull(rosterTeamMemberships.endsAt), sql`${rosterTeamMemberships.endsAt} > ${at}`),
);

/** Every team this person holds a place in at `at`, parent first. */
export async function membershipsOf(exec: Db | Tx, userId: string, at: Date): Promise<RosterMembershipRow[]> {
  const rows = await (exec as Db).select().from(rosterTeamMemberships)
    .where(and(eq(rosterTeamMemberships.userId, userId), liveAt(at)))
    .orderBy(asc(rosterTeamMemberships.startsAt));
  const rank = { parent: 0, rotation: 1, float: 2 } as Record<string, number>;
  return [...rows].sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
}

/** Where this person BELONGS at `at` — the one parent membership, or none. */
export async function parentTeamOf(exec: Db | Tx, userId: string, at: Date): Promise<RosterMembershipRow | undefined> {
  return (await membershipsOf(exec, userId, at)).find((m) => m.kind === "parent");
}

/* ═══════════════════════════════ the CSV import ═══════════════════════════════ */

export interface MembershipImportRow {
  teamCode: string;
  staffCode: string;
  positionKey: string;
  grade: string;
  roleInTeam: string;
  kind?: string;
  startsAt: string;
  endsAt?: string;
}

export interface ImportProblem { row: number; message: string }

/**
 * ═══ VALIDATED WHOLE, BEFORE THE FIRST WRITE (`seed:staff`'s posture) ═══
 *
 * A staff import is typed by a person from a spreadsheet, and the failure that matters is not a bad
 * row — it is **half the file landing.** A clerk who imports 180 memberships, sees row 94 rejected,
 * fixes it and re-runs has no way to know which of the first 93 are now duplicated. So every row is
 * resolved and checked first, and the whole file is refused with every problem listed, or none of
 * it is.
 */
export async function importMemberships(
  tx: Tx, actor: Actor, rows: readonly MembershipImportRow[],
): Promise<{ imported: number } | { problems: ImportProblem[] }> {
  const problems: ImportProblem[] = [];
  const resolved: AddMembershipInput[] = [];

  for (const [i, row] of rows.entries()) {
    const n = i + 1;
    const team = (await (tx as Db).select().from(rosterTeams).where(eq(rosterTeams.code, row.teamCode.trim().toUpperCase())).limit(1))[0];
    const person = (await (tx as Db).select({ id: users.id, active: users.active }).from(users)
      .where(eq(users.staffCode, row.staffCode.trim())).limit(1))[0];
    const position = (await (tx as Db).select({ key: rosterPositions.key }).from(rosterPositions)
      .where(eq(rosterPositions.key, row.positionKey.trim())).limit(1))[0];

    if (team === undefined) problems.push({ row: n, message: `no team with code "${row.teamCode}"` });
    if (person === undefined) problems.push({ row: n, message: `no member of staff with staff code "${row.staffCode}"` });
    else if (!person.active) problems.push({ row: n, message: `"${row.staffCode}" no longer works here` });
    if (position === undefined) problems.push({ row: n, message: `no duty position "${row.positionKey}"` });
    if (!(ROSTER_GRADES as readonly string[]).includes(row.grade)) problems.push({ row: n, message: `"${row.grade}" is not a grade` });
    if (!(ROSTER_TEAM_ROLES as readonly string[]).includes(row.roleInTeam)) problems.push({ row: n, message: `"${row.roleInTeam}" is not a role in a team` });

    const startsAt = new Date(row.startsAt);
    if (Number.isNaN(startsAt.getTime())) problems.push({ row: n, message: `"${row.startsAt}" is not a date` });
    const endsAt = row.endsAt === undefined || row.endsAt.trim() === "" ? null : new Date(row.endsAt);
    if (endsAt !== null && Number.isNaN(endsAt.getTime())) problems.push({ row: n, message: `"${row.endsAt}" is not a date` });

    if (team !== undefined && person !== undefined && position !== undefined && !Number.isNaN(startsAt.getTime())) {
      resolved.push({
        teamId: team.id, userId: person.id, positionKey: position.key,
        grade: row.grade as RosterGrade, roleInTeam: row.roleInTeam as RosterTeamRole,
        kind: (row.kind ?? "parent") as RosterMembershipKind,
        startsAt, endsAt, source: "import",
      });
    }
  }

  if (problems.length > 0) return { problems };
  for (const input of resolved) await addMembership(tx, actor, input);
  return { imported: resolved.length };
}

function isExclusion(e: unknown, constraint: string): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur != null && typeof cur === "object"; i += 1) {
    const c = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof c.code === "string" && c.code.length === 5) {
      return c.code === "23P01" && c.constraint === constraint;
    }
    cur = c.cause;
  }
  return false;
}
