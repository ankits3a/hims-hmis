import { and, eq, gt, gte, inArray, or } from "drizzle-orm";
import { APPROVAL_DEADLINE_MINUTES } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { approvals, roleAssignments, tempRoleGrants, users } from "../db/schema";
import { raiseNotice } from "../alerts/notices";
import { istDayString } from "./cumulative";
import { dueAtOf } from "./people";
import type { Db } from "../db/client";

/**
 * ═══ APP HOME ROUND 2 (owner 2026-10-07, decisions 0042/0043) ═══
 *
 * TWO SMALL READS THE FIRST SCREEN WAS MISSING.
 *
 * 1. WHAT I ASKED FOR (`myRequests`). The front desk raises a discount and then has no way to know
 *    it was answered short of walking to the manager. This is the requester's own list: everything
 *    of theirs still pending, and what was decided TODAY. No patient, no note — a status and an
 *    amount, which the person who typed the request already knows.
 *
 * 2. AN APPROVAL PAST ITS TIME (`sweepOverdueApprovals`). The deadline is a property of the KIND
 *    (`APPROVAL_DEADLINE_MINUTES`). When it passes, everyone who could decide it is told ONCE — the
 *    key is the approval's id, so a second tick, a second worker and a restart raise nothing more.
 *    Only a deadline that passed in the last hour is announced: the first run after a deploy must
 *    not buzz for every old request that has been sitting for a week.
 */
export const APPROVAL_OVERDUE_KIND = "approval_overdue";
export const APPROVAL_REF_TYPE = "approval";
const ANNOUNCE_WINDOW_MS = 60 * 60_000;

export type MyRequest = {
  id: string; typeKey: string; amountPaise: number | null;
  status: string; requestedAt: Date; decidedAt: Date | null; dueAt: Date | null;
};

export async function myRequests(db: Db, actor: Actor, now: Date = new Date()): Promise<{ items: MyRequest[] }> {
  if (actor.type !== "user") return { items: [] };
  const dayStart = new Date(`${istDayString(now)}T00:00:00+05:30`);
  const rows = await db.select().from(approvals)
    .where(and(eq(approvals.requesterId, actor.id), or(eq(approvals.status, "pending"), gte(approvals.decidedAt, dayStart))))
    .limit(50);
  rows.sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
  return { items: rows.map((r) => ({
    id: r.id, typeKey: r.typeKey, amountPaise: r.amountPaise, status: r.status,
    requestedAt: r.requestedAt, decidedAt: r.decidedAt, dueAt: dueAtOf(r),
  })) };
}

/** Active people who hold `role` now, permanently or by an unexpired temporary grant. */
async function holdersOf(db: Db, roles: string[], now: Date): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (roles.length === 0) return out;
  const perm = await db.select({ u: roleAssignments.userId, k: roleAssignments.roleKey }).from(roleAssignments).where(inArray(roleAssignments.roleKey, roles));
  const temp = await db.select({ u: tempRoleGrants.userId, k: tempRoleGrants.roleKey }).from(tempRoleGrants)
    .where(and(inArray(tempRoleGrants.roleKey, roles), gt(tempRoleGrants.expiresAt, now)));
  const ids = [...new Set([...perm, ...temp].map((r) => r.u))];
  if (ids.length === 0) return out;
  const active = new Set((await db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.active, true)))).map((r) => r.id));
  for (const r of [...perm, ...temp]) {
    if (!active.has(r.u)) continue;
    const list = out.get(r.k) ?? [];
    if (!list.includes(r.u)) list.push(r.u);
    out.set(r.k, list);
  }
  return out;
}

/** Returns how many notices were written. */
export async function sweepOverdueApprovals(db: Db, now: Date = new Date()): Promise<number> {
  const longest = Math.max(...Object.values(APPROVAL_DEADLINE_MINUTES));
  const oldest = new Date(now.getTime() - longest * 60_000 - ANNOUNCE_WINDOW_MS);
  const pending = await db.select().from(approvals).where(and(eq(approvals.status, "pending"), gte(approvals.requestedAt, oldest)));
  const due = pending.filter((r) => {
    const at = dueAtOf(r);
    return at !== null && at.getTime() <= now.getTime() && at.getTime() > now.getTime() - ANNOUNCE_WINDOW_MS;
  });
  if (due.length === 0) return 0;
  const holders = await holdersOf(db, [...new Set(due.map((r) => r.approverRole))], now);
  let raised = 0;
  for (const r of due) {
    for (const userId of holders.get(r.approverRole) ?? []) {
      if (userId === r.requesterId) continue; // nobody is told to hurry their own request
      const won = await raiseNotice(db, {
        userId, kind: APPROVAL_OVERDUE_KIND,
        // GC6: the kind and the wait. No patient, no amount, no requester's note.
        title: "An approval has passed its time",
        body: "A request waiting for your decision is past its deadline. Open Approvals to decide it.",
        refType: APPROVAL_REF_TYPE, refId: r.id, sourceKey: `approval_overdue:${r.id}`, at: now,
      });
      if (won) raised += 1;
    }
  }
  return raised;
}
