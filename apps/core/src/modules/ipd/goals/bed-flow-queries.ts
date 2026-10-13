import { sql } from "drizzle-orm";
import { shareGoal } from "./goal-queries";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../kernel/db/client";
import type { GoalMeasured, GoalQuery, GoalRunArgs } from "./types";

/**
 * E5.2 (#739) — BED FLOW's weekly rates (plan E5.2 "acceptance and override rates logged per week"; M5 gate "Bed Flow
 * acceptance rate measured 4 weeks"), written the E0.5 way: read-only, the window [from, to) from the caller, never the
 * clock; an empty population is `value: null`, never 0.
 *
 * Population: Bed Flow proposals that ENDED in the window by a bed act — `accepted` (the bed proposed) or `overridden`
 * (another bed). Withdrawn proposals (bed taken, blocked, request cancelled) are not decisions and are not counted. The
 * goal's own split is the IST week (Monday); `groupBy: "day"` splits by IST day. Kept apart from `IPD_GOAL_QUERIES`
 * (the G1–G11 ledger, whose key list the E0.5 acceptance pins).
 */

const ts = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

const decided = (a: GoalRunArgs, hit: SQL): SQL => sql`
  select id as item, to_char(date_trunc('week', ended_at at time zone 'Asia/Kolkata'), 'YYYY-MM-DD') as grp, ended_at as at, ${hit} as hit
  from ipd_bed_proposals
  where outcome in ('accepted', 'overridden') and ended_at >= ${ts(a.from)} and ended_at < ${ts(a.to)}`;

export const IPD_BED_FLOW_QUERIES: Record<string, GoalQuery> = {
  BF1: {
    id: "BF1", title: "Bed Flow proposals accepted", unit: "percent", window: "every week",
    metric: "Proposals the bed manager took (the patient held or placed on the proposed bed) ÷ proposals decided by a bed act.",
    target: [], targetNote: "Reported weekly for 4 weeks (M5 gate); no target yet.",
    run: (db: Db, a: GoalRunArgs): Promise<GoalMeasured> => shareGoal(db, a, decided(a, sql`outcome = 'accepted'`)),
  },
  BF2: {
    id: "BF2", title: "Bed Flow proposals overridden", unit: "percent", window: "every week",
    metric: "Proposals where the desk chose another bed ÷ proposals decided by a bed act.",
    target: [], targetNote: "Reported weekly for 4 weeks (M5 gate); no target yet.",
    run: (db: Db, a: GoalRunArgs): Promise<GoalMeasured> => shareGoal(db, a, decided(a, sql`outcome = 'overridden'`)),
  },
};
