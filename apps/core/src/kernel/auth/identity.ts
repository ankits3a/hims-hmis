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

/**
 * PLAN 11e: `mustChangePassword` is OPTIONAL and defaults to FALSE, deliberately.
 *
 * The admin-create route passes `true` (D2 — every provisioned human proves control of their own
 * credential at first login). It is not defaulted true HERE because this function is also how the
 * seeds and every test fixture in the repository mint users, and a default of true would make
 * "created" and "locked out of everything but one route" the same act for all of them.
 *
 * THIS FUNCTION ENFORCES NO PASSWORD POLICY, and that is also deliberate: the policy is applied at
 * the paths where a HUMAN chooses a credential (`password-policy.ts`, D3 — the two admin routes,
 * self-service change-password, and `seed:staff`'s roster). A floor buried in the kernel's user
 * constructor would be a floor that fixtures route around, which is the shape of a rule nobody
 * can measure.
 */
export async function createUser(
  db: Db,
  input: {
    username: string; fullName: string; password: string; pin?: string; mustChangePassword?: boolean;
  },
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
    mustChangePassword: input.mustChangePassword ?? false,
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

/**
 * PLAN 11e Q3 — THE `setPin` MIRROR THAT DID NOT EXIST. Until 11e, `createUser` was the only place
 * in the entire tree that ever wrote a password hash, which is why the hospital had no
 * credential-reset flow at all and `seed:staff` REFUSES a changed password rather than performing
 * one.
 *
 * `mustChangePassword` is a REQUIRED argument, never a default. The two callers want opposite
 * values — an admin reset sets it (the human whose password this now is has not chosen it yet),
 * and self-service change-password clears it (they just did) — and a default would silently make
 * one of those two wrong.
 *
 * IT REVOKES NOTHING. Session revocation is the CALLER's act, because the two callers differ there
 * too: an admin reset kills every session the target holds, and a self-service change kills every
 * session EXCEPT the one doing the changing. A revoke buried here could not tell them apart.
 */
export async function setPassword(
  db: Db,
  userId: string,
  password: string,
  opts: { mustChangePassword: boolean },
): Promise<void> {
  const passwordHash = await argon2.hash(password, ARGON2_OPTS);
  await db
    .update(users)
    .set({ passwordHash, mustChangePassword: opts.mustChangePassword, updatedAt: new Date() })
    .where(eq(users.id, userId));
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

/**
 * PLAN 11e D2 — the reverse of `deactivateUser`, and it reverses ONLY that.
 *
 * It does not restore sessions: `deactivateUser`'s caller revoked them (the deactivate route does
 * both in one flow), and a reactivated person logs in fresh. There is nothing to un-revoke and
 * nothing that should be un-revoked — the account was off, and "off" is not a state a token
 * should survive.
 */
export async function reactivateUser(db: Db, userId: string): Promise<void> {
  await db.update(users).set({ active: true, updatedAt: new Date() }).where(eq(users.id, userId));
}
