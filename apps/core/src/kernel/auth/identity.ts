import argon2 from "argon2";
import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { users } from "../db/schema";
import { makeBadgeToken, parseBadgeToken, randomToken } from "../crypto";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

// OWASP-baseline argon2id. PIN verification rides the same params and must stay
// inside the <2 s fast-switch budget (perf-tested in Task 7).
const ARGON2_PROD: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * ═══ THE TEST COST, AND WHY IT CANNOT REACH A REAL PASSWORD ═══
 *
 * MEASURED: one OWASP-baseline hash costs ~36 ms, and the fixtures mint EIGHT users per
 * `beforeEach` — ~290 ms of every test in the repository, paid roughly 3,000 times in a full core
 * run. `createUser` has ONE production caller (`users-admin.controller.ts`) and ~150 test callers
 * across ~70 files, so this is overwhelmingly a fixture cost.
 *
 * **TWO independent conditions, both required, because either one alone is a foot-gun.**
 * `NODE_ENV` alone would weaken any process someone starts with the wrong value — and a stray
 * `NODE_ENV=test` is a plausible deployment slip. An opt-in variable alone would be a switch named
 * "make the password hashing weak" that anything could set. Requiring BOTH means a real deployment
 * has to get two unrelated things wrong in the same breath, and `argon2-cost.test.ts` asserts each
 * one alone is inert.
 *
 * The precedent is `test/helpers/env.ts`, which already supplies a test-only `SECRET_KEY` the same
 * way: the HARNESS opts in, rather than the production code guessing where it is running.
 *
 * **This changes nothing about verification, now or retrospectively.** An argon2 encoded hash
 * carries its own `m`, `t` and `p`, so `argon2.verify` reads the parameters out of the stored
 * string. Every password hashed at production cost keeps verifying at production cost, and no
 * existing hash is touched or needs rehashing.
 */
/**
 * BOTH NUMBERS ARE ARGON2'S OWN FLOORS, not values chosen for taste. The library refuses anything
 * lower — `Invalid memoryCost, must be between 1024 and 4294967295` and `Invalid timeCost, must be
 * between 2 and 4294967295` — and both were found by trying to go under them, not by reading docs.
 * So `timeCost` is UNCHANGED from production and the only lever is memory: 19456 KiB -> 1024, the
 * cheapest hash argon2 will consent to produce.
 */
const ARGON2_TEST: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 1024,
  timeCost: 2,
  parallelism: 1,
};

export function argon2Options(env: NodeJS.ProcessEnv = process.env): argon2.Options {
  return env["NODE_ENV"] === "test" && env["ARGON2_TEST_COST"] === "1" ? ARGON2_TEST : ARGON2_PROD;
}

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
/**
 * ═══ THE STAFF ID, MINTED SO NO EMPLOYEE IS WITHOUT ONE ═══
 *
 * `EMP-` + four digits. MAX over the minted shape, never COUNT: a user is DEACTIVATED rather than
 * deleted (`users.active`), so a departed employee keeps their number and the next hire gets a
 * fresh one — an ID card, an attendance row or a signed form carrying a reissued number names the
 * wrong person. It reads only `EMP-nnnn`, so a hospital's own HR numbering sitting in the same
 * column does not derail the sequence.
 *
 * Same shape as `nextDoctorCode`, deliberately, and not shared with it: that one lives in the OPD
 * module and this one in the kernel, and a kernel that imported a module to number its own rows
 * would be the wrong dependency for the sake of eight lines.
 */
export async function nextStaffCode(db: Db): Promise<string> {
  const rows = await db
    .select({ highest: sql<number | null>`max(nullif(regexp_replace(${users.staffCode}, '^EMP-0*', ''), '')::int)` })
    .from(users)
    .where(sql`${users.staffCode} ~ '^EMP-[0-9]+$'`);
  const next = (rows[0]?.highest ?? 0) + 1;
  if (next > 9999) throw new Error("the 4-digit EMP- sequence is full; assign staff ids explicitly");
  return `EMP-${String(next).padStart(4, "0")}`;
}

export async function createUser(
  db: Db,
  input: {
    username: string; fullName: string; password: string; pin?: string; mustChangePassword?: boolean;
    /** A hospital's own HR number. Omitted is the normal path — one is minted. */
    staffCode?: string;
  },
): Promise<{ id: string }> {
  const id = newId();
  const staffCode = input.staffCode === undefined ? await nextStaffCode(db) : input.staffCode.trim();
  if (staffCode === "") throw new Error("a staff id cannot be blank");
  const passwordHash = await argon2.hash(input.password, argon2Options());
  const pinHash = input.pin === undefined ? null : await argon2.hash(input.pin, argon2Options());
  await db.insert(users).values({
    id,
    username: input.username,
    fullName: input.fullName,
    staffCode,
    passwordHash,
    pinHash,
    mustChangePassword: input.mustChangePassword ?? false,
  });
  return { id };
}

/**
 * ═══ WASA L-02 — EVERY MISS PAYS ONE ARGON2 VERIFY ═══
 *
 * An unknown or inactive username used to return BEFORE argon2 ran, so it answered one verify
 * (~36 ms at the production cost above) sooner than a wrong password for a live account. The 401
 * body was identical; the clock was not, and that is a username-existence oracle on a public route.
 * Every credential miss now verifies the candidate against this dummy hash instead, so both paths
 * do the same work and still answer the same `null`.
 *
 * The dummy is minted LAZILY with `argon2Options()` rather than embedded as a literal, so its cost
 * is whatever real hashes cost in this process: production cost in production, and the harness's
 * cheap cost under test (where a production-cost dummy would make every unknown-user test ~36 ms
 * slower than the known-user one it is compared with). The very first miss in a process pays one
 * extra hash; that is a single, un-repeatable sample and not an oracle. Its plaintext is random and
 * never leaves this closure, so nothing can ever verify against it.
 */
let dummyHash: Promise<string> | undefined;
async function burnOneVerify(candidate: string): Promise<void> {
  dummyHash ??= argon2.hash(randomToken(), argon2Options()).catch((e: unknown) => {
    dummyHash = undefined; // a failed mint must not be cached for the life of the process
    throw e;
  });
  await argon2.verify(await dummyHash, candidate);
}

export async function verifyPassword(
  db: Db,
  username: string,
  password: string,
): Promise<{ userId: string } | null> {
  const rows = await db.select().from(users).where(eq(users.username, username));
  const user = rows[0];
  if (!user || !user.active) {
    await burnOneVerify(password);
    return null;
  }
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
  const passwordHash = await argon2.hash(password, argon2Options());
  await db
    .update(users)
    .set({ passwordHash, mustChangePassword: opts.mustChangePassword, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function setPin(db: Db, userId: string, pin: string): Promise<void> {
  const pinHash = await argon2.hash(pin, argon2Options());
  await db.update(users).set({ pinHash, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function verifyPin(db: Db, userId: string, pin: string): Promise<boolean> {
  const rows = await db.select().from(users).where(eq(users.id, userId));
  const user = rows[0];
  if (!user || !user.active || user.pinHash === null) {
    await burnOneVerify(pin); // WASA L-02, the PIN half — see `burnOneVerify`
    return false;
  }
  return argon2.verify(user.pinHash, pin);
}

/**
 * The PIN switch's lookup, by the SUBMITTED username. It lives here rather than in `sessions.ts` so
 * the unknown-username branch pays the same verify as every other miss (WASA L-02) — the switch
 * used to return before any argon2 for a name that did not exist.
 */
export async function verifyPinByUsername(
  db: Db,
  username: string,
  pin: string,
): Promise<{ userId: string } | null> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
  const user = rows[0];
  if (!user) {
    await burnOneVerify(pin);
    return null;
  }
  return (await verifyPin(db, user.id, pin)) ? { userId: user.id } : null;
}

export async function rotateBadge(
  db: Db,
  cfg: AppConfig,
  userId: string,
): Promise<{ badgeToken: string; badgeVersion: number }> {
  const now = new Date();
  const rows = await db
    .update(users)
    .set({ badgeVersion: sql<number>`${users.badgeVersion} + 1`, badgeIssuedAt: now, updatedAt: now })
    .where(eq(users.id, userId))
    .returning({ badgeVersion: users.badgeVersion });
  const badgeVersion = rows[0]!.badgeVersion;
  return { badgeToken: makeBadgeToken(cfg.secretKey, userId, badgeVersion), badgeVersion };
}

/**
 * ═══ WASA L-06 — A BADGE HAS A MAXIMUM AGE ═══
 *
 * A badge token is `b1.userId.version.HMAC` and, until this, lived until somebody rotated it: a
 * photographed or copied badge was a login for ever. It now also dies `BADGE_MAX_AGE_DAYS` (default
 * 365) after the rotation that issued its version.
 *
 * THE ISSUE INSTANT IS SERVER-SIDE (`users.badge_issued_at`), NOT A NEW FIELD IN THE TOKEN, for three
 * reasons: badges already printed keep their format and keep working; a SHORTENED max age applies
 * to badges already in pockets, which a timestamp baked into the token could never do; and the
 * version bump that already revokes is the same write that restarts the clock, so the two can never
 * disagree.
 *
 * THE MIGRATION PATH. The column arrives `NOT NULL DEFAULT now()`, so every row that existed when it
 * was added carries the migration's instant. A badge printed before this change therefore keeps
 * working for exactly one max age from the deploy, then is refused and must be re-issued with
 * `rotateBadge` (which today has no production caller: no route or script prints badges, so the
 * measured expectation is that there are none to re-issue).
 */
export async function resolveBadge(
  db: Db,
  cfg: AppConfig,
  badgeToken: string,
  now: Date = new Date(),
): Promise<{ userId: string } | null> {
  const parsed = parseBadgeToken(cfg.secretKey, badgeToken);
  if (!parsed) return null;
  const rows = await db.select().from(users).where(eq(users.id, parsed.userId));
  const user = rows[0];
  if (!user || !user.active || user.badgeVersion !== parsed.badgeVersion) return null;
  if (now.getTime() - user.badgeIssuedAt.getTime() > cfg.badgeMaxAgeDays * 86_400_000) return null;
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
