import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { WireAgentRun } from "@hmis/contracts";
import { doctorDeskAgentRuns } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * DD-0.9 — THE DESK'S AGENT-RUN LOG, append-only. A deterministic job of the Desk writes one row
 * per run (brief built; later the chaser fired, the report sent), with `failed` when it failed, so
 * "nothing failed" on the Tower is a reading of rows and never a default. A human act (a nudge) is
 * not an agent run and is not written here.
 *
 * A run is the unit's (`team_id`) or one person's (`user_id`, e.g. their login brief); a doctor sees
 * their unit's runs and their own.
 */
export const AGENT_RUNS_WINDOW_HOURS = 24;
export const AGENT_RUNS_LIMIT = 20;

export type RunInput = {
  agent: string; teamId: string | null; userId: string | null; outcome: "ok" | "failed";
  summaryKey: string; params: Record<string, string | number>; at: Date;
};

export async function recordRun(exec: Db | Tx, r: RunInput): Promise<void> {
  await (exec as Db).insert(doctorDeskAgentRuns).values({
    id: newId(), agent: r.agent, teamId: r.teamId, userId: r.userId, outcome: r.outcome,
    summaryKey: r.summaryKey, params: r.params, ranAt: r.at,
  });
}

export async function runsFor(exec: Db | Tx, teamId: string | null, userId: string, at: Date): Promise<WireAgentRun[]> {
  const since = new Date(at.getTime() - AGENT_RUNS_WINDOW_HOURS * 3_600_000);
  const mine = and(eq(doctorDeskAgentRuns.userId, userId));
  const unit = teamId === null ? undefined : and(eq(doctorDeskAgentRuns.teamId, teamId), isNull(doctorDeskAgentRuns.userId));
  const rows = await (exec as Db).select().from(doctorDeskAgentRuns)
    .where(and(gte(doctorDeskAgentRuns.ranAt, since), unit === undefined ? mine : or(mine, unit)))
    .orderBy(desc(doctorDeskAgentRuns.ranAt)).limit(AGENT_RUNS_LIMIT);
  return rows.map((r) => ({
    id: r.id, agent: r.agent, outcome: r.outcome as WireAgentRun["outcome"], summaryKey: r.summaryKey,
    // A run may keep a structured record beside its line (the unit report keeps the report): the line's
    // params are its flat values only.
    params: Object.fromEntries(Object.entries(r.params as Record<string, unknown>)
      .filter((e): e is [string, string | number] => typeof e[1] === "string" || typeof e[1] === "number")),
    ranAt: r.ranAt.toISOString(),
  }));
}
