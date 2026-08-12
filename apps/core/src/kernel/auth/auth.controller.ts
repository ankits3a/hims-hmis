import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, Param, Post, Req,
  UnauthorizedException,
} from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { CONFIG, DB } from "../tokens";
import { loginWithPassword, revokeSession, switchWithBadge, switchWithPin } from "./sessions";
import { confirmTotp, enrollTotp, recordSecondFactor, verifyTotpCode } from "./totp";
import { useBreakGlass, pendingReviews, recordReview } from "./break-glass";
import { grantTempRole, emergencyElevate } from "./temp-roles";
import { CurrentActor, Public, RequirePermission, AuthedRequest } from "./decorators";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  terminalId: z.string().min(1).optional(),
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
