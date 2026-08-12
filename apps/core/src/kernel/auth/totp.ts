import { authenticator } from "otplib";
import { eq } from "drizzle-orm";
import { authSessions, userTotp } from "../db/schema";
import { openSecret, sealSecret } from "../crypto";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

// Accept the adjacent time-step: tolerates real-world clock skew on ward devices and
// removes the 30-second-window-boundary flake from every TOTP test.
authenticator.options = { window: 1 };

export async function enrollTotp(
  db: Db,
  cfg: AppConfig,
  userId: string,
): Promise<{ otpauthUrl: string; secret: string }> {
  const secret = authenticator.generateSecret();
  const secretSealed = sealSecret(cfg.secretKey, secret);
  await db
    .insert(userTotp)
    .values({ userId, secretSealed, enabledAt: null })
    .onConflictDoUpdate({ target: userTotp.userId, set: { secretSealed, enabledAt: null } });
  return { otpauthUrl: authenticator.keyuri(userId, "HMIS", secret), secret };
}

export async function confirmTotp(db: Db, cfg: AppConfig, userId: string, code: string): Promise<boolean> {
  const rows = await db.select().from(userTotp).where(eq(userTotp.userId, userId));
  const row = rows[0];
  if (!row) return false;
  const ok = authenticator.check(code, openSecret(cfg.secretKey, row.secretSealed));
  if (ok && row.enabledAt === null) {
    await db.update(userTotp).set({ enabledAt: new Date() }).where(eq(userTotp.userId, userId));
  }
  return ok;
}

export async function verifyTotpCode(db: Db, cfg: AppConfig, userId: string, code: string): Promise<boolean> {
  const rows = await db.select().from(userTotp).where(eq(userTotp.userId, userId));
  const row = rows[0];
  if (!row || row.enabledAt === null) return false;
  return authenticator.check(code, openSecret(cfg.secretKey, row.secretSealed));
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
