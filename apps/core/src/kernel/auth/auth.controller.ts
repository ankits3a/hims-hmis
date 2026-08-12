import {
  BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Req, UnauthorizedException,
} from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { CONFIG, DB } from "../tokens";
import { loginWithPassword, revokeSession, switchWithBadge, switchWithPin } from "./sessions";
import { CurrentActor, Public, AuthedRequest } from "./decorators";
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
}
