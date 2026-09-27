import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { authSessions, users } from "../db/schema";
import { randomToken, sha256Hex } from "../crypto";
import { verifyPassword, verifyPinByUsername, resolveBadge } from "./identity";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

export type LiveSession = {
  sessionId: string;
  userId: string;
  terminalId: string | null;
  secondFactorAt: Date | null;
  /**
   * PLAN 11e D1 — carried as DATA, not enforced here. `findLiveSession` refuses an INACTIVE user's
   * session outright (below); it does not refuse a must-change one, because the person holding it
   * has exactly two things left to do — change the password, or log out — and both need the
   * session to still resolve. The refusal is `AuthGuard`'s, which knows the route (`guards.ts`).
   */
  mustChangePassword: boolean;
};

export async function createSession(
  db: Db,
  cfg: AppConfig,
  userId: string,
  terminalId?: string,
): Promise<{ token: string; sessionId: string }> {
  const token = randomToken();
  const sessionId = newId();
  const expiresAt = new Date(Date.now() + cfg.sessionTtlMinutes * 60_000);
  await db.insert(authSessions).values({
    id: sessionId,
    tokenHash: sha256Hex(token),
    userId,
    terminalId: terminalId ?? null,
    expiresAt,
  });
  return { token, sessionId };
}

/**
 * THE ONE PLACE A TOKEN BECOMES AN IDENTITY — two non-test callers, and both of them inherit
 * everything decided here: `guards.ts`'s `AuthGuard` (an `APP_GUARD`, so EVERY authenticated HTTP
 * route) and `realtime/gateway.ts`'s WebSocket auth.
 *
 * PLAN 11e D1 — IT NOW JOINS `users`, FOR TWO FACTS AND ONE QUERY.
 *
 *   `active`  — an inactive user's session RESOLVES TO NULL right here, so a caller cannot forget
 *               a check that never reaches it. Before 11e, `active` was read only by the three
 *               session-CREATION paths (`verifyPassword`, `verifyPin`, `resolveBadge`), and
 *               `hasPermission` never reads `users` at all: a deactivated user holding a valid
 *               token kept full authority for the rest of `SESSION_TTL_MINUTES` — up to twelve
 *               hours — on HTTP and on the socket alike. That was measured, not supposed
 *               (plan 11e §3 Q5), and `test/credential-lifecycle.e2e.test.ts` R1 executes it.
 *
 *   `mustChangePassword` — returned as data for `AuthGuard` to act on; see the type above.
 *
 * ONE QUERY STILL. The join adds no round-trip to a request path that runs on every single call,
 * and `users.id` is the primary key `auth_sessions.user_id` already references.
 */
export async function findLiveSession(db: Db, token: string): Promise<LiveSession | null> {
  const rows = await db
    .select({
      sessionId: authSessions.id,
      userId: authSessions.userId,
      terminalId: authSessions.terminalId,
      secondFactorAt: authSessions.secondFactorAt,
      mustChangePassword: users.mustChangePassword,
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(
      and(
        eq(authSessions.tokenHash, sha256Hex(token)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, new Date()),
        eq(users.active, true),
      ),
    );
  return rows[0] ?? null;
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)));
}

export async function revokeUserSessions(db: Db, userId: string): Promise<number> {
  const rows = await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
    .returning({ id: authSessions.id });
  return rows.length;
}

/**
 * PLAN 11e T2 — "every session of this user EXCEPT the one asking", for `POST /auth/change-password`.
 *
 * A password change is what somebody does when they believe a credential leaked, so every other
 * terminal that credential is signed in on must die — and the one in front of them must not, or
 * the act of fixing the account would throw them out of it. It sits beside the other two revokes
 * rather than inside the controller because this is the family that knows how a session ends;
 * a controller reaching into `auth_sessions` directly would be the third place that knowledge
 * lives.
 */
export async function revokeOtherUserSessions(
  db: Db,
  userId: string,
  keepSessionId: string,
): Promise<number> {
  const rows = await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(authSessions.userId, userId),
        ne(authSessions.id, keepSessionId),
        isNull(authSessions.revokedAt),
      ),
    )
    .returning({ id: authSessions.id });
  return rows.length;
}

/**
 * ═══ WASA L-07 — THE OUTGOING SESSION IS THE ONE PRESENTED, NEVER THE ONE NAMED ═══
 *
 * The fast switch used to call `revokeTerminalSessions(body.terminalId)`: every live session whose
 * `terminal_id` matched a string the caller chose. `terminal_id` is a LABEL the client supplies at
 * login and at every switch — nothing issues or verifies it — so any PIN or badge holder could name
 * another desk's terminal and sign whoever was on it out, mid-shift. A label cannot carry authority.
 *
 * The switch now ends exactly the session whose bearer token the caller presents. Holding that
 * token is the proof of being at that device (the browser on the shared terminal has it), and it
 * grants nothing new: the holder could already end it with `POST /auth/logout`. The match is by
 * token hash and ignores liveness, so an already-expired or deactivated occupant's row is closed
 * too rather than left un-revoked for a reactivation to resurrect.
 *
 * NARROWER THAN BEFORE, BY DESIGN: another session that merely shares the label is left alone. On a
 * shared terminal one browser holds one token, so the chain of switches revokes each occupant in
 * turn; a second browser profile on the same desk is a different device as far as proof goes.
 * Server-issued, network-bound terminal ids (WASA's longer recommendation, with H-02) would let a
 * terminal-wide revoke come back safely; until then there is none.
 *
 * Returns the revoked session's terminal label, so the incoming session inherits the DEVICE's label
 * rather than whatever the body asserted; `undefined` when nothing was presented or it matched no
 * open session.
 */
async function revokePresentedSession(db: Db, token: string | undefined): Promise<string | null | undefined> {
  if (token === undefined || token === "") return undefined;
  const rows = await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessions.tokenHash, sha256Hex(token)), isNull(authSessions.revokedAt)))
    .returning({ terminalId: authSessions.terminalId });
  return rows.length === 0 ? undefined : rows[0]!.terminalId;
}

/**
 * The terminal a new switched-in session is recorded against: the outgoing session's label when it
 * had one, else the body's. It is a LABEL for the audit trail and the UI only — no code path reads
 * it for authority any more.
 */
function incomingTerminal(outgoing: string | null | undefined, asserted: string): string {
  return outgoing ?? asserted;
}

export async function loginWithPassword(
  db: Db,
  cfg: AppConfig,
  input: { username: string; password: string; terminalId?: string },
): Promise<{ token: string } | null> {
  const verified = await verifyPassword(db, input.username, input.password);
  if (!verified) return null;
  const { token } = await createSession(db, cfg, verified.userId, input.terminalId);
  return { token };
}

/**
 * `outgoingToken` is the bearer token of the session this device currently holds, if any (the
 * controller reads it from the `Authorization` header of the otherwise-public route). A cold
 * terminal presents none and revokes nothing. Nothing is revoked unless the credential verified.
 */
export async function switchWithPin(
  db: Db,
  cfg: AppConfig,
  input: { username: string; pin: string; terminalId: string; outgoingToken?: string },
): Promise<{ token: string } | null> {
  const verified = await verifyPinByUsername(db, input.username, input.pin);
  if (!verified) return null;
  const outgoing = await revokePresentedSession(db, input.outgoingToken);
  const { token } = await createSession(db, cfg, verified.userId, incomingTerminal(outgoing, input.terminalId));
  return { token };
}

export async function switchWithBadge(
  db: Db,
  cfg: AppConfig,
  input: { badgeToken: string; terminalId: string; outgoingToken?: string },
): Promise<{ token: string } | null> {
  const resolved = await resolveBadge(db, cfg, input.badgeToken);
  if (!resolved) return null;
  const outgoing = await revokePresentedSession(db, input.outgoingToken);
  const { token } = await createSession(db, cfg, resolved.userId, incomingTerminal(outgoing, input.terminalId));
  return { token };
}
