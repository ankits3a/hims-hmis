import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { ROSTER_OFFICIATING_ROLES, rosterOfficiating, rosterTeams } from "../../kernel/db/schema/roster";
import { users } from "../../kernel/db/schema/auth";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { RosterOfficiatingRole } from "../../kernel/db/schema/roster";

/**
 * PHASE R (R3) — **WHO IS STANDING IN, AND WHY IT IS NOT A MEMBERSHIP EDIT.**
 *
 * The head of Medicine goes on three weeks' leave and an associate professor officiates. The cheap
 * implementation ends the head's membership and starts the associate's. It is wrong in a way that
 * shows up months later: the head has not stopped being the head, their substantive place is a fact
 * about the establishment and the NMC return, and re-creating it afterwards mints a new row with a
 * new start date that no longer matches anybody's service record.
 *
 * So officiating is its own dated row, the substantive membership is untouched, and `teamMembers`
 * prefers the officiating holder while it is in force. One person per (team, role) at a time —
 * an exclusion constraint, because two people each believing they are acting head is the failure
 * this is for.
 */

export type RosterOfficiatingRow = typeof rosterOfficiating.$inferSelect;

export interface OfficiatingInput {
  teamId: string;
  userId: string;
  role: RosterOfficiatingRole;
  startsAt: Date;
  endsAt?: Date | null;
  reason: string;
}

export async function recordOfficiating(tx: Tx, actor: Actor, input: OfficiatingInput): Promise<{ officiatingId: string }> {
  const team = (await (tx as Db).select().from(rosterTeams).where(eq(rosterTeams.id, input.teamId)))[0];
  if (team === undefined) throw new RosterError("unknown_team", undefined, { teamId: input.teamId });
  await requireRosterAct(tx, actor, "publish", { departmentId: team.departmentId });

  if (!(ROSTER_OFFICIATING_ROLES as readonly string[]).includes(input.role)) {
    throw new RosterError("invalid_window", `"${input.role}" is not a role anybody officiates in`, { role: input.role });
  }
  const reason = input.reason.trim();
  if (reason === "" || reason.length > 500) {
    throw new RosterError("invalid_window", "standing in for somebody needs a reason, in 500 characters or fewer", { reasonLength: reason.length });
  }
  if (input.endsAt != null && input.endsAt <= input.startsAt) {
    throw new RosterError("invalid_window", "standing in cannot end before it begins", { teamId: input.teamId });
  }
  const person = (await (tx as Db).select({ id: users.id, active: users.active }).from(users).where(eq(users.id, input.userId)))[0];
  if (person === undefined || !person.active) throw new RosterError("unknown_user", undefined, { userId: input.userId });

  const officiatingId = newId();
  try {
    await tx.insert(rosterOfficiating).values({
      id: officiatingId, teamId: input.teamId, userId: input.userId, role: input.role,
      startsAt: input.startsAt, endsAt: input.endsAt ?? null, reason,
      approvedBy: actor.id, createdBy: actor.id, updatedBy: actor.id,
    });
  } catch (e) {
    if (isExclusion(e, "roster_officiating_one_per_role_excl")) {
      throw new RosterError("officiating_overlap", undefined, { teamId: input.teamId, role: input.role });
    }
    throw e;
  }
  return { officiatingId };
}

export async function endOfficiating(tx: Tx, actor: Actor, officiatingId: string, endsAt: Date): Promise<void> {
  const row = (await tx.select().from(rosterOfficiating).where(eq(rosterOfficiating.id, officiatingId)).for("update"))[0];
  if (row === undefined) throw new RosterError("unknown_team", undefined, { officiatingId });
  const team = (await (tx as Db).select().from(rosterTeams).where(eq(rosterTeams.id, row.teamId)))[0]!;
  await requireRosterAct(tx, actor, "publish", { departmentId: team.departmentId });
  if (endsAt <= row.startsAt) {
    throw new RosterError("invalid_window", "standing in cannot end before it begins", { officiatingId });
  }
  await tx.update(rosterOfficiating).set({ endsAt, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(rosterOfficiating.id, officiatingId));
}

export async function officiatingAt(exec: Db | Tx, teamId: string, at: Date): Promise<RosterOfficiatingRow[]> {
  return (exec as Db).select().from(rosterOfficiating)
    .where(and(
      eq(rosterOfficiating.teamId, teamId),
      sql`${rosterOfficiating.startsAt} <= ${at}`,
      or(isNull(rosterOfficiating.endsAt), sql`${rosterOfficiating.endsAt} > ${at}`),
    ))
    .orderBy(asc(rosterOfficiating.role));
}

function isExclusion(e: unknown, constraint: string): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur != null && typeof cur === "object"; i += 1) {
    const c = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof c.code === "string" && c.code.length === 5) return c.code === "23P01" && c.constraint === constraint;
    cur = c.cause;
  }
  return false;
}
