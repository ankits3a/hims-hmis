import { Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post } from "@nestjs/common";
import { DB } from "../tokens";
import { CurrentActor } from "../auth/decorators";
import { AlertsError, listAlerts, markAlertRead } from "./alerts";
import type { Actor } from "@hmis/contracts";
import type { AlertRow } from "./alerts";
import type { Db } from "../db/client";

/** Alerts errors → HTTP (Plan 03's toHttp convention). Anything unrecognized rethrows: a 500 is a genuine bug, loudly. */
function toHttp(e: unknown): never {
  if (e instanceof AlertsError && e.code === "unknown_alert") throw new NotFoundException(e.message);
  throw e;
}

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
}
