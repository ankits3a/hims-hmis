import { authenticator } from "otplib";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { authSessions, userTotp, users } from "../db/schema";
import { openSecret, sealSecret } from "../crypto";
import { verifyPassword } from "./identity";
import { clearThrottle, recordThrottleFailure, throttleRetryAt } from "./throttle";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

// Accept the adjacent time-step: tolerates real-world clock skew on ward devices and
// removes the 30-second-window-boundary flake from every TOTP test.
authenticator.options = { window: 1 };

/**
 * ═══ WASA M-02 — THE TOTP LIFECYCLE, AND THE THREE HOLES IT HAD ═══
 *
 * 1. **A session was enough to replace the factor.** `POST /auth/totp/enroll` overwrote the secret
 *    and cleared `enabled_at` for anyone holding the bearer token, so a stolen token could swap the
 *    victim's authenticator for its own and confirm it. Enrolment now needs PROOF (ASVS V3.7.1, and
 *    2.5.x's "re-authenticate before changing an authenticator"): the CURRENT code while a factor
 *    is enabled, the account PASSWORD while none is. The password does not substitute for the
 *    code once a factor exists — that would make the second factor exactly as strong as the first.
 *    A lost device therefore needs an administrator's reset, which does not exist yet and belongs
 *    with H-03's roll-out, not here.
 *
 * 2. **A code could be spent twice** inside its ±1-step window (ASVS 2.8.4, RFC 6238 §5.2).
 *    `user_totp.last_used_step` records the time-step of the last ACCEPTED code, and a code is
 *    accepted only for a strictly LATER step — claimed by one conditional UPDATE, so two requests
 *    racing with the same code cannot both win. Re-enrolment resets it: the marker is a fact about
 *    a secret, and a fresh secret has never produced an accepted code.
 *
 * 3. **Nothing throttled verification.** Every code check — confirm, verify, the step-up
 *    `X-Totp-Code` header, and the re-enrol proof — now goes through `throttle.ts` under ONE `totp`
 *    counter keyed by the user id, so no door is a way round another. A refusal while throttled
 *    costs no secret decryption and consumes no step. Five misses per window, then the same
 *    doubling backoff login uses; against three live codes in 10^6 that is ~0.14% a day.
 *
 * TOTP IS STILL NOT MANDATORY ANYWHERE NEW. Where it is required is `secondFactor: true` on a
 * route (`guards.ts`); rolling it out further is H-03, an owner decision.
 */

export type TotpRefusal =
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "throttled"; retryAt: Date };
export type TotpCheck = { ok: true } | TotpRefusal;

/** What the caller offers as proof when (re-)enrolling. Which one is needed depends on the row. */
export type TotpEnrolProof = { currentCode?: string; password?: string };
export type TotpEnrolResult =
  | { ok: true; otpauthUrl: string; secret: string }
  | { ok: false; reason: "password_required" | "current_code_required" }
  | TotpRefusal;

/**
 * The RFC 6238 time-step `code` belongs to for `secret` at `now`, or null when it matches no step
 * in the window. The step length is read from otplib's own options (30 s by default), so the
 * replay marker can never count in a different unit from the check that produced it.
 */
function matchedStep(code: string, secret: string, now: Date): number | null {
  const at = authenticator.clone({ epoch: now.getTime() });
  const delta = at.checkDelta(code, secret);
  if (delta === null) return null;
  return Math.floor(now.getTime() / 1000 / at.allOptions().step) + delta;
}

/**
 * THE ONE PLACE A TOTP CODE IS JUDGED. Throttle first (no decryption for a refused attempt), then
 * the code, then the atomic single-use claim; a miss of either kind is one failure on the counter.
 *
 * `requireEnabled` separates the two callers' rows: verification judges only an ENABLED factor,
 * while confirmation judges the pending one (and, harmlessly, an already-enabled one, which it
 * leaves enabled). `enable` stamps `enabled_at` in the same UPDATE that claims the step.
 */
async function acceptCode(
  db: Db,
  cfg: AppConfig,
  userId: string,
  code: string,
  opts: { requireEnabled: boolean; enable: boolean; now: Date },
): Promise<TotpCheck> {
  const { now } = opts;
  const retryAt = await throttleRetryAt(db, "totp", userId, now);
  if (retryAt !== null) return { ok: false, reason: "throttled", retryAt };

  const row = (await db.select().from(userTotp).where(eq(userTotp.userId, userId)))[0];
  const eligible = row !== undefined && (!opts.requireEnabled || row.enabledAt !== null);
  const step = eligible ? matchedStep(code, openSecret(cfg.secretKey, row.secretSealed), now) : null;

  const claimed = step === null ? [] : await db
    .update(userTotp)
    .set({
      lastUsedStep: step,
      ...(opts.enable && row!.enabledAt === null ? { enabledAt: now } : {}),
    })
    .where(
      and(
        eq(userTotp.userId, userId),
        // Bound to the secret that was read, so a re-enrolment racing this check cannot let an
        // old secret's code confirm the new one.
        eq(userTotp.secretSealed, row!.secretSealed),
        or(isNull(userTotp.lastUsedStep), lt(userTotp.lastUsedStep, step)),
      ),
    )
    .returning({ userId: userTotp.userId });

  if (claimed.length === 0) {
    await recordThrottleFailure(db, "totp", userId, now);
    return { ok: false, reason: "invalid" };
  }
  await clearThrottle(db, "totp", userId);
  return { ok: true };
}

/**
 * Start (or restart) enrolment. Writes a NEW pending secret only after the proof holds:
 *   - a factor is ENABLED → `currentCode` must be a valid, unspent code of it (the password is
 *     refused as a substitute: `current_code_required`);
 *   - none is enabled (no row, or a pending one) → `password` must be the account's password. That
 *     check rides the `login` throttle counter, so this route is not a way round login's backoff.
 *
 * On success the row is pending (`enabled_at` null) until `confirmTotp`: a re-enrolment proven by
 * the current code therefore retires the old factor at once, which is what that proof authorised.
 */
export async function enrollTotp(
  db: Db,
  cfg: AppConfig,
  userId: string,
  proof: TotpEnrolProof,
  now: Date = new Date(),
): Promise<TotpEnrolResult> {
  const existing = (await db.select().from(userTotp).where(eq(userTotp.userId, userId)))[0];
  if (existing !== undefined && existing.enabledAt !== null) {
    if (proof.currentCode === undefined) return { ok: false, reason: "current_code_required" };
    const check = await acceptCode(db, cfg, userId, proof.currentCode, { requireEnabled: true, enable: false, now });
    if (!check.ok) return check;
  } else {
    if (proof.password === undefined) return { ok: false, reason: "password_required" };
    const username = (await db.select({ username: users.username }).from(users).where(eq(users.id, userId)))[0]?.username;
    if (username === undefined) return { ok: false, reason: "invalid" };
    const retryAt = await throttleRetryAt(db, "login", username, now);
    if (retryAt !== null) return { ok: false, reason: "throttled", retryAt };
    const verified = await verifyPassword(db, username, proof.password);
    if (verified?.userId !== userId) {
      await recordThrottleFailure(db, "login", username, now);
      return { ok: false, reason: "invalid" };
    }
    await clearThrottle(db, "login", username);
  }

  const secret = authenticator.generateSecret();
  const secretSealed = sealSecret(cfg.secretKey, secret);
  await db
    .insert(userTotp)
    .values({ userId, secretSealed, enabledAt: null, lastUsedStep: null })
    .onConflictDoUpdate({ target: userTotp.userId, set: { secretSealed, enabledAt: null, lastUsedStep: null } });
  return { ok: true, otpauthUrl: authenticator.keyuri(userId, "HMIS", secret), secret };
}

/** Confirm a pending enrolment with its first code. The code is spent like any other. */
export async function confirmTotp(
  db: Db,
  cfg: AppConfig,
  userId: string,
  code: string,
  now: Date = new Date(),
): Promise<TotpCheck> {
  return acceptCode(db, cfg, userId, code, { requireEnabled: false, enable: true, now });
}

/** Verify a code against the user's ENABLED factor: throttled, single-use. */
export async function verifyTotpCode(
  db: Db,
  cfg: AppConfig,
  userId: string,
  code: string,
  now: Date = new Date(),
): Promise<TotpCheck> {
  return acceptCode(db, cfg, userId, code, { requireEnabled: true, enable: false, now });
}

export async function recordSecondFactor(db: Db, sessionId: string): Promise<void> {
  await db.update(authSessions).set({ secondFactorAt: new Date() }).where(eq(authSessions.id, sessionId));
}

export function secondFactorFresh(
  session: { secondFactorAt: Date | null },
  windowMinutes: number,
  now: Date = new Date(),
): boolean {
  return (
    session.secondFactorAt !== null &&
    now.getTime() - session.secondFactorAt.getTime() <= windowMinutes * 60_000
  );
}
