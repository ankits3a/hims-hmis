import { and, eq, gt, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { searchAudit } from "../db/schema";
import type { Db } from "../db/client";

/**
 * PLAN 11h CLOSE / DD8 — THE PER-ACTOR SEARCH RATE LIMIT.
 *
 * ═══ THE THREAT, STATED PRECISELY ═══
 * It is not a fast typist. The palette debounces at 200 ms and a completed query costs two or three
 * requests. The threat is SCRIPTED ENUMERATION — `?q=aa`, `ab`, `ac`… at `limit=50` walks the
 * patient table through a route that is authenticated, permitted, and therefore invisible to every
 * other control in the system. DD8 names it: "the palette must not become a patient-list exporter."
 *
 * ═══ THE STATE ALREADY EXISTS ═══
 * `search_audit` records every EXECUTED search with `actor_id` and `at`, and T5 already built
 * `search_audit_actor_at_idx` on exactly `(actor_id, at)`. So this is a COUNT over an index that is
 * already there. Three consequences, each of which is why it is not done another way:
 *   · No second source of truth — the limit and the audit log can never disagree about what
 *     happened.
 *   · No per-process counter, so it does not silently become per-container the day a second api
 *     instance starts.
 *   · No extra write on the hot path: the row was already being written.
 *
 * ═══ ONLY EXECUTED SEARCHES COUNT — the self-reinforcement trap ═══
 * If refusals were written to `search_audit` too, every retry would EXTEND the block: the harder a
 * busy desk tried, the longer it stayed locked out. That is the failure mode of a hasty limiter —
 * it fails closed on the busiest counter in the building. A refusal is therefore an EVENT
 * (`search.rate_limited`), never an audit row, which is DD4's own rule applied honestly: routine
 * volume to the table, rare semantic facts to the spine. If refusals ever stop being rare, the
 * event stream is exactly where that should become visible.
 *
 * ═══ WHAT IT DELIBERATELY DOES NOT DO ═══
 * No IP dimension — desks share NAT, and one script would throttle a whole floor. No global limit —
 * one busy counter must never slow another. And no lockout row: expiry is arithmetic on a
 * timestamp, so there is nothing for anybody to clear by hand at 3 a.m.
 */
export type RateVerdict = { allowed: boolean; used: number; retryAfterSec: number };

export async function checkSearchRate(
  db: Db,
  actor: Actor,
  opts: { limit: number; windowSec: number; now?: Date },
): Promise<RateVerdict> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.windowSec * 1000);

  const counted = await db
    .select({ n: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${searchAudit.at})` })
    .from(searchAudit)
    .where(and(eq(searchAudit.actorId, actor.id), gt(searchAudit.at, since)));

  const used = counted[0]?.n ?? 0;
  if (used < opts.limit) return { allowed: true, used, retryAfterSec: 0 };

  /**
   * The wait is until the OLDEST request in the window falls out of it — not a flat cooldown. A
   * desk that drifted over the line waits seconds; a script that saturated it waits the window.
   * Rounded up, and floored at one, so a `Retry-After: 0` can never invite an immediate retry.
   */
  const oldest = counted[0]?.oldest ?? null;
  const clearsAt = oldest === null ? now.getTime() : new Date(oldest).getTime() + opts.windowSec * 1000;
  return { allowed: false, used, retryAfterSec: Math.max(1, Math.ceil((clearsAt - now.getTime()) / 1000)) };
}
