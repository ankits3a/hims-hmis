import { BadRequestException, Controller, ForbiddenException, Get, Inject, Query } from "@nestjs/common";
import { z } from "zod";
import { parseSearchQuery } from "@hmis/contracts";
import type { Actor, SearchResponse } from "@hmis/contracts";
import { DB, MODULE_REGISTRY } from "../tokens";
import { CurrentActor } from "../auth/decorators";
import { searchAll } from "./registry";
import { SearchError } from "./types";
import type { ModuleRegistry } from "../modules/loader";
import type { Db } from "../db/client";

const searchQuery = z.object({
  q: z.string(),
  limit: z.coerce.number().int().positive().max(50).optional(),
  /** Narrow the fan-out to named entity classes — the palette's "show all" for one group. */
  entities: z.string().optional(),
});

/**
 * PLAN 11h T1 — `GET /api/search`.
 *
 * THE ROUTE CARRIES NO `@RequirePermission`, AND THAT IS A DECISION.
 *
 * Every role searches: a search permission would have to be granted to every role that exists,
 * which makes it a permission that says nothing and one more thing a go-live runbook can forget —
 * the exact trap `kernel/alerts/manifest.ts` records ("the cashier holds no tariff.read") and the
 * same reason `GET /ops/mode` is authenticated-only. The REAL gate is per provider and it is
 * declared: `searchAll` runs only those whose permission the caller holds, and a caller holding
 * nothing gets an empty answer with every provider named in `skipped`.
 *
 * The AuthGuard still runs — this is not `@Public`. An unauthenticated call is 401 as usual.
 */
@Controller("search")
export class SearchController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  @Get()
  async search(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<SearchResponse> {
    const parsedInput = searchQuery.safeParse(query);
    if (!parsedInput.success) throw new BadRequestException(parsedInput.error.issues[0]?.message ?? "invalid query");
    const { q, limit, entities } = parsedInput.data;
    try {
      return await searchAll(this.db, this.registry, actor, parseSearchQuery(q, limit ?? 20), {
        perEntity: limit,
        entities: entities === undefined ? undefined : entities.split(",").map((e) => e.trim()).filter(Boolean),
      });
    } catch (e) {
      // An agent actor reaching a desk surface is a 403, not a 500: the actor authenticated fine,
      // it simply is not the kind of actor this surface serves (the `searchPatients` precedent).
      if (e instanceof SearchError && e.code === "user_actor_required") throw new ForbiddenException(e.message);
      throw e;
    }
  }
}
