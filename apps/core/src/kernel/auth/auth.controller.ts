import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, Param, Post, Req,
  UnauthorizedException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { CONFIG, DB } from "../tokens";
import {
  loginWithPassword, revokeOtherUserSessions, revokeSession, switchWithBadge, switchWithPin,
} from "./sessions";
import { setPassword, verifyPassword } from "./identity";
import { checkPassword } from "./password-policy";
import { confirmTotp, enrollTotp, recordSecondFactor, verifyTotpCode } from "./totp";
import { useBreakGlass, pendingReviews, recordReview } from "./break-glass";
import { grantTempRole, emergencyElevate } from "./temp-roles";
import { CurrentActor, Public, RequirePermission, AuthedRequest } from "./decorators";
import { users } from "../db/schema";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

/**
 * `min(1)` STAYS, AND IT IS A DECISION (11e D3). Login VERIFIES a credential that already exists;
 * a floor here would lock out precisely the people the reset flow exists to save — every account
 * whose password predates `password-policy.ts`, which on the live box is all sixteen of them. The
 * floor lives where a human CHOOSES a credential, and this is not that place.
 */
const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  terminalId: z.string().min(1).optional(),
});

/**
 * PLAN 11e T2/D2 — self-service change-password: authenticated, NO permission, and one of the two
 * routes `AuthGuard` admits while `must_change_password` is set (`guards.ts`).
 *
 * `min(1)` on both fields for the same reason as `loginSchema`: `currentPassword` is VERIFIED
 * rather than chosen, and `newPassword`'s floor is the shared policy's — applied in the handler,
 * where a refusal can name every clause the password broke instead of zod's first one.
 */
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});
const pinSwitchSchema = z.object({
  username: z.string().min(1),
  pin: z.string().min(4),
  terminalId: z.string().min(1),
});
const badgeSwitchSchema = z.object({
  badgeToken: z.string().min(1),
  terminalId: z.string().min(1),
});

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Public()
  @Post("login")
  async login(@Body() body: unknown): Promise<{ token: string }> {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const result = await loginWithPassword(this.db, this.cfg, parsed.data);
    if (!result) throw new UnauthorizedException();
    return result;
  }

  @Public()
  @Post("switch/pin")
  async switchPin(@Body() body: unknown): Promise<{ token: string }> {
    const parsed = pinSwitchSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const result = await switchWithPin(this.db, this.cfg, parsed.data);
    if (!result) throw new UnauthorizedException();
    return result;
  }

  @Public()
  @Post("switch/badge")
  async switchBadge(@Body() body: unknown): Promise<{ token: string }> {
    const parsed = badgeSwitchSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const result = await switchWithBadge(this.db, this.cfg, parsed.data);
    if (!result) throw new UnauthorizedException();
    return result;
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest): Promise<void> {
    if (req.hmisSession) await revokeSession(this.db, req.hmisSession.sessionId);
  }

  /**
   * PLAN 11e T2 — THE ROUTE THAT ENDS PERMANENT LOCKOUT'S OTHER HALF.
   *
   * `POST /admin/users/:id/password-reset` (T3) lets an admin repair somebody. THIS is how the
   * person repaired then takes their credential back, and how anybody changes a password they
   * merely dislike. No permission: every authenticated human may change their own password, and
   * requiring a grant for it would put the least privileged user — the one most likely to be
   * handed a temporary password — behind the exact door this phase exists to open.
   *
   * FOUR THINGS HAPPEN, AND THE ORDER IS THE POINT:
   *   1. the CURRENT password is verified. A session token is not consent to replace the
   *      credential that opens it — an unattended terminal is the whole threat here, and R5's
   *      mutant is a handler that validates the new password and skips this line.
   *   2. the new one is judged by the shared policy, which also refuses the username;
   *   3. it is written and `must_change_password` is CLEARED — this is the only act that clears it;
   *   4. every OTHER session of this user is revoked. A password change is what somebody does when
   *      they think a credential leaked, so the other terminals it may be signed in on must die —
   *      but not THIS one, or the person who just fixed their account would be thrown out of it.
   */
  @Post("change-password")
  @HttpCode(204)
  async changePassword(@Req() req: AuthedRequest, @Body() body: unknown): Promise<void> {
    const parsed = changePasswordSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = req.hmisActor;
    const session = req.hmisSession;
    if (!actor || actor.type !== "user" || !session) {
      throw new ForbiddenException("change-password is for human users");
    }

    const rows = await this.db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, actor.id));
    // The username is needed twice: `verifyPassword` is keyed by it, and the policy refuses it.
    const username = rows[0]?.username;
    if (username === undefined) throw new UnauthorizedException();
    if ((await verifyPassword(this.db, username, parsed.data.currentPassword)) === null) {
      // 403 rather than 400: the request was well-formed and the caller is authenticated — what
      // failed is proof of possession. Nothing has been written at this point, and R5 asserts that
      // by reading the flag and the session count back afterwards.
      throw new ForbiddenException("current_password_incorrect");
    }

    const problems = checkPassword(parsed.data.newPassword, { username });
    if (problems.length > 0) {
      throw new BadRequestException({ code: "password_policy", problems });
    }

    await setPassword(this.db, actor.id, parsed.data.newPassword, { mustChangePassword: false });
    await revokeOtherUserSessions(this.db, actor.id, session.sessionId);
  }

  @Get("me")
  me(@CurrentActor() actor: Actor): { actor: Actor } {
    return { actor };
  }

  @Post("totp/enroll")
  async totpEnroll(@CurrentActor() actor: Actor): Promise<{ otpauthUrl: string }> {
    if (actor.type !== "user") throw new ForbiddenException();
    const { otpauthUrl } = await enrollTotp(this.db, this.cfg, actor.id);
    return { otpauthUrl };
  }

  @Post("totp/confirm")
  @HttpCode(204)
  async totpConfirm(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<void> {
    const parsed = z.object({ code: z.string().min(6) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    if (actor.type !== "user" || !(await confirmTotp(this.db, this.cfg, actor.id, parsed.data.code))) {
      throw new ForbiddenException("invalid code");
    }
  }

  @Post("totp/verify")
  @HttpCode(204)
  async totpVerify(@Req() req: AuthedRequest, @Body() body: unknown): Promise<void> {
    const parsed = z.object({ code: z.string().min(6) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = req.hmisActor;
    if (!actor || actor.type !== "user" || !req.hmisSession) throw new ForbiddenException();
    if (!(await verifyTotpCode(this.db, this.cfg, actor.id, parsed.data.code))) {
      throw new ForbiddenException("invalid code");
    }
    await recordSecondFactor(this.db, req.hmisSession.sessionId);
  }

  @RequirePermission("auth.break_glass.use", "hospital")
  @Post("break-glass")
  async breakGlass(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ): Promise<{ grantId: string; expiresAt: string }> {
    const parsed = z.object({ patientId: z.string().min(1).optional(), reason: z.string().min(3) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { grantId, expiresAt } = await useBreakGlass(this.db, this.cfg, actor, parsed.data);
    return { grantId, expiresAt: expiresAt.toISOString() };
  }

  @RequirePermission("auth.break_glass.review", "hospital")
  @Get("break-glass/pending")
  async breakGlassPending(): Promise<{ items: Awaited<ReturnType<typeof pendingReviews>> }> {
    return { items: await pendingReviews(this.db) };
  }

  @RequirePermission("auth.break_glass.review", "hospital")
  @Post("break-glass/:id/review")
  @HttpCode(204)
  async breakGlassReview(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = z.object({ note: z.string().min(1) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    await recordReview(this.db, id, actor, parsed.data.note);
  }

  @RequirePermission("auth.temp_role.grant", "hospital")
  @Post("temp-roles")
  async tempRole(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ grantId: string; expiresAt: string }> {
    const parsed = z.object({
      userId: z.string().min(1), roleKey: z.string().min(1),
      reason: z.string().min(3), ttlMinutes: z.number().int().positive(),
    }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { grantId, expiresAt } = await grantTempRole(this.db, this.cfg, actor, parsed.data);
    return { grantId, expiresAt: expiresAt.toISOString() };
  }

  @Post("emergency-elevation")
  async emergencyElevation(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ grantId: string; expiresAt: string }> {
    const parsed = z.object({
      roleKey: z.string().min(1), reason: z.string().min(3), ttlMinutes: z.number().int().positive(),
    }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    if (actor.type !== "user") throw new ForbiddenException("emergency elevation is for human users");
    const { grantId, expiresAt } = await emergencyElevate(this.db, this.cfg, actor, parsed.data);
    return { grantId, expiresAt: expiresAt.toISOString() };
  }
}
