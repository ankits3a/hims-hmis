import {
  BadRequestException, Body, Controller, Delete, HttpCode, Inject, NotFoundException, Param, Post,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { DB } from "../tokens";
import { CurrentActor, RequirePermission } from "./decorators";
import { withTx } from "../db/client";
import { appendEvent } from "../events/append";
import { roles, users } from "../db/schema";
import { assignRole, revokeRoleAssignment } from "./permissions";
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
 * credential), the other governs the AUTHORITY (what may this person do). A hospital can
 * reasonably give the front-office supervisor the first and keep the second with the owner. Two
 * controllers make that split legible from the file names; one controller carrying both would put
 * the route→permission map back where §3.42's defect hid — in a column of decorators nobody reads
 * together. `test/user-admin.e2e.test.ts` legs 1-4 read them together, by execution.
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
