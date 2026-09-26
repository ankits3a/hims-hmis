import { and, eq, gte, isNotNull, ne } from "drizzle-orm";
import type { Request } from "express";
import type { Actor } from "@hmis/contracts";
import { authSessions } from "../db/schema";
import { sha256Hex } from "../crypto";
import { withTx } from "../db/client";
import { appendEvent } from "../events/append";
import {
  authBadgeSwitched, authLoggedOut, authLoginFailed, authLoginSucceeded, authPinSwitched,
  authSessionRevoked, authTotpConfirmed, authTotpEnrolled, authTotpFailed, authTotpVerified,
} from "./events";
import type { Db } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WASA M-05 — THE AUTHENTICATION AUDIT WRITERS, CALLED AT THE ROUTE LAYER
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `sessions.ts`, `identity.ts` and `totp.ts` are left exactly as they were: the verification and
 * session-creation paths answer "may this person in?" and nothing here changes that answer. What
 * these functions add happens AFTER that answer, in the controller (and in the step-up guard), and
 * each is one transaction — the session's client stamp and its event land together or not at all.
 *
 * The client stamp is written by token hash rather than threaded into `createSession`, so the
 * three session-creating paths (password, PIN, badge) did not have to change their signatures:
 * the route that received the token is the route that knows the client.
 */

export type ClientContext = { ip: string | null; userAgent: string | null };

const USERNAME_MAX = 128;
const USER_AGENT_MAX = 512;
const FAILURE_ACTOR: Actor = { type: "system", id: "auth" };

/** The client as the trusted hop reported it (`req.ip`), and its User-Agent — both bounded. */
export function clientContext(req: Request): ClientContext {
  const ip = typeof req.ip === "string" && req.ip !== "" ? req.ip.replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, "$1") : null;
  const ua = req.headers["user-agent"];
  return { ip, userAgent: typeof ua === "string" && ua !== "" ? ua.slice(0, USER_AGENT_MAX) : null };
}

type SessionMethod = "password" | "pin" | "badge";

/**
 * A session was just created for `token`. Stamps its client and appends the matching event; for
 * a terminal switch, also one `auth.session_revoked` per session the switch ended on that terminal
 * (read back as "revoked on this terminal since `switchStartedAt`", because `switchWithPin` and
 * `switchWithBadge` do not return what they revoked and are not changed here).
 */
export async function auditSessionOpened(
  db: Db,
  token: string,
  method: SessionMethod,
  client: ClientContext,
  switchStartedAt?: Date,
): Promise<void> {
  await withTx(db, async (tx) => {
    const stamped = await tx
      .update(authSessions)
      .set({ clientIp: client.ip, userAgent: client.userAgent })
      .where(eq(authSessions.tokenHash, sha256Hex(token)))
      .returning({ sessionId: authSessions.id, userId: authSessions.userId, terminalId: authSessions.terminalId });
    const session = stamped[0];
    if (session === undefined) throw new Error("auditSessionOpened: the session just created is not in auth_sessions");
    const actor: Actor = { type: "user", id: session.userId };

    if (method === "password") {
      await appendEvent(tx, authLoginSucceeded.make({
        actor,
        payload: { userId: session.userId, sessionId: session.sessionId, method, terminalId: session.terminalId, ...client },
      }));
      return;
    }

    const terminalId = session.terminalId ?? "";
    const revoked = switchStartedAt === undefined || session.terminalId === null ? [] : await tx
      .select({ sessionId: authSessions.id, userId: authSessions.userId })
      .from(authSessions)
      .where(and(
        eq(authSessions.terminalId, session.terminalId),
        isNotNull(authSessions.revokedAt),
        gte(authSessions.revokedAt, switchStartedAt),
        ne(authSessions.id, session.sessionId),
      ));
    const def = method === "pin" ? authPinSwitched : authBadgeSwitched;
    await appendEvent(tx, def.make({
      actor,
      payload: { userId: session.userId, sessionId: session.sessionId, terminalId, terminalSessionsRevoked: revoked.length, ...client },
    }));
    for (const r of revoked) {
      await appendEvent(tx, authSessionRevoked.make({
        actor,
        payload: { sessionId: r.sessionId, userId: r.userId, reason: "terminal_switch", terminalId: session.terminalId },
      }));
    }
  });
}

/**
 * A credential was refused. NO password, PIN or badge token reaches this function, and nothing it
 * writes says whether `username` belongs to anybody — the row is the same shape either way.
 */
export async function auditLoginFailed(
  db: Db,
  method: SessionMethod,
  submitted: { username?: string; terminalId?: string },
  client: ClientContext,
): Promise<void> {
  await withTx(db, async (tx) => {
    await appendEvent(tx, authLoginFailed.make({
      actor: FAILURE_ACTOR,
      payload: {
        method,
        username: submitted.username === undefined ? null : submitted.username.slice(0, USERNAME_MAX),
        terminalId: submitted.terminalId === undefined ? null : submitted.terminalId.slice(0, USERNAME_MAX),
        ...client,
      },
    }));
  });
}

/** The holder ended their own session. Revocation and event are one transaction. */
export async function auditLoggedOut(
  db: Db,
  session: { sessionId: string; userId: string },
  client: ClientContext,
  revoke: (tx: Db) => Promise<void>,
): Promise<void> {
  await withTx(db, async (tx) => {
    await revoke(tx);
    await appendEvent(tx, authLoggedOut.make({
      actor: { type: "user", id: session.userId },
      payload: { userId: session.userId, sessionId: session.sessionId, ...client },
    }));
  });
}

export type TotpOutcome =
  | { kind: "enrolled" }
  | { kind: "confirmed" }
  | { kind: "verified"; via: "verify_route" | "step_up_header" }
  | { kind: "failed"; stage: "confirm" | "verify_route" | "step_up_header" };

/** One TOTP act. Never the code, never the secret. */
export async function auditTotp(
  db: Db,
  who: { userId: string; sessionId: string | null },
  outcome: TotpOutcome,
  client: ClientContext,
): Promise<void> {
  const actor: Actor = { type: "user", id: who.userId };
  const base = { userId: who.userId, sessionId: who.sessionId, ...client };
  await withTx(db, async (tx) => {
    switch (outcome.kind) {
      case "enrolled":
        await appendEvent(tx, authTotpEnrolled.make({ actor, payload: base }));
        return;
      case "confirmed":
        await appendEvent(tx, authTotpConfirmed.make({ actor, payload: base }));
        return;
      case "verified":
        if (who.sessionId === null) throw new Error("auditTotp: a verified second factor always belongs to a session");
        await appendEvent(tx, authTotpVerified.make({ actor, payload: { ...base, sessionId: who.sessionId, via: outcome.via } }));
        return;
      case "failed":
        await appendEvent(tx, authTotpFailed.make({ actor, payload: { ...base, stage: outcome.stage } }));
        return;
    }
  });
}
