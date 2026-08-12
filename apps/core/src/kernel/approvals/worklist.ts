import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { approvals, roleAssignments, tempRoleGrants } from "../db/schema";
import { withTx } from "../db/client";
import { ApprovalError } from "./types";
import type { UrgencyClass } from "./types";
import type { Db, Tx } from "../db/client";

/**
 * Role keys the user holds now — permanent assignments at ANY scope + unexpired temp
 * grants. Deliberately written HERE rather than by editing Plan 03's kernel/workflow/roles.ts
 * (this plan is additive-only over shipped kernel files — owner decision 2026-08-13). Mirrors
 * that file's proven shape and inherits its marked seams: any-scope until org masters exist
 * (Plan 02 gate report §7.3), static holders until the roster substrate (Plan 11-adjacent).
 */
export async function rolesHeldBy(tx: Tx, userId: string): Promise<string[]> {
  const permanent = await tx
    .select({ roleKey: roleAssignments.roleKey })
    .from(roleAssignments)
    .where(eq(roleAssignments.userId, userId));
  const temp = await tx
    .select({ roleKey: tempRoleGrants.roleKey })
    .from(tempRoleGrants)
    .where(and(eq(tempRoleGrants.userId, userId), gt(tempRoleGrants.expiresAt, new Date())));
  return [...new Set([...permanent.map((r) => r.roleKey), ...temp.map((r) => r.roleKey)])].sort();
}

export type WorklistFilters = {
  status?: "pending" | "granted" | "rejected";
  typeKey?: string;
  urgencyClass?: UrgencyClass;
  approverRole?: string;
  olderThanMinutes?: number;
  limit?: number;
  offset?: number;
};

export type ApprovalRow = typeof approvals.$inferSelect;

/**
 * The approver worklist (owner decision Q5): auto-scoped to the caller's held roles —
 * a filter can narrow within that set, never widen past it. emergency → urgent → routine,
 * then oldest first (E-15 ordering).
 */
export async function listApprovals(
  db: Db,
  actor: Actor,
  filters: WorklistFilters = {},
): Promise<{ items: ApprovalRow[]; total: number }> {
  if (actor.type !== "user") {
    throw new ApprovalError("user_actor_required", "the worklist is scoped to a user's held roles");
  }
  return withTx(db, async (tx) => {
    let roles = await rolesHeldBy(tx, actor.id);
    if (filters.approverRole !== undefined) {
      roles = roles.filter((r) => r === filters.approverRole); // narrowing only
    }
    if (roles.length === 0) return { items: [], total: 0 }; // inArray([]) is invalid SQL — guard first
    const conditions = [
      eq(approvals.status, filters.status ?? "pending"),
      inArray(approvals.approverRole, roles),
    ];
    if (filters.typeKey !== undefined) conditions.push(eq(approvals.typeKey, filters.typeKey));
    if (filters.urgencyClass !== undefined) conditions.push(eq(approvals.urgencyClass, filters.urgencyClass));
    if (filters.olderThanMinutes !== undefined) {
      conditions.push(lte(approvals.requestedAt, new Date(Date.now() - filters.olderThanMinutes * 60_000)));
    }
    const where = and(...conditions);
    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;
    const urgencyRank = sql<number>`case ${approvals.urgencyClass} when 'emergency' then 0 when 'urgent' then 1 else 2 end`;
    const items = await tx
      .select()
      .from(approvals)
      .where(where)
      .orderBy(urgencyRank, asc(approvals.requestedAt))
      .limit(limit)
      .offset(offset);
    const counted = await tx.select({ n: sql<string>`count(*)` }).from(approvals).where(where);
    return { items, total: Number(counted[0]!.n) }; // count(*) arrives as text — force a real number
  });
}

export async function getApproval(db: Db, approvalId: string): Promise<ApprovalRow | null> {
  const rows = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  return rows[0] ?? null;
}
