import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../tokens";
import { CurrentActor } from "../auth/decorators";
import { ALERT_ACK_KINDS } from "../db/schema";
import { AlertsError, acknowledgeAlert, listAlerts, markAlertRead } from "./alerts";
import type { Actor } from "@hmis/contracts";
import type { AcknowledgeResult, AlertRow } from "./alerts";
import type { Db } from "../db/client";

/** Alerts errors → HTTP (Plan 03's toHttp convention). Anything unrecognized rethrows: a 500 is a genuine bug, loudly. */
function toHttp(e: unknown): never {
  if (e instanceof AlertsError) {
    if (e.code === "unknown_alert") throw new NotFoundException(e.message);
    // The two states that are about the ROW rather than the request: somebody already handed
    // this on, or the owner has spent their two re-owns. A 409 says "the world moved", which is
    // what a bell should retell rather than "you typed it wrong".
    if (e.code === "already_handed_over" || e.code === "ack_limit") throw new ConflictException(e.message);
    throw new BadRequestException(e.message);
  }
  throw e;
}

/**
 * `untilMinutes` is capped at one working day. An unbounded cap would let one tap buy a year of
 * silence, which is G5's failure mode with a bigger number rather than a different one.
 */
const ackBody = z.object({
  kind: z.enum(ALERT_ACK_KINDS),
  untilMinutes: z.number().int().positive().max(24 * 60).optional(),
  note: z.string().max(500).optional(),
  handedToUserId: z.string().min(1).optional(),
  /** The badge number, for the bell: a user picker is T9's. Exactly one of the two, or neither. */
  handedToStaffCode: z.string().min(1).max(40).optional(),
});

/**
 * THE REFUSAL CANNOT LIVE IN A DECORATOR, and that is why it is a function call in both
 * handlers. Agent keys DO pass `AuthGuard` (guards.ts:31-38 mints an `{type:"agent"}` actor and
 * returns true), and `PermissionGuard` returns true at guards.ts:64 the moment the reflector
 * finds no requirement — so on a permissionless route an agent is authenticated and unchallenged.
 * A 403 raised here is the only thing between an agent key and another human's alert list.
 */
function requireUserActor(actor: Actor): string {
  if (actor.type !== "user") throw new ForbiddenException("user_actor_required");
  return actor.id;
}

/**
 * NEITHER @Public NOR @RequirePermission, deliberately (D6): a route that declares no
 * requirement is authenticated-only, so these are gated by AuthGuard alone and then scoped BY
 * IDENTITY inside. Your alerts are yours because they are addressed to you, not because you
 * hold a role — which avoids minting an `alerts.read` permission that every seeded role would
 * then need (the exact trap behind "the cashier holds no tariff.read"). The shipped precedents
 * for a permissionless authenticated route are `GET /auth/me` and `POST /auth/logout`.
 */
@Controller("alerts")
export class AlertsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@CurrentActor() actor: Actor): Promise<{ items: AlertRow[]; unreadCount: number }> {
    const userId = requireUserActor(actor);
    return listAlerts(this.db, userId);
  }

  @Post(":id/read")
  async markRead(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
  ): Promise<{ alertId: string; readAt: Date; alreadyRead: boolean }> {
    requireUserActor(actor);
    try {
      return await markAlertRead(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * Authenticated-only and identity-scoped like its two neighbours (D6): an alert is yours
   * because it is addressed to you, and `requireUserActor` is what keeps an agent key out —
   * the same 403 the other two handlers raise, for the same reason.
   */
  @Post(":id/ack")
  async ack(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<AcknowledgeResult> {
    requireUserActor(actor);
    const parsed = ackBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await acknowledgeAlert(this.db, actor, id, parsed.data);
    } catch (e) {
      toHttp(e);
    }
  }
}
