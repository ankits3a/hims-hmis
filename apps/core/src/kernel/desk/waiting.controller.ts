import { Controller, Get, Inject } from "@nestjs/common";
import type { Actor, WireWaiting } from "@hmis/contracts";
import { DB, MODULE_REGISTRY } from "../tokens";
import { istDayString as istDay } from "../approvals/cumulative";
import { CurrentActor } from "../auth/decorators";
import { collectDeskProviders } from "./registry";
import { loadWaiting } from "./waiting";
import type { ModuleRegistry } from "../modules/loader";
import type { Db } from "../db/client";

/**
 * E1.4 / E1.5 (decision 0064) — `GET /me/waiting`: what is waiting on the person asking.
 *
 * `/me/…` with no `userId`, for the reason `/me/report` gives: there is nowhere to put somebody
 * else's id. No `@RequirePermission`, for the reason `/me/desk` gives: the route describes the
 * caller, every line is gated by its provider's own permission inside `loadWaiting`, and the answer
 * for somebody who holds nothing is an empty list. It takes no date, so the history horizon has
 * nothing to cap (it is not in `horizon-census.test.ts`'s list, and needs not be).
 *
 * The phone home card, the phone's Open loops screen and the web's My day all read this one route
 * and draw it through `waitingLines()` (packages/contracts/src/waiting.ts).
 */
@Controller("me")
export class WaitingController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  @Get("waiting")
  async waiting(@CurrentActor() actor: Actor): Promise<WireWaiting> {
    if (actor.type !== "user") return { items: [] };
    const now = new Date();
    const providers = collectDeskProviders(this.registry);
    return loadWaiting(providers, { db: this.db, actor, reader: actor, date: istDay(now), now });
  }
}
