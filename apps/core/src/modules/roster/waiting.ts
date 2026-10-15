import { and, count, eq, gt, gte, lt, min, ne } from "drizzle-orm";
import { rosterAssignments, staffAbsences } from "../../kernel/db/schema/roster";
import { istDayString as istDay } from "../../kernel/approvals/cumulative";
import { istMidnightAfter, waitingItem } from "../../kernel/desk/waiting";
import { noDeskCards } from "../../kernel/desk/types";
import type { DeskProvider, DeskProviderCtx } from "../../kernel/desk/types";
import type { WaitingItem } from "@hmis/contracts";
import { leaveToDecide } from "./leave";

/**
 * E1.4 / E1.5 (decision 0064) — the person's duties still to run today: their own effective
 * assignments (an `off` is not a duty) that have not ended and start before IST midnight. The same
 * rows `myDuties` reads (`swaps.ts` `myDutyRows`), counted.
 */
async function today(ctx: DeskProviderCtx) {
  const [row] = await ctx.db
    .select({ n: count() })
    .from(rosterAssignments)
    .where(and(
      eq(rosterAssignments.effective, true), eq(rosterAssignments.userId, ctx.actor.id),
      ne(rosterAssignments.kind, "off"),
      gt(rosterAssignments.endsAt, ctx.now), lt(rosterAssignments.startsAt, istMidnightAfter(istDay(ctx.now))),
    ));
  const item = waitingItem("roster.dutiesToday", row?.n ?? 0, null);
  return item === null ? [] : [item];
}

export const rosterWaiting: DeskProvider = { key: "roster.waiting", permission: "roster.read", load: noDeskCards, waiting: today };

/** A refused leave stays a line for a week (the bell's own window), and only while it is still ahead. */
const REFUSED_DAYS = 7;

/**
 * E2.2 (decision 0069) — LEAVE: the requests waiting for MY yes or no (the list `leaveToDecide` draws,
 * which checks the roster's `publish` act per department — so a department head is counted, though
 * they hold nothing hospital-wide), and MY OWN leave refused in the last week and still ahead. Counts
 * only; the reason is read on My leave. Every person has leave, so this provider gates itself.
 */
async function leave(ctx: DeskProviderCtx): Promise<WaitingItem[]> {
  const waiting = await leaveToDecide(ctx.db, ctx.actor);
  const oldest = waiting.reduce<string | null>((o, w) => (o === null || w.requestedAt < o ? w.requestedAt : o), null);
  const [refused] = await ctx.db
    .select({ n: count(), oldest: min(staffAbsences.decidedAt) })
    .from(staffAbsences)
    .where(and(
      eq(staffAbsences.userId, ctx.actor.id), eq(staffAbsences.status, "rejected"),
      gte(staffAbsences.decidedAt, new Date(ctx.now.getTime() - REFUSED_DAYS * 86_400_000)), gte(staffAbsences.startsAt, ctx.now),
    ));
  return [waitingItem("roster.leaveToDecide", waiting.length, oldest), waitingItem("roster.leaveRefused", refused?.n ?? 0, refused?.oldest ?? null)]
    .filter((i): i is WaitingItem => i !== null);
}

export const rosterLeaveWaiting: DeskProvider = {
  key: "roster.leave", permission: "roster.read", load: noDeskCards, waiting: leave, waitingSelfGated: true,
};
