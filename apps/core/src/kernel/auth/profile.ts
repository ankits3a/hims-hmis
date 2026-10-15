import { and, eq, gt } from "drizzle-orm";
import { roleAssignments, tempRoleGrants, users } from "../db/schema";
import type { Db } from "../db/client";

/**
 * WHO THE SIGNED-IN PERSON IS, FOR A HEADER (app home round 2, decision 0043). The phone's first
 * screen greeted people by username ("chandan.kumar"); the board says their NAME and what they are
 * here as. Two facts the session's owner may always read about themselves: the full name on their
 * own account and the role keys they hold now. Nothing about anybody else, and no id parameter.
 */
export type MeProfile = { username: string; fullName: string | null; roles: string[] };

export async function meProfile(db: Db, userId: string, now: Date = new Date()): Promise<MeProfile | null> {
  const rows = await db.select({ username: users.username, fullName: users.fullName }).from(users).where(eq(users.id, userId));
  const u = rows[0];
  if (u === undefined) return null;
  const perm = await db.select({ k: roleAssignments.roleKey }).from(roleAssignments).where(eq(roleAssignments.userId, userId));
  const temp = await db.select({ k: tempRoleGrants.roleKey }).from(tempRoleGrants).where(and(eq(tempRoleGrants.userId, userId), gt(tempRoleGrants.expiresAt, now)));
  const fullName = (u.fullName ?? "").trim();
  return { username: u.username, fullName: fullName === "" ? null : fullName, roles: [...new Set([...perm, ...temp].map((r) => r.k))].sort() };
}
