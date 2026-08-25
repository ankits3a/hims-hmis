import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { rolePermissions, roles, tempRoleGrants } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { authManifest } from "./manifest";
import {
  emergencyElevationReviewed, emergencyElevationUsed, tempRoleGranted, tempRoleExpired,
} from "./events";
import type { AppConfig } from "../config";
import type { Db, Tx } from "../db/client";

/**
 * ═══ THE ELEVATION CEILING — WHAT A TEMPORARY GRANT MAY NEVER CONFER ═══
 *
 * **A temporary role may not carry authority over ACCESS ITSELF.**
 *
 * ─── THE HOLE THIS CLOSES, stated plainly because it was live ───
 *
 * `POST /auth/emergency-elevation` is the only route on `auth.controller.ts` carrying no
 * `@RequirePermission`, deliberately: at 2 a.m. with the duty manager unreachable, a person must
 * be able to act, and the design pays for that with loudness rather than with a gate. But
 * `emergencyElevate` accepted ANY `roleKey`, and `hasPermission` honours a temp grant AT HOSPITAL
 * SCOPE (`permissions.ts`). So any authenticated user — a registration clerk, the waiting-room
 * display account — could POST `{roleKey: "admin", ttlMinutes: 720}` and hold all six `auth.*`
 * permissions for twelve hours (`TEMP_ROLE_MAX_TTL_MINUTES`, `config.ts`).
 *
 * AND THE TTL DID NOT BOUND IT. Twelve hours is far more than enough to `POST /admin/users`, then
 * `POST /admin/users/{new}/roles` with `admin` — a PERMANENT assignment — and sign in as that
 * account. The elevation expired; the escalation did not. `assertMayTakeOver` does not catch this
 * either: it reads `role_assignments` only, so an elevated actor's `auth.*` set reads as empty and
 * the guard it would have tripped never fires.
 *
 * ─── THE RULE, AND WHY IT IS SUBTRACTION RATHER THAN A LIST ───
 *
 * `ELEVATABLE_AUTH_PERMISSIONS` names what MAY be handed out temporarily; everything else
 * `authManifest` declares is refused. The direction matters and is the whole design: a new
 * `auth.*` string is REFUSED the day it is declared, without anybody remembering to add it here.
 * A hand-written list of forbidden permissions would fail open on exactly the permission nobody
 * thought about — which is the shape of every escalation bug.
 *
 * It is the same instinct as `assertMayTakeOver`'s ("read from `authManifest.permissions` rather
 * than hand-listed, so a seventh `auth.*` permission is protected the day it is declared") turned
 * fail-closed.
 *
 * ─── WHY `auth.break_glass.use` IS THE ONE EXCEPTION ───
 *
 * It is the emergency this mechanism exists for. A nurse who must open a record at 2 a.m. is the
 * worked example in spec §14, and the act is already time-boxed, evented, and queued for review by
 * `break-glass.ts`. Elevating into it adds no durable authority: break-glass grants expire and
 * cannot mint an account, a role or a key.
 *
 * The review permissions are NOT on the list, and that is not an oversight — nothing is ever urgent
 * about reviewing a break-glass at 2 a.m., and `auth.elevation.review`'s absence is what makes it
 * structurally impossible to self-elevate into clearing your own elevation (`manifest.ts`).
 *
 * ─── IT GUARDS BOTH DOORS, NOT ONLY THE SELF-SERVICE ONE ───
 *
 * `grantTempRole` is checked identically. Today only `admin` holds `auth.temp_role.grant` so the
 * admin-granted path is not itself an escalation — but the moment that permission moves to an
 * operational role (the duty manager is the obvious holder; the night-shift bundling matrix is
 * what `temp_role_grants` was built for), two colleagues granting each other `admin` would reopen
 * exactly this hole through the other door. One rule, both doors.
 *
 * A temp grant is also INVISIBLE to `hospitalScopeHolders` and `authPermissionsHeld`, which count
 * `role_assignments` only — deliberately, so an authority that evaporates cannot satisfy the
 * lockout invariant. A temporary `admin` would therefore be an administrator neither the lockout
 * invariant nor the takeover rule can see. **Delegating authority over access is a PERMANENT
 * assignment under `auth.roles.manage`, where both guards can see it, or it does not happen.**
 */
export const ELEVATABLE_AUTH_PERMISSIONS: readonly string[] = ["auth.break_glass.use"];

/** Everything `authManifest` declares that a temporary grant may NOT carry. Derived, never listed. */
export const ELEVATION_FORBIDDEN_PERMISSIONS: readonly string[] = authManifest.permissions
  .filter((p) => !ELEVATABLE_AUTH_PERMISSIONS.includes(p))
  .sort();

/** The role named by a grant request does not exist on this deployment. */
export class UnknownRoleError extends Error {
  constructor(readonly roleKey: string) {
    super(`no role "${roleKey}" exists on this deployment`);
    this.name = "UnknownRoleError";
  }
}

/** The role exists but carries authority no temporary grant may confer. */
export class RoleNotTemporarilyGrantableError extends Error {
  constructor(readonly roleKey: string, readonly permissions: readonly string[]) {
    super(
      `refused: "${roleKey}" carries ${permissions.join(", ")}, which a temporary grant may never ` +
        `confer — that authority outlives the grant, because its holder can mint a permanent one. ` +
        `Delegating it is a permanent role assignment under auth.roles.manage, where the lockout ` +
        `invariant and the takeover rule can both see it.`,
    );
    this.name = "RoleNotTemporarilyGrantableError";
  }
}

/**
 * Refuses unless `roleKey` exists AND carries none of `ELEVATION_FORBIDDEN_PERMISSIONS`.
 *
 * THE EXISTENCE CHECK IS NOT COURTESY HERE. Without it an unknown role falls through the
 * permission query (which returns nothing, so nothing is forbidden), reaches the insert, and dies
 * on `temp_role_grants_role_key_fk` as a 500 — a refusal path masquerading as an outage.
 *
 * Runs INSIDE the caller's transaction so the check and the insert cannot straddle a concurrent
 * `grantPermissionToRole`.
 */
async function assertTemporarilyGrantable(tx: Tx, roleKey: string): Promise<void> {
  const known = await tx.select({ key: roles.key }).from(roles).where(eq(roles.key, roleKey));
  if (known.length === 0) throw new UnknownRoleError(roleKey);

  const carried = await tx
    .select({ permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(
      and(
        eq(rolePermissions.roleKey, roleKey),
        inArray(rolePermissions.permission, [...ELEVATION_FORBIDDEN_PERMISSIONS]),
      ),
    );
  if (carried.length > 0) {
    throw new RoleNotTemporarilyGrantableError(roleKey, carried.map((r) => r.permission).sort());
  }
}

export async function grantTempRole(
  db: Db,
  cfg: AppConfig,
  grantor: Actor,
  input: { userId: string; roleKey: string; reason: string; ttlMinutes: number },
): Promise<{ grantId: string; expiresAt: Date }> {
  if (grantor.type === "user" && grantor.id === input.userId) {
    throw new Error("self-grant is not allowed here — use emergencyElevate, which events emergency_elevation.used");
  }
  const ttl = Math.min(input.ttlMinutes, cfg.tempRoleMaxTtlMinutes);
  const grantId = newId();
  const expiresAt = new Date(Date.now() + ttl * 60_000);
  await withTx(db, async (tx) => {
    await assertTemporarilyGrantable(tx, input.roleKey);
    await tx.insert(tempRoleGrants).values({
      id: grantId, userId: input.userId, roleKey: input.roleKey,
      grantedBy: grantor.id, kind: "granted", reason: input.reason, expiresAt,
    });
    await appendEvent(
      tx,
      tempRoleGranted.make({
        actor: grantor,
        payload: {
          grantId, userId: input.userId, roleKey: input.roleKey,
          grantedBy: grantor.id, kind: "granted", reason: input.reason,
          expiresAt: expiresAt.toISOString(),
        },
      }),
    );
  });
  return { grantId, expiresAt };
}

export async function emergencyElevate(
  db: Db,
  cfg: AppConfig,
  actor: Actor,
  input: { roleKey: string; reason: string; ttlMinutes: number },
): Promise<{ grantId: string; expiresAt: Date }> {
  const ttl = Math.min(input.ttlMinutes, cfg.tempRoleMaxTtlMinutes);
  const grantId = newId();
  const expiresAt = new Date(Date.now() + ttl * 60_000);
  await withTx(db, async (tx) => {
    // THE CEILING, CHECKED BEFORE ANYTHING IS WRITTEN. A refused elevation must leave no row and
    // no event: `emergency_elevation.used` means authority was taken, and emitting it for an
    // attempt that was refused would put a lie in the audit stream the review queue reads from.
    await assertTemporarilyGrantable(tx, input.roleKey);
    await tx.insert(tempRoleGrants).values({
      id: grantId, userId: actor.id, roleKey: input.roleKey,
      grantedBy: actor.id, kind: "emergency", reason: input.reason, expiresAt,
    });
    await appendEvent(
      tx,
      emergencyElevationUsed.make({
        actor,
        payload: { grantId, roleKey: input.roleKey, reason: input.reason, expiresAt: expiresAt.toISOString() },
      }),
    );
    await appendEvent(
      tx,
      tempRoleGranted.make({
        actor,
        payload: {
          grantId, userId: actor.id, roleKey: input.roleKey,
          grantedBy: actor.id, kind: "emergency", reason: input.reason,
          expiresAt: expiresAt.toISOString(),
        },
      }),
    );
  });
  return { grantId, expiresAt };
}

// ══════════════════════ THE REVIEW QUEUE — THE OTHER HALF OF "LOUDLY EVENTED" ══════════════════════

export type ElevationReviewItem = {
  id: string; userId: string; roleKey: string; reason: string; createdAt: Date; expiresAt: Date;
};

/**
 * Every emergency self-elevation nobody has signed off on, oldest first.
 *
 * `kind = 'emergency'` ONLY, and that is the queue's whole scope: an admin-granted temp role was
 * chosen by a second person who already holds `auth.temp_role.grant`, so it carries the two-person
 * property this queue exists to restore. A self-grant has nobody but the grantee in it.
 *
 * EXPIRED GRANTS STAY IN THE QUEUE. The authority is gone; the question of whether taking it was
 * justified is not, and it is the only question a reviewer is being asked. Filtering by
 * `expiresAt > now` would empty the queue on a twelve-hour timer and call that "reviewed" —
 * turning the mandatory review into a race the reviewer loses by sleeping.
 */
export async function pendingElevationReviews(db: Db): Promise<ElevationReviewItem[]> {
  return db
    .select({
      id: tempRoleGrants.id,
      userId: tempRoleGrants.userId,
      roleKey: tempRoleGrants.roleKey,
      reason: tempRoleGrants.reason,
      createdAt: tempRoleGrants.createdAt,
      expiresAt: tempRoleGrants.expiresAt,
    })
    .from(tempRoleGrants)
    .where(and(eq(tempRoleGrants.kind, "emergency"), isNull(tempRoleGrants.reviewedAt)))
    .orderBy(tempRoleGrants.createdAt);
}

/** The grant a review names is absent, or is not an emergency elevation. */
export class UnknownElevationError extends Error {
  constructor(readonly grantId: string) {
    super(`no emergency elevation "${grantId}" exists`);
    this.name = "UnknownElevationError";
  }
}

/** Somebody already reviewed it. */
export class ElevationAlreadyReviewedError extends Error {
  constructor(readonly grantId: string, readonly reviewedBy: string) {
    super(`emergency elevation "${grantId}" was already reviewed by ${reviewedBy}`);
    this.name = "ElevationAlreadyReviewedError";
  }
}

/**
 * Records a reviewer's disposition, once.
 *
 * ═══ THE CONDITIONAL UPDATE IS THE GUARANTEE, THE READ IS THE MESSAGE ═══
 *
 * `where(... isNull(reviewedAt))` means two reviewers racing produce exactly one winner: the
 * second update matches no row and is told so. A read-then-write would let both commit at READ
 * COMMITTED, and the audit stream would carry two `emergency_elevation.reviewed` events for one
 * act with the row holding whichever note landed last.
 *
 * This deliberately does MORE than `break-glass.ts`'s `recordReview`, which updates
 * unconditionally, cannot tell a missing grant from a reviewed one, and emits no event at all.
 * That function is a known gap and is out of this change's scope; it is named here so the
 * difference reads as a decision rather than an inconsistency.
 */
export async function recordElevationReview(
  db: Db,
  grantId: string,
  reviewer: Actor,
  note: string,
): Promise<void> {
  await withTx(db, async (tx) => {
    const updated = await tx
      .update(tempRoleGrants)
      .set({ reviewedAt: new Date(), reviewedBy: reviewer.id, reviewNote: note })
      .where(
        and(
          eq(tempRoleGrants.id, grantId),
          eq(tempRoleGrants.kind, "emergency"),
          isNull(tempRoleGrants.reviewedAt),
        ),
      )
      .returning({ userId: tempRoleGrants.userId, roleKey: tempRoleGrants.roleKey });

    const row = updated[0];
    if (row === undefined) {
      // Nothing was updated. Two very different states produce that, and a reviewer deserves to
      // know which — so the distinguishing read happens ONLY on the failure path, where it costs
      // nothing and cannot race the update it is explaining.
      const existing = await tx
        .select({ kind: tempRoleGrants.kind, reviewedBy: tempRoleGrants.reviewedBy })
        .from(tempRoleGrants)
        .where(eq(tempRoleGrants.id, grantId));
      const found = existing[0];
      if (found === undefined || found.kind !== "emergency") throw new UnknownElevationError(grantId);
      throw new ElevationAlreadyReviewedError(grantId, found.reviewedBy ?? "somebody");
    }

    await appendEvent(
      tx,
      emergencyElevationReviewed.make({
        actor: reviewer,
        payload: {
          grantId, userId: row.userId, roleKey: row.roleKey, reviewedBy: reviewer.id, note,
        },
      }),
    );
  });
}

// Plan 08.5 D2/Global Constraint 9: the worker's scheduler calls every job as `run(now)`, so
// this sweep takes `now` like the others (sweepGuardianMajority, sweepAppointmentNoShows,
// runDailyClose already did). Defaulted for backward compatibility with existing callers.
export async function sweepExpiredTempRoles(db: Db, now: Date = new Date()): Promise<number> {
  const due = await db
    .select()
    .from(tempRoleGrants)
    .where(and(lte(tempRoleGrants.expiresAt, now), isNull(tempRoleGrants.expiredEventAt)));
  for (const grant of due) {
    await withTx(db, async (tx) => {
      await appendEvent(
        tx,
        tempRoleExpired.make({
          actor: { type: "system", id: "temp-role-sweep" },
          payload: { grantId: grant.id, userId: grant.userId, roleKey: grant.roleKey },
        }),
      );
      await tx.update(tempRoleGrants).set({ expiredEventAt: now }).where(eq(tempRoleGrants.id, grant.id));
    });
  }
  return due.length;
}
