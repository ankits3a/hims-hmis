import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param,
  Post,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { DB } from "../tokens";
import { CurrentActor, RequirePermission } from "./decorators";
import { withTx } from "../db/client";
import { appendEvent } from "../events/append";
import { roleAssignments, rolePermissions, roles, users } from "../db/schema";
import { assignRole, revokeRoleAssignment } from "./permissions";
import { authManifest } from "./manifest";
import type { ScopeType } from "./permissions";
import { assertNoAdminLockout } from "./users-admin.controller";
import { roleAssigned, roleRevoked } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * PLAN 11e T4 — ASSIGNING AND REVOKING ROLES OVER HTTP.
 *
 * ═══ WHY THIS IS A SECOND CONTROLLER ON THE SAME BASE PATH ═══
 *
 * `auth.roles.manage` and `auth.users.manage` are two permissions and they mean two different
 * things: one governs the ACCOUNT (does this person exist, can they sign in, what is their
 * credential), the other governs the AUTHORITY (what may this person do). Two controllers make
 * that split legible from the file names; one controller carrying both would put the
 * route→permission map back where §3.42's defect hid — in a column of decorators nobody reads
 * together. `test/user-admin.e2e.test.ts` legs 1-4 read them together, by execution.
 *
 * ═══ THE SPLIT IS A BOUNDARY AGAIN — IT WAS NOT ONE FOR SIX COMMITS ═══
 *
 * This header used to say a hospital could "reasonably give the front-office supervisor the first
 * and keep the second with the owner". THAT SENTENCE WAS WRONG WHEN IT WAS WRITTEN and it is
 * retracted (11e CLOSE, the independent reviewer's M6). As shipped, `auth.users.manage` WAS a
 * complete escalation to `auth.roles.manage`: its holder could `POST
 * /admin/users/{owner}/password-reset` with a password of their choosing and then sign in as the
 * owner. Nothing refused a credential reset against a target holding permissions the actor lacked,
 * and there is still no second factor on that route (production has zero TOTP enrolments —
 * `users-admin.controller.ts` states that seam).
 *
 * **RULED AND CLOSED, 2026-08-24.** `users-admin.controller.ts`'s `assertMayTakeOver` refuses a
 * credential reset unless the actor's `auth.*` set is a SUPERSET of the target's, so a delegate
 * holding `auth.users.manage` can no longer take over an administrator. The split is a real
 * boundary again — but read that function's header before relying on it: the line is drawn at
 * `auth.*` rather than at every permission, and it carries an operational cost. **Keep TWO people
 * holding the full `auth.*` set**, or a forgotten password at the top has no repair but direct
 * database access.
 *
 * ═══ NO SoD CALL HERE, AND IT IS MEASURED RATHER THAN ASSUMED (§3 Q4) ═══
 *
 * `assertNotSodPair` (`sod.ts:37`) is an ACT-time comparator: it refuses when the SAME ACTOR sits
 * on both sides of ONE act. Its two non-test callers are `approvals/decisions.ts` (requester vs
 * approver) and `workflow/definitions.ts` (drafter vs activator) — both measured, both about a
 * single item. The nine seeded pairs are ACT pairs, not ROLE pairs: in a small hospital one person
 * MAY hold both roles, and what the engine forbids is their acting as both sides of one item.
 * 11d's reviewer put it exactly: "SoD is enforced at ACT time, never at assignment time, so there
 * is nothing for a roster to bypass." An informational assign-time warning is conceivable future
 * UX; it would need its own role-pair vocabulary and it is not 11e's scope.
 *
 * ═══ NO ROLE CREATE / EDIT / DELETE ═══
 *
 * See `users-admin.controller.ts`'s header. This controller assigns EXISTING roles and nothing
 * more; the vocabulary stays code-owned.
 */
export const ROLES_MANAGE = "auth.roles.manage";

/**
 * `scopeType`/`scopeId` are `assignRole`'s existing rules, unchanged and re-stated by the schema
 * rather than re-implemented: a non-hospital scope REQUIRES a scopeId, and a hospital scope
 * discards one. Scope ids stay opaque until org masters exist (the Plan 02 seam).
 */
const assignSchema = z.object({
  roleKey: z.string().min(1),
  scopeType: z.enum(["hospital", "floor", "department"]),
  scopeId: z.string().min(1).optional(),
});

/**
 * ═══ THE SCOPES AN ASSIGNMENT MAY USEFULLY CARRY, MEASURED RATHER THAN ASSUMED ═══
 *
 * **`hospital` ONLY, and this is a MEASUREMENT of the tree as it stands — not a preference.**
 *
 * `role_assignments.scope_type` has accepted `hospital | floor | department` since Plan 02 and
 * `assignRole` still does; this constant does not change that seam and no route was narrowed. What
 * it records is what a non-hospital assignment BUYS today, which is nothing:
 *
 *   - every one of the 156 `@RequirePermission` decorators in this tree demands `"hospital"`
 *     (asserted by execution in `test/roles-catalog.e2e.test.ts`, which parses the source);
 *   - `hasPermission` refuses a non-hospital holding against a hospital requirement outright —
 *     `if (h.scopeType !== requiredScope) return false`, with no cross-level inference "until org
 *     masters exist" (`permissions.ts`).
 *
 * So a department-scoped `doctor` assignment grants the holder EXACTLY NOTHING, on every route, and
 * the person would meet a 403 everywhere while the admin screen showed them holding a role. That is
 * the "dark screens" failure the 2026-08-24 smoke test found, manufactured by the very control
 * meant to fix it — and it is the same confusion that made `hospitalScopeHolders` exploitable
 * before C2 (`users-admin.controller.ts`).
 *
 * A PICKER OFFERING FLOOR AND DEPARTMENT WOULD THEREFORE BE A TRAP. The client reads this list
 * instead of hard-coding one, so the day a genuinely department-scoped route lands the parser test
 * fails, this constant widens, and the picker gains the option in the same commit. There is no
 * second copy of the fact anywhere in the web app.
 */
export const ASSIGNABLE_SCOPES: readonly ScopeType[] = ["hospital"];

/** One row of the picker's catalogue. */
export type AdminRoleView = {
  key: string;
  title: string;
  /** Every permission the role carries, sorted. The person assigning it is granting these. */
  permissions: string[];
  /** Active users holding it at hospital scope — the only holding that grants anything (above). */
  holders: number;
  /**
   * The role carries at least one `auth.*` string, so assigning it hands over authority over
   * ACCESS: who exists, who may do what, whose credential can be reset. The screen says so before
   * the click rather than after it. DERIVED from `authManifest`, never listed — the same rule
   * `assertMayTakeOver` and the elevation ceiling follow, so a seventh `auth.*` is covered on
   * arrival.
   */
  grantsAccessAuthority: boolean;
};

/**
 * PLAN 11e's MISSING HALF — the roles catalogue, and why it took until now.
 *
 * `admin-users.tsx` shipped able to REVOKE a role and not to assign one, and its header said
 * exactly why: "Assigning from here needs a role picker fed by a roles list the server does not
 * yet expose — a route this phase deliberately did not add." This is that route. The owner's
 * report — "I created users but can't assign roles" — is that sentence, met in production.
 *
 * ═══ IT IS A SEPARATE CONTROLLER BECAUSE IT IS A SEPARATE PATH, NOT A SEPARATE AUTHORITY ═══
 *
 * `RolesAdminController` is mounted on `admin/users` and every route it owns is `:id/roles…`; a
 * `GET` for the CATALOGUE is not about a user at all, so it cannot live under that prefix without
 * becoming `/admin/users/roles` and colliding with `:id`. Same permission, same file, different
 * base path.
 *
 * ═══ IT READS, IT NEVER WRITES ═══
 *
 * No create, no edit, no delete — the vocabulary stays code-owned (`scripts/seed-roles.ts`), for
 * the reason `users-admin.controller.ts` gives: an HTTP-minted role is invisible to the model, and
 * production's permissionless `owner` role is what that looks like. Governed role AUTHORING — draft
 * → approve → activate through the approvals engine — is the owner's ruling of 2026-08-25 and is
 * the next slice, not this one.
 */
@Controller("admin/roles")
export class RolesCatalogController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission(ROLES_MANAGE, "hospital")
  @Get()
  async list(): Promise<{ roles: AdminRoleView[]; assignableScopes: readonly ScopeType[] }> {
    const rows = await this.db
      .select({ key: roles.key, title: roles.title })
      .from(roles)
      .orderBy(roles.key);

    const grants = await this.db
      .select({ roleKey: rolePermissions.roleKey, permission: rolePermissions.permission })
      .from(rolePermissions);

    /**
     * HOSPITAL SCOPE AND ACTIVE USERS ONLY, matching `hospitalScopeHolders`'s predicate exactly.
     * A count that included deactivated accounts or inert department holdings would report a role
     * as covered when nobody can actually exercise it — which is the 403-with-extra-steps state
     * `seed:roles`'s own holder census exists to surface.
     */
    const holdings = await this.db
      .select({ roleKey: roleAssignments.roleKey, userId: roleAssignments.userId })
      .from(roleAssignments)
      .innerJoin(users, eq(users.id, roleAssignments.userId))
      .where(and(eq(roleAssignments.scopeType, "hospital"), eq(users.active, true)));

    const authPermissions = new Set<string>(authManifest.permissions);
    return {
      assignableScopes: ASSIGNABLE_SCOPES,
      roles: rows.map((r) => {
        const permissions = grants
          .filter((g) => g.roleKey === r.key)
          .map((g) => g.permission)
          .sort();
        return {
          key: r.key,
          title: r.title,
          permissions,
          holders: new Set(holdings.filter((h) => h.roleKey === r.key).map((h) => h.userId)).size,
          grantsAccessAuthority: permissions.some((p) => authPermissions.has(p)),
        };
      }),
    };
  }
}

@Controller("admin/users")
export class RolesAdminController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission(ROLES_MANAGE, "hospital")
  @Post(":id/roles")
  async assign(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ assignmentId: string }> {
    const parsed = assignSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { roleKey, scopeType, scopeId } = parsed.data;
    if (scopeType !== "hospital" && scopeId === undefined) {
      throw new BadRequestException({
        code: "scope_id_required",
        message: `a ${scopeType}-scoped assignment requires a scopeId`,
      });
    }

    return withTx(this.db, async (tx) => {
      const user = await tx.select({ id: users.id }).from(users).where(eq(users.id, id));
      if (user.length === 0) throw new NotFoundException({ code: "user_not_found" });
      // The ROLE must exist too, and this is a 404 rather than the foreign-key error it would
      // otherwise be: `roles` is code-owned, so a key this deployment has not seeded is a typo or
      // a seed that has not been run, and both deserve a sentence.
      const role = await tx.select({ key: roles.key }).from(roles).where(eq(roles.key, roleKey));
      if (role.length === 0) {
        throw new NotFoundException({
          code: "role_not_found",
          message: `no role "${roleKey}" exists on this deployment — roles come from seed:roles and the module seeds, never from this route`,
        });
      }

      const { id: assignmentId } = await assignRole(tx, { userId: id, roleKey, scopeType, scopeId });
      await appendEvent(
        tx,
        roleAssigned.make({
          actor,
          payload: {
            assignmentId, userId: id, roleKey, scopeType,
            scopeId: scopeType === "hospital" ? null : (scopeId ?? null),
          },
        }),
      );
      return { assignmentId };
    });
  }

  /**
   * EFFECTIVE IMMEDIATELY, WITH NO SESSION WORK. `hasPermission` reads `role_assignments` live on
   * every request, so the target's very next call is already refused — no revocation, no
   * re-login, no TTL to wait out. R11 proves that by replaying the SAME token.
   *
   * The lockout invariant applies here for the same reason it applies to deactivate: this is the
   * other route that can reduce the set of people who hold `auth.users.manage`.
   */
  @RequirePermission(ROLES_MANAGE, "hospital")
  @Delete(":id/roles/:assignmentId")
  @HttpCode(204)
  async revoke(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Param("assignmentId") assignmentId: string,
  ): Promise<void> {
    await withTx(this.db, async (tx) => {
      await assertNoAdminLockout(tx, { assignmentId });
      const removed = await revokeRoleAssignment(tx, assignmentId);
      if (removed === null) throw new NotFoundException({ code: "assignment_not_found" });
      // The id in the PATH must be the assignment's actual owner. Without this check a caller
      // could revoke anybody's assignment by naming any user, and the audit row would then record
      // a revocation against a person it never touched.
      if (removed.userId !== id) {
        throw new NotFoundException({
          code: "assignment_not_found",
          message: "that assignment does not belong to that user",
        });
      }
      await appendEvent(
        tx,
        roleRevoked.make({
          actor,
          payload: {
            assignmentId: removed.id, userId: removed.userId, roleKey: removed.roleKey,
            scopeType: removed.scopeType, scopeId: removed.scopeId,
          },
        }),
      );
    });
  }
}
