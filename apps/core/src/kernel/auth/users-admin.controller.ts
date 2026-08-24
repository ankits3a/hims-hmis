import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException,
  Param, Post,
} from "@nestjs/common";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { DB } from "../tokens";
import { CurrentActor, RequirePermission } from "../auth/decorators";
import { withTx } from "../db/client";
import { appendEvent } from "../events/append";
import { roleAssignments, rolePermissions, users } from "../db/schema";
import { createUser, deactivateUser, reactivateUser, setPassword, setPin } from "./identity";
import { revokeUserSessions } from "./sessions";
import { checkPassword, checkPin } from "./password-policy";
import { userCreated, userCredentialReset, userDeactivated, userReactivated } from "./events";
import { authManifest } from "./manifest";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../db/client";

/**
 * PLAN 11e T3 — USER ADMINISTRATION OVER HTTP.
 *
 * ═══ WHAT THIS FILE ENDS ═══
 *
 * `auth.users.manage` has been declared by `manifest.ts` since Plan 02 and, until this file,
 * guarded NO ROUTE ANYWHERE IN THE TREE — its only non-test occurrences were the manifest itself
 * and two comments in seed scripts. A hospital that had been live for a day could not create a
 * second user except by running a seed script over SSH, and a receptionist who forgot her password
 * was locked out permanently, because `seed:staff` REFUSES a changed password by design: a silent
 * overwrite is the one way to lock a real user out. The refusal that protects users also stranded
 * them. Six routes, one permission, and the permission finally names something.
 *
 * ═══ NO ROLE CREATE / EDIT / DELETE, DELIBERATELY ═══
 *
 * Role VOCABULARY is code-owned (`ROLE_MODEL` in `scripts/seed-roles.ts`, plus the seeds). An
 * HTTP-minted role is invisible to the model — which is the exact shape production's permissionless
 * `owner` role had for the whole of Plan 11d, holding nothing and reachable by nobody. Assignment
 * of an EXISTING role is a different act and lives in `roles-admin.controller.ts` (T4) under its
 * own permission.
 *
 * ═══ NO SECOND FACTOR HERE, DELIBERATELY, AND IT IS A MEASUREMENT ═══
 *
 * Production holds ZERO TOTP enrolments (plan 11e §2). `secondFactor: true` on these decorators
 * would brick the surface on the day it shipped — the admin would need a factor they cannot enrol
 * without reaching a route the factor guards. Enrolment already exists (`POST /auth/totp/enroll`);
 * turning it on here is one line, for a later phase, after the owner enrols.
 */

/** The route table, transcribed from the decorators below (the `OPS_ROUTES` precedent, 11d D9). */
export const USERS_MANAGE = "auth.users.manage";

const createUserSchema = z.object({
  username: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, {
    error: "must be 1-64 characters of a-z, 0-9, dot, underscore or hyphen, not starting with punctuation",
  }),
  fullName: z.string().min(1).max(120),
  password: z.string().min(1),
  pin: z.string().min(1).optional(),
});
const passwordResetSchema = z.object({ newPassword: z.string().min(1) });
const pinResetSchema = z.object({ newPin: z.string().min(1) });

export type AdminUserRoleView = {
  assignmentId: string;
  roleKey: string;
  scopeType: string;
  scopeId: string | null;
};
export type AdminUserView = {
  id: string;
  username: string;
  fullName: string;
  active: boolean;
  hasPin: boolean;
  mustChangePassword: boolean;
  roles: AdminUserRoleView[];
};

/**
 * ═══ THE LOCKOUT INVARIANT — STATED ONCE, HERE, AND ENFORCED TWICE ═══
 *
 * NO MUTATION MAY LEAVE ZERO ACTIVE USERS HOLDING `auth.users.manage`. Two routes can reduce the
 * holder count — this controller's `deactivate`, and T4's `revokeRoleAssignment` — and both call
 * THIS function, which is why it is exported from here rather than copied there. An admin surface
 * that can deactivate its own last key repairs nobody: it is the receptionist-lockout problem one
 * level up, and the repair for it would be an agent with database access, which is the thing this
 * phase exists to stop needing.
 *
 * TEMPORARY GRANTS DO NOT COUNT, DELIBERATELY. `temp_role_grants` expire — often within the hour —
 * so a holder set that counted them would let the last PERMANENT administrator be removed on the
 * strength of an authority that evaporates while nobody is looking. `hasPermission` honours temp
 * grants for ACCESS, which is correct; this is a question about who will still be here tomorrow.
 */
/**
 * ONE ARBITRARY BUT STABLE KEY, so every lockout-checked mutation contends on the same lock.
 * The value is meaningless; its constancy is the whole property.
 */
const ADMIN_LOCKOUT_LOCK_KEY = 811_000_011;

/** One refusal body, so the pre-check and the index violation are indistinguishable to a caller. */
const USERNAME_TAKEN = { code: "username_taken", message: "that username already exists" };

/** Postgres `unique_violation`. Narrow on purpose: any other error is a bug and must stay a 500. */
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "23505";

/**
 * Who would STILL hold `permission` — **at the scope the admin routes actually demand** — once the
 * named removal had happened.
 *
 * ═══ THE SCOPE PREDICATE IS THE CORRECTION, AND ITS ABSENCE WAS A REAL DEFECT ═══
 *
 * The first version of this counted every assignment carrying the permission, at ANY scope, while
 * every route on both admin controllers is `@RequirePermission(…, "hospital")`. `hasPermission`
 * refuses a `department`- or `floor`-scoped holding against a hospital requirement
 * (`permissions.ts`), so the counter's holder set was a SUPERSET of the set that can reach the
 * routes — and the difference was exactly what the invariant exists to protect. Two authorised
 * requests exploited it: give the sole administrator a second, DEPARTMENT-scoped `admin`
 * assignment, then revoke their hospital-scoped one. The old counter saw two assignments, said
 * "they still hold it", and answered 204 — leaving a deployment whose only administrator is
 * refused 403 on every admin route, repairable only by direct database access. Found by the 11e
 * independent reviewer (CLOSE, C2).
 *
 * ═══ WHY THIS SHAPE — ONE QUERY THAT MODELS THE POST-STATE ═══
 *
 * It asks "who holds it AFTER" rather than "who holds it now, minus some set arithmetic". The
 * arithmetic was where the scope confusion hid. Excluding the user models a deactivation exactly
 * (a deactivated user is not `active`); excluding the assignment models a revoke exactly. An
 * assignment id that matches nothing excludes nothing, which is correct: the route then answers
 * its own 404.
 *
 * TEMPORARY GRANTS STILL DO NOT COUNT, deliberately, and the direction is safe. `temp_role_grants`
 * expire, often within the hour, so counting them would let the last permanent administrator go on
 * the strength of authority that evaporates unwatched. That makes this counter STRICTER than the
 * guard, which can only ever refuse a legal removal — never permit a lockout.
 */
export async function hospitalScopeHolders(
  tx: Tx,
  permission: string,
  exclude: { userId?: string; assignmentId?: string } = {},
): Promise<string[]> {
  const conditions = [
    eq(rolePermissions.permission, permission),
    eq(users.active, true),
    // THE PREDICATE C2 WAS MISSING.
    eq(roleAssignments.scopeType, "hospital"),
  ];
  if (exclude.userId !== undefined) conditions.push(ne(roleAssignments.userId, exclude.userId));
  if (exclude.assignmentId !== undefined) conditions.push(ne(roleAssignments.id, exclude.assignmentId));
  const rows = await tx
    .select({ userId: roleAssignments.userId })
    .from(roleAssignments)
    .innerJoin(rolePermissions, eq(rolePermissions.roleKey, roleAssignments.roleKey))
    .innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(and(...conditions));
  return [...new Set(rows.map((r) => r.userId))].sort();
}

/**
 * The `auth.*` permissions this user actually holds AT HOSPITAL SCOPE — the scope every admin
 * route demands, so this set is what they could really USE. Hospital scope for the same reason
 * `hospitalScopeHolders` uses it (C2): a counter that disagrees with the guard is exploitable.
 */
export async function authPermissionsHeld(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ permission: rolePermissions.permission })
    .from(roleAssignments)
    .innerJoin(rolePermissions, eq(rolePermissions.roleKey, roleAssignments.roleKey))
    .where(
      and(
        eq(roleAssignments.userId, userId),
        eq(roleAssignments.scopeType, "hospital"),
        inArray(rolePermissions.permission, [...authManifest.permissions]),
      ),
    );
  return [...new Set(rows.map((r) => r.permission))].sort();
}

/**
 * ═══ THE TAKEOVER RULE — OWNER RULING 2026-08-24 ═══
 *
 * **An actor may reset a credential only if the `auth.*` permissions they hold are a SUPERSET of
 * the target's.**
 *
 * THE DEFECT IT CLOSES (11e CLOSE, the independent reviewer's M6). A credential reset is a
 * TAKEOVER: the actor chooses the password, so they can then sign in as the target and wield
 * everything the target holds. That made `auth.users.manage` a complete escalation to
 * `auth.roles.manage` — and worse, it fired at exactly the moment this phase exists to enable.
 * The whole point of building this surface is that the owner can DELEGATE password resets to a
 * front-office supervisor; the moment they did, that supervisor silently became a superuser.
 *
 * WHY `auth.*` AND NOT EVERY PERMISSION. The naive rule — "refuse if the target holds anything the
 * actor lacks" — is unworkable and would have killed the feature: a supervisor holding only
 * `auth.users.manage` could not reset a CASHIER, because the cashier holds `billing.*`. What makes
 * a takeover dangerous is authority over ACCESS, not authority over billing or OPD. The set is
 * read from `authManifest.permissions` rather than hand-listed, so a seventh `auth.*` permission
 * is protected the day it is declared (§2.54: one copy of a fact).
 *
 * THE CASES, and the third is the one the naive rule got wrong:
 *   supervisor {users.manage} → cashier {}            ALLOWED — the feature works
 *   supervisor {users.manage} → owner {all six}       REFUSED — the escalation, closed
 *   owner {all six}           → supervisor            ALLOWED
 *   owner {all six}           → another full owner    ALLOWED — this is the recovery path
 *   peer {users.manage}       → peer {users.manage}   ALLOWED — equal authority gains nothing
 *
 * ═══ THE COST, STATED RATHER THAN DISCOVERED ═══
 *
 * A deployment whose top administrator is the ONLY holder of the full `auth.*` set has nobody who
 * may reset them. If they forget their password, the repair is direct database access — the thing
 * this phase exists to stop needing. **THE MITIGATION IS OPERATIONAL AND IT IS NAMED IN THE
 * REFUSAL ITSELF: keep two people holding the full set.** That is cheap, it is the same discipline
 * the lockout invariant already assumes, and it is far better than the alternative — leaving every
 * delegate a silent superuser so that one recovery case stays convenient.
 *
 * SCOPE: the two CREDENTIAL routes only. Deactivate and role-revoke do not confer takeover — you
 * cannot become somebody by switching them off — and the lockout invariant already guards those.
 */
export async function assertMayTakeOver(tx: Tx, actorId: string, targetId: string): Promise<void> {
  const [actorHolds, targetHolds] = await Promise.all([
    authPermissionsHeld(tx, actorId),
    authPermissionsHeld(tx, targetId),
  ]);
  const missing = targetHolds.filter((permission) => !actorHolds.includes(permission));
  if (missing.length > 0) {
    throw new ConflictException({
      code: "admin_target_protected",
      message:
        `refused: resetting a credential means being able to sign in as that person, and they ` +
        `hold ${missing.join(", ")}, which you do not. Ask somebody who holds everything they do. ` +
        `If nobody does, that is the state to fix: keep TWO people holding the full auth.* set, ` +
        `or a forgotten password at the top has no repair but direct database access.`,
    });
  }
}

/** Refuses when the named removal would leave nobody able to administer users. */
export async function assertNoAdminLockout(
  tx: Tx,
  removal: { userId: string } | { assignmentId: string },
): Promise<void> {
  /**
   * THE LOCK IS TAKEN BEFORE THE COUNT, and it closes a real TOCTOU (CLOSE, M1). `withTx` runs at
   * Postgres's default READ COMMITTED and this check took plain SELECTs, so two overlapping
   * removals — the last two holders, or one deactivate racing one role revoke — each read a holder
   * set of two, each computed a non-empty remainder, and both committed: zero holders, no refusal,
   * no repair short of database access. A transaction-scoped advisory lock serialises them, and
   * because READ COMMITTED takes a fresh snapshot per statement, the second transaction's count
   * runs after the first has committed and sees its effect.
   */
  await tx.execute(sql`select pg_advisory_xact_lock(${ADMIN_LOCKOUT_LOCK_KEY})`);
  const remaining = await hospitalScopeHolders(tx, USERS_MANAGE, removal);
  if (remaining.length === 0) {
    throw new ConflictException({
      code: "admin_lockout",
      message:
        `refused: this would leave NOBODY holding ${USERS_MANAGE}. There would then be no way to ` +
        `create a user, reset a password or restore this account except direct database access.`,
    });
  }
}

@Controller("admin/users")
export class UsersAdminController {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async requireUser(tx: Tx, id: string): Promise<{ id: string; username: string }> {
    const rows = await tx
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.id, id));
    const user = rows[0];
    if (user === undefined) throw new NotFoundException({ code: "user_not_found" });
    return user;
  }

  /**
   * `must_change_password` is TRUE and it is not an option the caller may pass. Every human
   * provisioned through this route proves control of their own credential at first login; a
   * request body that could say otherwise would make "skip that" the path of least resistance on
   * a busy morning.
   */
  @RequirePermission(USERS_MANAGE, "hospital")
  @Post()
  async create(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ id: string }> {
    const parsed = createUserSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { username, fullName, password, pin } = parsed.data;

    const problems = [
      ...checkPassword(password, { username }),
      ...(pin === undefined ? [] : checkPin(pin)),
    ];
    if (problems.length > 0) throw new BadRequestException({ code: "password_policy", problems });

    /**
     * THE PRE-CHECK IS COURTESY; THE CATCH IS THE GUARANTEE (CLOSE, minor 4).
     *
     * The SELECT gives the common case a clean 409 without burning a transaction. It cannot be
     * authoritative — it runs outside the insert's transaction, so two simultaneous creates of the
     * same username both pass it and one hits `users_username_ux`. That used to surface as a 500,
     * which tells the person at the desk nothing and looks like an outage. The unique index is the
     * real arbiter; this maps its violation onto the same 409 the pre-check returns.
     */
    const existing = await this.db.select({ id: users.id }).from(users).where(eq(users.username, username));
    if (existing.length > 0) throw new ConflictException(USERNAME_TAKEN);

    try {
      return await withTx(this.db, async (tx) => {
        const { id } = await createUser(tx, { username, fullName, password, pin, mustChangePassword: true });
        await appendEvent(
          tx,
          userCreated.make({
            actor,
            payload: { userId: id, username, fullName, hasPin: pin !== undefined, mustChangePassword: true },
          }),
        );
        return { id };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException(USERNAME_TAKEN);
      throw e; // anything else is a genuine bug: 500, loudly
    }
  }

  /**
   * The whole roster, including deactivated accounts — a list that hid them would make
   * "reactivate" a route with no way to reach it. No credential material of any kind: `hasPin` is
   * a boolean about whether one EXISTS.
   */
  @RequirePermission(USERS_MANAGE, "hospital")
  @Get()
  async list(): Promise<{ users: AdminUserView[] }> {
    const rows = await this.db
      .select({
        id: users.id,
        username: users.username,
        fullName: users.fullName,
        active: users.active,
        pinHash: users.pinHash,
        mustChangePassword: users.mustChangePassword,
      })
      .from(users)
      .orderBy(users.username);
    const ids = rows.map((r) => r.id);
    const assignments = ids.length === 0
      ? []
      : await this.db
        .select({
          assignmentId: roleAssignments.id,
          userId: roleAssignments.userId,
          roleKey: roleAssignments.roleKey,
          scopeType: roleAssignments.scopeType,
          scopeId: roleAssignments.scopeId,
        })
        .from(roleAssignments)
        .where(inArray(roleAssignments.userId, ids));

    return {
      users: rows.map((r) => ({
        id: r.id,
        username: r.username,
        fullName: r.fullName,
        active: r.active,
        hasPin: r.pinHash !== null,
        mustChangePassword: r.mustChangePassword,
        roles: assignments
          .filter((a) => a.userId === r.id)
          .map(({ assignmentId, roleKey, scopeType, scopeId }) => ({ assignmentId, roleKey, scopeType, scopeId })),
      })),
    };
  }

  /**
   * DEACTIVATION AND REVOCATION ARE ONE FLOW, and that is D1/Q5's "both belts". The join in
   * `findLiveSession` already refuses an inactive user's token, so the revoke here is the belt
   * that does not depend on any future code path remembering the first — and it is what makes the
   * event's `sessionsRevoked` count meaningful.
   */
  @RequirePermission(USERS_MANAGE, "hospital")
  @Post(":id/deactivate")
  @HttpCode(200)
  async deactivate(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
  ): Promise<{ sessionsRevoked: number }> {
    return withTx(this.db, async (tx) => {
      const user = await this.requireUser(tx, id);
      await assertNoAdminLockout(tx, { userId: id });
      await deactivateUser(tx, id);
      const sessionsRevoked = await revokeUserSessions(tx, id);
      await appendEvent(
        tx,
        userDeactivated.make({ actor, payload: { userId: id, username: user.username, sessionsRevoked } }),
      );
      return { sessionsRevoked };
    });
  }

  /** Sessions stay revoked: the account was off, and "off" is not a state a token should survive. */
  @RequirePermission(USERS_MANAGE, "hospital")
  @Post(":id/reactivate")
  @HttpCode(204)
  async reactivate(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<void> {
    await withTx(this.db, async (tx) => {
      const user = await this.requireUser(tx, id);
      await reactivateUser(tx, id);
      await appendEvent(tx, userReactivated.make({ actor, payload: { userId: id, username: user.username } }));
    });
  }

  /**
   * PASSWORD RESET: policy-checked, must-change SET, and every session of the target REVOKED.
   *
   * The revoke is not tidiness. An admin resets a password when a credential is lost or suspected
   * compromised, so the sessions that credential opened are exactly what must not survive it —
   * and R9's mutant is a handler that calls `setPassword` and forgets this line.
   */
  @RequirePermission(USERS_MANAGE, "hospital")
  @Post(":id/password-reset")
  @HttpCode(200)
  async passwordReset(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ sessionsRevoked: number }> {
    const parsed = passwordResetSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return withTx(this.db, async (tx) => {
      const user = await this.requireUser(tx, id);
      await assertMayTakeOver(tx, actor.id, id);
      const problems = checkPassword(parsed.data.newPassword, { username: user.username });
      if (problems.length > 0) throw new BadRequestException({ code: "password_policy", problems });

      await setPassword(tx, id, parsed.data.newPassword, { mustChangePassword: true });
      const sessionsRevoked = await revokeUserSessions(tx, id);
      await appendEvent(
        tx,
        userCredentialReset.make({
          actor,
          payload: {
            userId: id, username: user.username, kind: "password", sessionsRevoked,
            mustChangePassword: true,
          },
        }),
      );
      return { sessionsRevoked };
    });
  }

  /**
   * PIN RESET: policy-checked, and it revokes NOTHING and sets NO flag (Q3).
   *
   * A PIN is the shared-terminal fast-switch credential, not a way into the system from anywhere:
   * `switchWithPin` already revokes that terminal's sessions on every switch. A changed PIN implies
   * no password compromise, so killing the person's sessions would be a punishment for a routine
   * act — and forcing a PASSWORD change after a PIN reset would be an unrelated demand.
   */
  @RequirePermission(USERS_MANAGE, "hospital")
  @Post(":id/pin-reset")
  @HttpCode(204)
  async pinReset(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = pinResetSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    await withTx(this.db, async (tx) => {
      // EXISTENCE BEFORE POLICY, matching `passwordReset` (CLOSE, minor 5). The two routes used to
      // disagree: a bad PIN for a user who does not exist answered 400 here and 404 there. Same
      // question, same order, so a caller can rely on the answer.
      const user = await this.requireUser(tx, id);
      await assertMayTakeOver(tx, actor.id, id);
      const problems = checkPin(parsed.data.newPin);
      if (problems.length > 0) throw new BadRequestException({ code: "password_policy", problems });
      await setPin(tx, id, parsed.data.newPin);
      await appendEvent(
        tx,
        userCredentialReset.make({
          actor,
          payload: {
            userId: id, username: user.username, kind: "pin", sessionsRevoked: 0,
            mustChangePassword: false,
          },
        }),
      );
    });
  }
}
