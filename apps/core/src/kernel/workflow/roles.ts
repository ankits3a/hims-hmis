import { and, eq, gt, inArray } from "drizzle-orm";
import { roleAssignments, tempRoleGrants } from "../db/schema";
import type { Tx } from "../db/client";

/**
 * Role-holding checks for workflow enforcement (spec §10.2: allowed roles per transition,
 * escalation to role holders). ANY-scope holdings satisfy: scope ids are opaque until org
 * masters exist (Plan 02 gate report §7.3), so scoped enforcement is a marked SEAM — when
 * org masters land, tighten here, in one place. Tx-typed: every caller runs inside withTx.
 */
export async function actorHoldsAnyRole(tx: Tx, userId: string, roleKeys: string[]): Promise<boolean> {
  if (roleKeys.length === 0) return false;
  const permanent = await tx
    .select({ roleKey: roleAssignments.roleKey })
    .from(roleAssignments)
    .where(and(eq(roleAssignments.userId, userId), inArray(roleAssignments.roleKey, roleKeys)));
  if (permanent.length > 0) return true;
  const temp = await tx
    .select({ roleKey: tempRoleGrants.roleKey })
    .from(tempRoleGrants)
    .where(
      and(
        eq(tempRoleGrants.userId, userId),
        inArray(tempRoleGrants.roleKey, roleKeys),
        gt(tempRoleGrants.expiresAt, new Date()),
      ),
    );
  return temp.length > 0;
}

/**
 * Static role-holder resolution — the roster substrate is Plan 11-adjacent (roadmap);
 * until it lands, escalation resolves to everyone currently holding the role.
 * Deduped and sorted so event payloads are deterministic.
 */
export async function usersHoldingRole(tx: Tx, roleKey: string): Promise<string[]> {
  const permanent = await tx
    .select({ userId: roleAssignments.userId })
    .from(roleAssignments)
    .where(eq(roleAssignments.roleKey, roleKey));
  const temp = await tx
    .select({ userId: tempRoleGrants.userId })
    .from(tempRoleGrants)
    .where(and(eq(tempRoleGrants.roleKey, roleKey), gt(tempRoleGrants.expiresAt, new Date())));
  return [...new Set([...permanent.map((r) => r.userId), ...temp.map((r) => r.userId)])].sort();
}
