import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Post,
} from "@nestjs/common";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import { CONFIG, DB } from "../tokens";
import { CurrentActor } from "../auth/decorators";
import { withTx } from "../db/client";
import { REACH_CHANNELS, REACH_LANGUAGES } from "../db/schema/reach";
import { readReachSettings, saveReachProfile, subscribeToPush, unsubscribeFromPush } from "./reach-settings";
import type { ReachSettings } from "./reach-settings";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

/**
 * ═══ PHASE O T4 — A PERSON'S OWN REACH SETTINGS, AND NOBODY ELSE'S ═══
 *
 * Neither `@Public` nor `@RequirePermission`, exactly like the alerts routes and for the same
 * reason (D6): these are yours BECAUSE THEY ARE YOURS, not because you hold a role. Minting a
 * `reach.own.manage` permission would oblige every seeded role to hold it, which is the trap
 * behind "the cashier holds no tariff.read".
 *
 * `requireUserActor` is the whole access model, and it is a function call rather than a
 * decorator for the reason `alerts.controller.ts` spells out: an agent key passes `AuthGuard`
 * and a permissionless route passes `PermissionGuard`, so the handler is the only place the
 * refusal can live. A person's ladder and their browsers are theirs alone.
 */
function requireUserActor(actor: Actor): string {
  if (actor.type !== "user") throw new ForbiddenException("user_actor_required");
  return actor.id;
}

const profileBody = z.object({
  language: z.enum(REACH_LANGUAGES).optional(),
  ladder: z.array(z.enum(REACH_CHANNELS)).min(1).max(REACH_CHANNELS.length).optional(),
});

const subscribeBody = z.object({
  endpoint: z.string().url().max(2000),
  p256dh: z.string().min(1).max(500),
  auth: z.string().min(1).max(500),
  userAgent: z.string().max(500).optional(),
});

const unsubscribeBody = z.object({ endpoint: z.string().url().max(2000) });

@Controller("me/reach")
export class ReachController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Null when push is on the console sink — the page says "not configured" rather than failing. */
  private vapidPublicKey(): string | null {
    return this.cfg.webPushVapid?.publicKey ?? null;
  }

  @Get()
  async read(@CurrentActor() actor: Actor): Promise<ReachSettings> {
    const userId = requireUserActor(actor);
    return withTx(this.db, (tx) => readReachSettings(tx, userId, this.vapidPublicKey()));
  }

  /**
   * A PARTIAL update: the screen sends only what the person changed. `quiet_exempt`,
   * `shared_phone` and `consent_at` are deliberately NOT settable here — the first two are
   * hospital facts about a seat and a handset rather than preferences, and consent is captured
   * at onboarding with its wording, not toggled on a settings page.
   */
  @Post()
  async save(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<ReachSettings> {
    const userId = requireUserActor(actor);
    const parsed = profileBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return withTx(this.db, (tx) => saveReachProfile(tx, userId, parsed.data, this.vapidPublicKey()));
  }

  @Post("push")
  async subscribe(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ subscriptionId: string }> {
    const userId = requireUserActor(actor);
    const parsed = subscribeBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return withTx(this.db, (tx) => subscribeToPush(tx, userId, { id: newId(), ...parsed.data }));
  }

  @Post("push/revoke")
  async unsubscribe(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ revoked: number }> {
    const userId = requireUserActor(actor);
    const parsed = unsubscribeBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return withTx(this.db, (tx) => unsubscribeFromPush(tx, userId, parsed.data.endpoint));
  }
}
