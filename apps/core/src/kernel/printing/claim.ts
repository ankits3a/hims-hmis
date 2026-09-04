import { and, eq, inArray, sql } from "drizzle-orm";
import { printJobs } from "../db/schema";
import type { Db } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-24 T2 — THE CLAIM, AND WHY IT CARRIES A LEASE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The relay lives in the hospital and the queue lives in Helsinki, so a claim crosses a link that
 * can drop between the claim and the paper. That single fact decides the design:
 *
 *   · **`FOR UPDATE SKIP LOCKED`**, exactly as `notify/pump.ts` does it. Two relays (or one relay
 *     and its own retry) never take the same slip, and a second caller makes progress on the REST
 *     of the batch instead of queueing behind the first.
 *   · **A LEASE, which `notify` has no need of.** The notify pump and its rows live in one process
 *     on one machine; a print job is handed to a process on another continent that can be switched
 *     off mid-job. Without a lease that row sits in `claimed` for ever, and the slip nobody is
 *     printing is the one nobody notices. When the lease lapses the row becomes claimable again.
 *
 * SO THE FAILURE MODE IS A DUPLICATE SLIP, NOT A MISSING ONE, and that is the right way round: a
 * clerk who gets two token slips throws one away, while a patient who gets none stands at a counter
 * that believes it printed. Nothing downstream is idempotent-sensitive — paper is not a payment.
 */

/** How long a relay may hold a job before the row is offered to someone else. */
export const LEASE_SECONDS = 120;

/**
 * Attempts before a job is given up on. R7 makes the failure ADVISORY — the screen says the slip
 * did not come out and offers a reprint — so this is deliberately small: retrying a jammed printer
 * twenty times delays the honest message without making paper appear.
 */
export const MAX_ATTEMPTS = 3;

export type ClaimedJob = {
  id: string;
  document: string;
  destination: string;
  params: Record<string, unknown>;
  attempts: number;
};

/**
 * Claims up to `limit` jobs for `relayId`, restricted to the destinations this relay actually
 * serves.
 *
 * DESTINATIONS ARE A FILTER, NOT A COURTESY. A hospital may run one relay for the whole site today
 * and a second for another building tomorrow; a relay that claimed a job for a printer it cannot
 * reach would take the slip out of the queue and fail it, and the row would burn an attempt for a
 * reason that has nothing to do with the printer.
 */
export async function claimPrintJobs(
  db: Db,
  input: { relayId: string; destinations: string[]; limit: number; now?: Date },
): Promise<ClaimedJob[]> {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString();
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit)));
  if (input.destinations.length === 0) return [];

  /*
    The predicate has TWO arms and the second is the lease recovery:
      · `queued` rows that are due (`next_attempt_at` null or passed), and
      · `claimed` rows whose lease has lapsed — a relay that died holding them.
    Both are claimable by the same statement, so recovery needs no separate sweep, no scheduler
    tick and no second code path that could rot unexercised.
  */
  const claimed = await db.execute(sql`
    update print_jobs
    set status = 'claimed',
        claimed_by = ${input.relayId},
        claimed_at = ${at}::timestamptz,
        lease_expires_at = ${leaseUntil}::timestamptz,
        updated_at = ${at}::timestamptz
    where id in (
      select id from print_jobs
      where destination in (${sql.join(input.destinations.map((d) => sql`${d}`), sql`, `)})
        and (
          (status = 'queued' and (next_attempt_at is null or next_attempt_at <= ${at}::timestamptz))
          or (status = 'claimed' and lease_expires_at is not null and lease_expires_at <= ${at}::timestamptz)
        )
      order by created_at asc, id asc
      limit ${limit}
      for update skip locked
    )
    returning id
  `);

  const ids = (claimed.rows as unknown as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return [];

  const rows = await db.select().from(printJobs).where(inArray(printJobs.id, ids));
  return [...rows]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
    .map((r) => ({
      id: r.id,
      document: r.document,
      destination: r.destination,
      params: r.params,
      attempts: r.attempts,
    }));
}

/**
 * The relay reports paper. Guarded on `claimed_by` so a relay whose lease lapsed — and whose job
 * another relay has since taken and printed — cannot overwrite the winner's result with its own
 * late report. The flip is a no-op and the function says so rather than pretending.
 */
export async function reportPrinted(db: Db, id: string, relayId: string, now = new Date()): Promise<boolean> {
  const done = await db
    .update(printJobs)
    .set({ status: "printed", printedAt: now, updatedAt: now })
    .where(and(eq(printJobs.id, id), eq(printJobs.status, "claimed"), eq(printJobs.claimedBy, relayId)))
    .returning({ id: printJobs.id });
  return done.length > 0;
}

/**
 * The relay reports a failure — a jam, an offline queue, a rejected document.
 *
 * Under `MAX_ATTEMPTS` the row goes back to `queued` with a backoff; at the cap it becomes
 * `failed`, which is TERMINAL AND ADVISORY (R7). Nothing retries it automatically after that: the
 * screen tells the clerk, and a reprint is a NEW row with a new dedupe key and a new requester,
 * which is what makes "who printed this again, and why" answerable at all.
 */
export async function reportFailed(
  db: Db,
  id: string,
  relayId: string,
  error: string,
  now = new Date(),
): Promise<"requeued" | "failed" | "not_claimed"> {
  const rows = await db
    .select({ attempts: printJobs.attempts })
    .from(printJobs)
    .where(and(eq(printJobs.id, id), eq(printJobs.status, "claimed"), eq(printJobs.claimedBy, relayId)));
  const current = rows[0];
  if (current === undefined) return "not_claimed";

  const attempts = current.attempts + 1;
  const giveUp = attempts >= MAX_ATTEMPTS;
  // Backoff in whole seconds, doubling: 30 s, 60 s. Short, because a queue is waiting and R7 says
  // the honest message beats a long silence.
  const backoffMs = 30_000 * 2 ** (attempts - 1);
  await db
    .update(printJobs)
    .set({
      status: giveUp ? "failed" : "queued",
      attempts,
      lastError: error.slice(0, 1000),
      nextAttemptAt: giveUp ? null : new Date(now.getTime() + backoffMs),
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(printJobs.id, id), eq(printJobs.status, "claimed"), eq(printJobs.claimedBy, relayId)));
  return giveUp ? "failed" : "requeued";
}
