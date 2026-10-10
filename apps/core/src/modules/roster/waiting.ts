import { and, count, eq, gt, lt, ne } from "drizzle-orm";
import { rosterAssignments } from "../../kernel/db/schema/roster";
import { istDayString as istDay } from "../../kernel/approvals/cumulative";
import { istMidnightAfter, waitingItem } from "../../kernel/desk/waiting";
import { noDeskCards } from "../../kernel/desk/types";
import type { DeskProvider, DeskProviderCtx } from "../../kernel/desk/types";

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
