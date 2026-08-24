import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Post, Query,
} from "@nestjs/common";
import { z } from "zod";
import { parseSearchQuery } from "@hmis/contracts";
import type { Actor, SearchEntity, SearchResponse } from "@hmis/contracts";
import { DB, MODULE_REGISTRY } from "../tokens";
import { CurrentActor } from "../auth/decorators";
import { searchAll } from "./registry";
import { recordOpen, recordSearch } from "./audit";
import { SearchError } from "./types";
import type { ModuleRegistry } from "../modules/loader";
import type { Db } from "../db/client";

const openedBody = z.object({
  auditId: z.string().min(1),
  entity: z.string().min(1),
  id: z.string().min(1),
});

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
  async search(@CurrentActor() actor: Actor, @Query() queryParams: unknown): Promise<SearchResponse & { auditId: string }> {
    const parsedInput = searchQuery.safeParse(queryParams);
    if (!parsedInput.success) throw new BadRequestException(parsedInput.error.issues[0]?.message ?? "invalid query");
    const { q, limit, entities } = parsedInput.data;
    const query = parseSearchQuery(q, limit ?? 20);
    try {
      const response = await searchAll(this.db, this.registry, actor, query, {
        perEntity: limit,
        entities: entities === undefined ? undefined : entities.split(",").map((e) => e.trim()).filter(Boolean),
      });
      /**
       * THE AUDIT IS AWAITED, NOT FIRED AND FORGOTTEN (T5/DD4). It costs one INSERT against the
       * §15 300 ms budget, and the alternative — letting the response race the log — means the
       * rows that go missing are exactly the ones a crash or a shutdown would have made
       * interesting. An access log that is best-effort is not an access log.
       *
       * A query too short to run still returns an empty response, and that response is still
       * recorded: "typed three letters, saw nothing, moved on" is a real observation.
       */
      const { auditId } = await recordSearch(this.db, { actor, query, response });
      return { ...response, auditId };
    } catch (e) {
      // An agent actor reaching a desk surface is a 403, not a 500: the actor authenticated fine,
      // it simply is not the kind of actor this surface serves (the `searchPatients` precedent).
      if (e instanceof SearchError && e.code === "user_actor_required") throw new ForbiddenException(e.message);
      throw e;
    }
  }

  /**
   * The palette calls this when a result is actually OPENED. Searching produces a haystack of
   * names a desk glanced at; the open is the moment a records-access enquiry asks about, and it is
   * the only place `search_audit` stores a reference to a specific record.
   *
   * 404 when the audit row is not this actor's, or already carries an open: an actor annotates
   * their OWN search, once. It is deliberately not an error the palette has to handle — a
   * re-render must never be able to rewrite which record was taken.
   */
  @Post("opened")
  @HttpCode(204)
  async opened(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<void> {
    const parsedBody = openedBody.safeParse(body);
    if (!parsedBody.success) throw new BadRequestException(parsedBody.error.issues[0]?.message ?? "invalid body");
    const { auditId, entity, id } = parsedBody.data;
    const { recorded } = await recordOpen(this.db, { auditId, actor, entity: entity as SearchEntity, id });
    if (!recorded) throw new NotFoundException("no open search of yours to annotate");
  }
}
