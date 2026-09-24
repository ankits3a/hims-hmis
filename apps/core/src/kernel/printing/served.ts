import { and, eq, gt, isNotNull, or, sql } from "drizzle-orm";
import { printJobs } from "../db/schema";
import type { Db, Tx } from "../db/client";
import type { PrintDestination } from "./enqueue";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PHARMACY P1 — IS ANYBODY THERE? WHETHER A RELAY IS SERVING A DESTINATION
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The OPD counter queues its paper unconditionally, inside the visit's transaction, and learns about
 * a missing printer from a job that never moves. A desk that prints on demand can ask first, and
 * should: a pharmacy bill queued at a site with no relay would sit `queued` for days and then come
 * off the roll, stale, the morning somebody installs one.
 *
 * The server holds no printer configuration — the relay owns the mapping from a logical destination
 * to a CUPS queue (`tools/print-relay/README.md`) — so the only thing it can know is what the
 * relay has DONE. Two pieces of evidence, either sufficient:
 *
 *   1. a job for THIS destination was claimed within the last `SERVED_DAYS` — the relay maps it;
 *   2. a job for ANY destination was claimed within the last `ALIVE_HOURS` — the site's one relay
 *      (owner ruling 2026-09-04: one per SITE, not per desk) is running, so a first job for a newly
 *      mapped destination is worth queuing. Without this arm a relay could never receive its first
 *      pharmacy job, and so could never produce the evidence of arm 1.
 *
 * Neither is a promise the paper will come out — a mapped queue can jam — which is why the desk
 * also watches the jobs it queued and offers the browser when they do not move. This answers the
 * narrower question "is queuing pointless", and answers it from rows rather than from a setting
 * somebody has to remember to change.
 *
 * `claimed_at` is cleared when a relay reports a failure and the row is requeued, and kept when it
 * reports the paper printed, so a printed job is evidence and a bounced one is not.
 */
export const SERVED_DAYS = 7;
export const ALIVE_HOURS = 24;

export async function relayServes(db: Db | Tx, destination: PrintDestination, now: Date = new Date()): Promise<boolean> {
  const servedSince = new Date(now.getTime() - SERVED_DAYS * 86_400_000);
  const aliveSince = new Date(now.getTime() - ALIVE_HOURS * 3_600_000);
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(printJobs)
    .where(and(
      isNotNull(printJobs.claimedAt),
      or(
        and(eq(printJobs.destination, destination), gt(printJobs.claimedAt, servedSince)),
        gt(printJobs.claimedAt, aliveSince),
      ),
    ))
    .limit(1);
  return rows.length > 0;
}
