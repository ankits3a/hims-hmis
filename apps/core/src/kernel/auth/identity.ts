import argon2 from "argon2";
import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { users } from "../db/schema";
import { makeBadgeToken, parseBadgeToken } from "../crypto";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

// OWASP-baseline argon2id. PIN verification rides the same params and must stay
// inside the <2 s fast-switch budget (perf-tested in Task 7).
const ARGON2_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export async function createUser(
  db: Db,
  input: { username: string; fullName: string; password: string; pin?: string },
): Promise<{ id: string }> {
  const id = newId();
  const passwordHash = await argon2.hash(input.password, ARGON2_OPTS);
  const pinHash = input.pin === undefined ? null : await argon2.hash(input.pin, ARGON2_OPTS);
  await db.insert(users).values({
    id,
    username: input.username,
    fullName: input.fullName,
    passwordHash,
    pinHash,
  });
  return { id };
}

export async function verifyPassword(
  db: Db,
  username: string,
  password: string,
): Promise<{ userId: string } | null> {
  const rows = await db.select().from(users).where(eq(users.username, username));
  const user = rows[0];
  if (!user || !user.active) return null;
  const ok = await argon2.verify(user.passwordHash, password);
  return ok ? { userId: user.id } : null;
}

export async function setPin(db: Db, userId: string, pin: string): Promise<void> {
  const pinHash = await argon2.hash(pin, ARGON2_OPTS);
  await db.update(users).set({ pinHash, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function verifyPin(db: Db, userId: string, pin: string): Promise<boolean> {
  const rows = await db.select().from(users).where(eq(users.id, userId));
  const user = rows[0];
  if (!user || !user.active || user.pinHash === null) return false;
  return argon2.verify(user.pinHash, pin);
}

export async function rotateBadge(
  db: Db,
  cfg: AppConfig,
  userId: string,
): Promise<{ badgeToken: string; badgeVersion: number }> {
  const rows = await db
    .update(users)
    .set({ badgeVersion: sql<number>`${users.badgeVersion} + 1`, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ badgeVersion: users.badgeVersion });
  const badgeVersion = rows[0]!.badgeVersion;
  return { badgeToken: makeBadgeToken(cfg.secretKey, userId, badgeVersion), badgeVersion };
}

export async function resolveBadge(
  db: Db,
  cfg: AppConfig,
  badgeToken: string,
): Promise<{ userId: string } | null> {
  const parsed = parseBadgeToken(cfg.secretKey, badgeToken);
  if (!parsed) return null;
  const rows = await db.select().from(users).where(eq(users.id, parsed.userId));
  const user = rows[0];
  if (!user || !user.active || user.badgeVersion !== parsed.badgeVersion) return null;
  return { userId: user.id };
}

export async function deactivateUser(db: Db, userId: string): Promise<void> {
  await db.update(users).set({ active: false, updatedAt: new Date() }).where(eq(users.id, userId));
}
