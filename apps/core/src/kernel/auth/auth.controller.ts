import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, HttpException, Inject,
  Param, Post, Req, Res, UnauthorizedException,
} from "@nestjs/common";
import type { Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { CONFIG, DB } from "../tokens";
import {
  loginWithPassword, revokeOtherUserSessions, revokeSession, switchWithBadge, switchWithPin,
} from "./sessions";
import { setPassword, verifyPassword } from "./identity";
import { checkPassword } from "./password-policy";
import { clearThrottle, recordThrottleFailure, throttleRetryAt } from "./throttle";
import type { ThrottleKind } from "./throttle";
import { confirmTotp, enrollTotp, recordSecondFactor, verifyTotpCode } from "./totp";
import { useBreakGlass, pendingReviews, recordReview } from "./break-glass";
import { grantTempRole, emergencyElevate } from "./temp-roles";
import { CurrentActor, Public, RequirePermission, AuthedRequest } from "./decorators";
import { users } from "../db/schema";
import { withTx } from "../db/client";
import { appendEvent } from "../events/append";
import { userPasswordChanged } from "./events";
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

  /**
   * PLAN 11g / DD4 — THE GUARD IN FRONT OF THE TWO CREDENTIAL PATHS.
   *
   * Consulted BEFORE verification, so a throttled attempt costs no argon2 — which also means the
   * refusal cannot be timed against a real verification to learn anything.
   *
   * `Retry-After` is a real header, not only a body field, because the standard one is what a
   * browser, a proxy and a future mobile client all already understand. `@Res({ passthrough: true })`
   * lets the header be set on the response that Nest's own exception filter then writes the body
   * onto; the handler still RETURNS its value normally.
   */
  private async refuseIfThrottled(res: Response, kind: ThrottleKind, username: string): Promise<void> {
    const retryAt = await throttleRetryAt(this.db, kind, username, new Date());
    if (retryAt === null) return;
    const seconds = Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1000));
    res.setHeader("Retry-After", String(seconds));
    throw new HttpException(
      {
        statusCode: 429,
        code: "too_many_attempts",
        message: `too many failed attempts — try again in ${seconds}s`,
        retryAfterSeconds: seconds,
      },
      429,
    );
  }

  @Public()
  @Post("login")
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<{ token: string }> {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    await this.refuseIfThrottled(res, "login", parsed.data.username);
    const result = await loginWithPassword(this.db, this.cfg, parsed.data);
    if (!result) {
      // The failure is counted AFTER the shipped verification has said no, and the 401 it produces
      // is byte-identical to the one it always produced: the throttle changes what happens on the
      // SIXTH attempt, never what a wrong password looks like on the first.
      await recordThrottleFailure(this.db, "login", parsed.data.username, new Date());
      throw new UnauthorizedException();
    }
    await clearThrottle(this.db, "login", parsed.data.username);
    return result;
  }

  @Public()
  @Post("switch/pin")
  async switchPin(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<{ token: string }> {
    const parsed = pinSwitchSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    // A separate `kind` from `login` on purpose: a poisoned password counter must not be able to
    // close the terminal switch, which is the path a clinician uses at a shared desk mid-shift.
    // It is also the sharper of the two keyspaces — a four-digit pin is 10,000 values.
    await this.refuseIfThrottled(res, "pin", parsed.data.username);
    const result = await switchWithPin(this.db, this.cfg, parsed.data);
    if (!result) {
      await recordThrottleFailure(this.db, "pin", parsed.data.username, new Date());
      throw new UnauthorizedException();
    }
    await clearThrottle(this.db, "pin", parsed.data.username);
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

    // ONE TRANSACTION for the write, the revoke and the audit row (11e T3/D2): a
    // `user.password_changed` that could be appended without the password having changed, or a
    // change with no audit row, are both states nobody could later reason about.
    await withTx(this.db, async (tx) => {
      await setPassword(tx, actor.id, parsed.data.newPassword, { mustChangePassword: false });
      const otherSessionsRevoked = await revokeOtherUserSessions(tx, actor.id, session.sessionId);
      await appendEvent(
        tx,
        userPasswordChanged.make({ actor, payload: { userId: actor.id, username, otherSessionsRevoked } }),
      );
    });
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
