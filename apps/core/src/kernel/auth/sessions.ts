import { and, eq, gt, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { authSessions, users } from "../db/schema";
import { randomToken, sha256Hex } from "../crypto";
import { verifyPassword, verifyPin, resolveBadge } from "./identity";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

export type LiveSession = {
  sessionId: string;
  userId: string;
  terminalId: string | null;
  secondFactorAt: Date | null;
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

export async function findLiveSession(db: Db, token: string): Promise<LiveSession | null> {
  const rows = await db
    .select({
      sessionId: authSessions.id,
      userId: authSessions.userId,
      terminalId: authSessions.terminalId,
      secondFactorAt: authSessions.secondFactorAt,
    })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.tokenHash, sha256Hex(token)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, new Date()),
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

export async function revokeTerminalSessions(db: Db, terminalId: string): Promise<number> {
  const rows = await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessions.terminalId, terminalId), isNull(authSessions.revokedAt)))
    .returning({ id: authSessions.id });
  return rows.length;
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

export async function switchWithPin(
  db: Db,
  cfg: AppConfig,
  input: { username: string; pin: string; terminalId: string },
): Promise<{ token: string } | null> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.username, input.username));
  const user = rows[0];
  if (!user) return null;
  const ok = await verifyPin(db, user.id, input.pin);
  if (!ok) return null;
  await revokeTerminalSessions(db, input.terminalId);
  const { token } = await createSession(db, cfg, user.id, input.terminalId);
  return { token };
}

export async function switchWithBadge(
  db: Db,
  cfg: AppConfig,
  input: { badgeToken: string; terminalId: string },
): Promise<{ token: string } | null> {
  const resolved = await resolveBadge(db, cfg, input.badgeToken);
  if (!resolved) return null;
  await revokeTerminalSessions(db, input.terminalId);
  const { token } = await createSession(db, cfg, resolved.userId, input.terminalId);
  return { token };
}
