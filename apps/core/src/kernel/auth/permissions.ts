import { and, eq, gt, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { permissions, rolePermissions, roleAssignments, roles, tempRoleGrants } from "../db/schema";
import type { ModuleRegistry } from "../modules/loader";
import type { AuthedRequest } from "./decorators";
import type { Db } from "../db/client";

export type ScopeType = "hospital" | "floor" | "department";
export type ScopeCtx = { departmentId?: string; floorId?: string };

export async function syncPermissions(db: Db, registry: ModuleRegistry): Promise<void> {
  for (const manifest of registry.all()) {
    for (const permission of manifest.permissions) {
      await db
        .insert(permissions)
        .values({ permission, module: manifest.key })
        .onConflictDoUpdate({
          target: permissions.permission,
          set: { module: manifest.key, syncedAt: new Date() },
        });
    }
  }
}

export async function createRole(db: Db, key: string, title: string): Promise<void> {
  await db.insert(roles).values({ key, title });
}

export async function grantPermissionToRole(
  db: Db,
  registry: ModuleRegistry,
  roleKey: string,
  permission: string,
): Promise<void> {
  if (!registry.allPermissions().includes(permission)) {
    throw new Error(
      `unknown permission "${permission}" — permission strings come from module manifests only (spec §4)`,
    );
  }
  await db.insert(rolePermissions).values({ roleKey, permission }).onConflictDoNothing();
}

export async function assignRole(
  db: Db,
  input: { userId: string; roleKey: string; scopeType: ScopeType; scopeId?: string },
): Promise<{ id: string }> {
  if (input.scopeType !== "hospital" && input.scopeId === undefined) {
    throw new Error(`${input.scopeType}-scoped assignment requires a scopeId`);
  }
  const id = newId();
  await db.insert(roleAssignments).values({
    id,
    userId: input.userId,
    roleKey: input.roleKey,
    scopeType: input.scopeType,
    scopeId: input.scopeType === "hospital" ? null : input.scopeId,
  });
  return { id };
}

export type RevokedAssignment = {
  id: string;
  userId: string;
  roleKey: string;
  scopeType: ScopeType;
  scopeId: string | null;
};

/**
 * PLAN 11e T4 — the inverse of `assignRole`, and the LAST of Plan 02's dormant authority functions
 * to gain a caller.
 *
 * IT IS A DELETE, NOT A FLAG, and that is the decision. `hasPermission` reads `role_assignments`
 * live on every request, so a deleted row is effective on the target's NEXT call with no session
 * work of any kind — no revocation, no re-login, no waiting out a TTL. A `revoked_at` column would
 * have added a filter to the hottest read in the system to preserve a history the EVENT STREAM
 * already keeps: `role.assigned` and `role.revoked` are the record of who held what and when, and
 * they are append-only.
 *
 * Returns the row it removed so the caller can event it, or null when there was nothing to remove
 * — which the route turns into a 404 rather than a cheerful 204 over an id that never existed.
 */
export async function revokeRoleAssignment(
  db: Db,
  assignmentId: string,
): Promise<RevokedAssignment | null> {
  const rows = await db
    .delete(roleAssignments)
    .where(eq(roleAssignments.id, assignmentId))
    .returning({
      id: roleAssignments.id,
      userId: roleAssignments.userId,
      roleKey: roleAssignments.roleKey,
      scopeType: roleAssignments.scopeType,
      scopeId: roleAssignments.scopeId,
    });
  const row = rows[0];
  return row === undefined ? null : { ...row, scopeType: row.scopeType as ScopeType };
}

type Holding = { roleKey: string; scopeType: ScopeType; scopeId: string | null };

export async function hasPermission(
  db: Db,
  userId: string,
  permission: string,
  requiredScope: ScopeType,
  ctx: ScopeCtx = {},
): Promise<boolean> {
  const permanent = await db
    .select({
      roleKey: roleAssignments.roleKey,
      scopeType: roleAssignments.scopeType,
      scopeId: roleAssignments.scopeId,
    })
    .from(roleAssignments)
    .where(eq(roleAssignments.userId, userId));

  const temp = await db
    .select({ roleKey: tempRoleGrants.roleKey })
    .from(tempRoleGrants)
    .where(and(eq(tempRoleGrants.userId, userId), gt(tempRoleGrants.expiresAt, new Date())));

  const holdings: Holding[] = [
    ...permanent.map((a) => ({ roleKey: a.roleKey, scopeType: a.scopeType as ScopeType, scopeId: a.scopeId })),
    // Temp grants are exceptional, loud, and time-boxed — they act at hospital scope.
    ...temp.map((t) => ({ roleKey: t.roleKey, scopeType: "hospital" as ScopeType, scopeId: null })),
  ];
  if (holdings.length === 0) return false;

  const roleKeys = [...new Set(holdings.map((h) => h.roleKey))];
  const granted = await db
    .select({ roleKey: rolePermissions.roleKey })
    .from(rolePermissions)
    .where(and(inArray(rolePermissions.roleKey, roleKeys), eq(rolePermissions.permission, permission)));
  const grantedRoles = new Set(granted.map((g) => g.roleKey));

  return holdings.some((h) => {
    if (!grantedRoles.has(h.roleKey)) return false;
    if (h.scopeType === "hospital") return true;
    if (h.scopeType !== requiredScope) return false; // no cross-level inference until org masters exist
    const wanted = requiredScope === "department" ? ctx.departmentId : ctx.floorId;
    return wanted !== undefined && h.scopeId === wanted;
  });
}

export function requestParam(req: AuthedRequest, key: string): string | undefined {
  const fromParams = (req.params as Record<string, string | undefined> | undefined)?.[key];
  if (typeof fromParams === "string") return fromParams;
  const fromQuery = (req.query as Record<string, unknown> | undefined)?.[key];
  if (typeof fromQuery === "string") return fromQuery;
  const fromBody = (req.body as Record<string, unknown> | undefined)?.[key];
  if (typeof fromBody === "string") return fromBody;
  return undefined;
}

export function scopeCtxFromRequest(req: AuthedRequest): ScopeCtx {
  return { departmentId: requestParam(req, "departmentId"), floorId: requestParam(req, "floorId") };
}
