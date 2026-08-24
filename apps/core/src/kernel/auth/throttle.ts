import { and, eq, lt, sql } from "drizzle-orm";
import { authThrottle } from "../db/schema";
import { withTx } from "../db/client";
import type { Db, Tx } from "../db/client";

/**
 * PLAN 11g / DD4 — PER-ACCOUNT, SELF-HEALING BACKOFF ON THE CREDENTIAL PATHS.
 *
 * ═══ WHAT WAS MEASURED ═══
 *
 * The 2026-08-24 synthetic smoke test put five consecutive wrong passwords through
 * `POST /auth/login` and got 401 five times, then the correct password succeeded immediately. A
 * grep across `kernel/auth/` and `kernel/http/` for `lockout|failed_attempts|rateLimit|throttl`
 * returned only the ADMINISTRATOR-lockout invariant, which is an unrelated mechanism.
 * `@nestjs/throttler` is not a dependency. This is a hospital on the public internet with a
 * ten-character password floor and a FOUR-DIGIT pin, and nothing at all was protecting either.
 *
 * ═══ FOUR DECISIONS, EACH OF WHICH COULD HAVE GONE THE OTHER WAY ═══
 *
 * **1. Per-ACCOUNT, not per-IP.** Every request arrives from the Caddy container, so an IP
 * throttle without a trusted `X-Forwarded-For` would throttle the proxy; and a hospital desk NATs
 * a whole ward behind one address, so it would punish the ward for one person's fumbled password.
 *
 * **2. Keyed on the SUBMITTED username, existing or not.** A throttle that only counted real
 * accounts would make the 429 a membership oracle — six wrong guesses and the response shape tells
 * an attacker whether `dr.sharma` exists. Keying on the submitted string closes that and blunts
 * spraying against invented names at the same time. There is deliberately no FK.
 *
 * **3. BACKOFF, never lockout.** Nothing here needs an administrator to clear it. Production has
 * exactly ONE full administrator (runbook O1, still open), and a credential state whose only
 * repair is a person who may be asleep is precisely the failure shape Plan 11e existed to end.
 * Every refusal expires by itself, and the longest anybody can be held out is 15 minutes.
 *
 * **4. The accepted cost, stated rather than discovered.** Because the key is the submitted
 * username, an attacker who knows a clinician's username can hold it in backoff by failing on
 * purpose. That is the classic account-lockout trade and it is accepted here; the 15-minute cap is
 * what bounds it, `pin` is a separate counter so a poisoned password row cannot close the terminal
 * switch, and break-glass is untouched. The alternative is no brute-force resistance at all.
 *
 * ═══ THE ARITHMETIC, SO THE NUMBERS ARE A DECISION AND NOT A TASTE ═══
 *
 * Five attempts per 15 minutes is 480/day. Against `switchWithPin`'s 10,000-value keyspace that is
 * ~21 days to cover it, against roughly one second unthrottled today — and every one of those
 * failures leaves a row an operator can read. Against a password meeting the shipped policy it is
 * not a threat model at all.
 *
 * NOTHING HERE VERIFIES A CREDENTIAL, AND NOTHING HERE WEAKENS ONE (AGENT-RULES rule 14). The
 * shipped verification path is untouched: this module decides only whether an attempt is allowed
 * to be MADE, and it is consulted BEFORE verification so a throttled attempt costs no argon2.
 */

/** Consecutive failures inside the window before the first refusal. The 5th failure sets it. */
export const THROTTLE_THRESHOLD = 5;
/** Failures older than this do not count: the counter is rolling, so it forgives on its own. */
export const THROTTLE_WINDOW_MS = 60 * 60 * 1000;
/** The first backoff, at the threshold. It doubles per further failure. */
export const THROTTLE_BASE_MS = 60 * 1000;
/** The ceiling. Reached at the 9th consecutive failure and never exceeded. */
export const THROTTLE_MAX_MS = 15 * 60 * 1000;

export type ThrottleKind = "login" | "pin";

/**
 * The longest key this table will store. **It is a correctness bound, not tidiness** (Plan 11g
 * close review, MAJOR 2): `loginSchema` puts no ceiling on `username` — deliberately, because
 * login VERIFIES a credential rather than choosing one — and the JSON body limit is 1 MB, so an
 * unauthenticated caller could submit a multi-kilobyte username. `subject` is half of this table's
 * composite PRIMARY KEY, and a btree index tuple over ~2704 bytes is rejected by Postgres
 * outright: the INSERT would throw, the throw would escape the login handler, and a route that
 * used to answer a clean 401 would answer **500** to an anonymous request. Truncating here fixes
 * it for both credential paths in one place and changes nothing about what login ACCEPTS.
 *
 * Two usernames sharing a 64-character prefix share one counter. That is harmless in both
 * directions: neither can authenticate as the other, and sharing a counter can only make the
 * throttle stricter, never looser.
 */
const MAX_SUBJECT_LENGTH = 64;

/**
 * The key. Trimmed, lower-cased and bounded so `Asha `, `asha` and `ASHA` share one counter —
 * otherwise the throttle is bypassed by changing the case of a letter, which is not a defence.
 */
export function throttleSubject(username: string): string {
  return username.trim().toLowerCase().slice(0, MAX_SUBJECT_LENGTH);
}

/** The backoff for the nth consecutive failure. Below the threshold there is none. */
export function backoffMs(failures: number): number {
  if (failures < THROTTLE_THRESHOLD) return 0;
  return Math.min(THROTTLE_BASE_MS * 2 ** (failures - THROTTLE_THRESHOLD), THROTTLE_MAX_MS);
}

/**
 * The instant the caller may next attempt, or `null` when the attempt may proceed NOW.
 *
 * Read-only and cheap: one primary-key lookup, taken before any credential verification.
 */
export async function throttleRetryAt(
  db: Db,
  kind: ThrottleKind,
  username: string,
  now: Date,
): Promise<Date | null> {
  const rows = await db
    .select({ retryAfter: authThrottle.retryAfter })
    .from(authThrottle)
    .where(and(eq(authThrottle.kind, kind), eq(authThrottle.subject, throttleSubject(username))));
  const retryAfter = rows[0]?.retryAfter ?? null;
  if (retryAfter === null) return null;
  return retryAfter.getTime() > now.getTime() ? retryAfter : null;
}

/**
 * Count one failed attempt.
 *
 * ONE TRANSACTION WITH THE ROW LOCKED, and that is correctness rather than tidiness: a read-modify-
 * write would let N concurrent attempts all read the same count and all write count+1, so an
 * attacker firing in parallel would get more attempts through than the threshold allows — which is
 * exactly the traffic this exists to stop. `INSERT … ON CONFLICT DO NOTHING` first because
 * `SELECT … FOR UPDATE` locks nothing when the row does not exist yet.
 */
export async function recordThrottleFailure(
  db: Db,
  kind: ThrottleKind,
  username: string,
  now: Date,
): Promise<{ failures: number; retryAfter: Date | null }> {
  const subject = throttleSubject(username);
  return withTx(db, async (tx: Tx) => {
    // PRUNE FIRST (Plan 11g close review, MAJOR 2). Every failed attempt against a NEW submitted
    // string writes a row, and `clearThrottle` only ever removes one on a SUCCESSFUL
    // authentication for that exact subject — so without this, an attacker spraying invented
    // usernames grows the production database, and its WAL archive, without limit. Nothing else
    // reaps this table: it has no retention job and deliberately no place in one, because the
    // rows are worthless the moment their window passes.
    //
    // A row whose LAST failure is older than the window can no longer contribute to any threshold
    // (`withinWindow` below is false for it) and its `retry_after` is long past, so deleting it is
    // information-free. Keyed on `last_failed_at`, never `first_failed_at`: a subject failing
    // steadily for hours has an old first failure and must not be forgotten.
    //
    // It runs INSIDE this transaction and BEFORE the lock below, so the subject's own expired row
    // is deleted and immediately recreated at zero — which is the same state the `!withinWindow`
    // branch produces, by a shorter road. Growth is bounded by the distinct subjects seen inside
    // one window rather than by the lifetime of the deployment.
    await tx
      .delete(authThrottle)
      .where(lt(authThrottle.lastFailedAt, new Date(now.getTime() - THROTTLE_WINDOW_MS)));

    await tx
      .insert(authThrottle)
      .values({ kind, subject, failures: 0, firstFailedAt: now, lastFailedAt: now, retryAfter: null })
      .onConflictDoNothing();

    const locked = await tx.execute(
      sql`select failures, first_failed_at from ${authThrottle}
          where kind = ${kind} and subject = ${subject} for update`,
    );
    const row = (locked.rows[0] ?? {}) as { failures?: number; first_failed_at?: string | Date };
    const firstFailedAt = row.first_failed_at === undefined ? now : new Date(row.first_failed_at);
    const withinWindow = now.getTime() - firstFailedAt.getTime() <= THROTTLE_WINDOW_MS;

    const failures = withinWindow ? (row.failures ?? 0) + 1 : 1;
    const ms = backoffMs(failures);
    const retryAfter = ms === 0 ? null : new Date(now.getTime() + ms);

    await tx
      .update(authThrottle)
      .set({
        failures,
        firstFailedAt: withinWindow ? firstFailedAt : now,
        lastFailedAt: now,
        retryAfter,
      })
      .where(and(eq(authThrottle.kind, kind), eq(authThrottle.subject, subject)));

    return { failures, retryAfter };
  });
}

/**
 * A successful authentication clears the counter outright.
 *
 * DELETE rather than zero: the absence of a row IS "nothing owed", the table stays small without a
 * sweeper job, and there is no half-state for a later reader to interpret.
 */
export async function clearThrottle(db: Db, kind: ThrottleKind, username: string): Promise<void> {
  await db
    .delete(authThrottle)
    .where(and(eq(authThrottle.kind, kind), eq(authThrottle.subject, throttleSubject(username))));
}
