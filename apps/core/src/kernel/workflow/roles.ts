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
/**
 * WHO HOLDS THIS ROLE **AT A GIVEN SCOPE** — PHASE 11i T2.
 *
 * `usersHoldingRole` below deliberately ignores scope: escalation wants everyone who could answer,
 * wherever they were granted. A READINESS CENSUS wants the opposite question, because
 * `hasPermission` treats the two differently — a `hospital` holding satisfies any required scope,
 * a `department` holding satisfies only its own department. So "the laboratory has a pathologist"
 * is false when the only pathologist holds the role scoped to Cardiology, and a census built on
 * `usersHoldingRole` would report it green. That is the shape of the mutant 11i T2 names.
 *
 * A separate function rather than a parameter on the existing one: seven non-test callers read
 * `usersHoldingRole` today and none of them wants a scope filter, so widening its signature would
 * be inviting the wrong default into an escalation path.
 *
 * Temp grants act at hospital scope (`permissions.ts:126`), so they count for `hospital` and for
 * nothing narrower — the same rule `hasPermission` applies.
 */
export async function usersHoldingRoleAtScope(
  tx: Tx, roleKey: string, scopeType: "hospital" | "floor" | "department", scopeId?: string,
): Promise<string[]> {
  const permanent = await tx
    .select({ userId: roleAssignments.userId })
    .from(roleAssignments)
    .where(and(
      eq(roleAssignments.roleKey, roleKey),
      eq(roleAssignments.scopeType, scopeType),
      ...(scopeType === "hospital" || scopeId === undefined ? [] : [eq(roleAssignments.scopeId, scopeId)]),
    ));
  const temp = scopeType !== "hospital" ? [] : await tx
    .select({ userId: tempRoleGrants.userId })
    .from(tempRoleGrants)
    .where(and(eq(tempRoleGrants.roleKey, roleKey), gt(tempRoleGrants.expiresAt, new Date())));
  return [...new Set([...permanent.map((r) => r.userId), ...temp.map((r) => r.userId)])].sort();
}

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
