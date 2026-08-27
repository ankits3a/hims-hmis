import {
  BadRequestException, ConflictException, Controller, Get, Inject, NotFoundException, Param, Query,
} from "@nestjs/common";
import { z } from "zod";
import { DB } from "../tokens";
import { RequirePermission } from "../auth/decorators";
import { ResourceError, resourceHttpStatus } from "./errors";
import { RESOURCES_READ } from "./manifest";
import { resourceBoard, resourceHistory, resourceTree } from "./read";
import type { Db } from "../db/client";
import type { ResourceBoardRow, ResourceHistoryRow, ResourceNode } from "./read";

/**
 * PLAN 13 T5 — THE REGISTRY'S HTTP SURFACE. Three routes, all reads, all `resources.read`.
 *
 * ═══ THE PERMISSION SHAPE, AND IT IS A DECISION RATHER THAN A DEFAULT (DD14) ═══
 *
 *   GET /resources/tree          resources.read (hospital)
 *   GET /resources/board         resources.read (hospital)
 *   GET /resources/:id/history   resources.read (hospital)
 *
 * **Hospital scope, not `floor`**, and the near-miss is worth naming because `PermissionScope`'s
 * three values include one called `floor` and this registry's tree has a KIND called `floor`. They
 * are unrelated: the scope is the authority's reach, the kind is a row in a table. A registry that
 * scoped its reads by floor would make the tree unreadable above the level a grant names, which is
 * the opposite of what a tree is for.
 *
 * ONE permission, granted to `opd_admin` alone — the role that reads the room book today, so **no
 * new authority is created**. There is deliberately no `resources.manage` and there is no write
 * route: master writes for rooms continue through OPD's existing `opd.masters.manage` routes, which
 * delegate into the registry from T6 (DD9). `seed-roles.test.ts:160` records the trap of a
 * permission *"declared, guarding a LIVE route, and held by nobody"*; a `manage` permission
 * guarding NO route is the same defect seen from the other side, and this controller does not ship
 * one.
 *
 * These three reads DO mint a permission where `GET /ops/mode` deliberately does not, and the
 * difference is which screens need them: the mode banner renders on EVERY screen, so an
 * `ops.mode.read` would have to be held by every seeded role. A resource tree renders on an admin
 * surface for whoever administers places. One holder, not sixteen.
 *
 * ═══ THE HONEST HALF, SO CLOSE CANNOT BE WRITTEN AS IF IT WERE OTHERWISE (DD14) ═══
 *
 * **These three routes have no caller in this phase.** No screen renders them and this phase adds
 * none — the SPA route census stays at 25. Their first consumer is Plan 15. The registry's value
 * THIS phase is that the OPD floor's rooms stop being private (T6/T7); everything here is
 * forward-looking, and 16a's precedent is to say so rather than to let a green e2e suite read as
 * live traffic.
 */

/**
 * `ResourceError` → HTTP, from the SAME table the module's own `resourceHttpStatus` uses.
 *
 * Plan 09 shipped the bug that makes this worth a comment: a `MembershipError` escaped
 * `billing.controller.ts`'s `toHttp`, which had a clause for every other module's error and none
 * for that one, so a correct refusal reached a busy counter as a 500.
 *
 * Only `unknown_resource` is reachable from these three routes today — every other code in the
 * union is thrown by the WRITE surface, which has no route (DD14), or at boot. The mapper handles
 * the whole union anyway: a mapper with a hole is a 500 waiting for the day somebody adds a route.
 */
function toHttp(e: unknown): never {
  if (e instanceof ResourceError) {
    const body = { code: e.code, detail: e.detail ?? null, message: e.message };
    // CLOSE / M4 — READ FROM `resourceHttpStatus`, NEVER RESTATE IT. This function shipped with a
    // hand-rolled copy of the same 404/400/409 conditionals, which is precisely the second copy
    // `errors.ts` exports that mapper to prevent (§2.54, and the Plan 09 escape its header cites).
    // They agreed, which is what made it a latent defect rather than a live one. One table now.
    switch (resourceHttpStatus(e.code)) {
      case 404: throw new NotFoundException(body);
      case 400: throw new BadRequestException(body);
      default: throw new ConflictException(body);
    }
  }
  throw e; // anything unrecognised is a genuine bug: 500, loudly
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}

/**
 * `depth` arrives as a query STRING and is coerced here rather than trusted. The upper bound is
 * `MAX_RESOURCE_DEPTH`'s job and `resourceTree` clamps to it (see `read.ts`) — this schema's `.max`
 * is deliberately absent, because a bound duplicated at the edge is a second copy of the same fact
 * (§2.54) and the in-process callers Plan 15 brings would walk straight past it.
 */
const treeQuery = z.object({
  rootId: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  siteId: z.string().min(1).optional(),
  depth: z.coerce.number().int().positive().optional(),
});

const boardQuery = z.object({
  kind: z.string().min(1),
  parentId: z.string().min(1).optional(),
  siteId: z.string().min(1).optional(),
});

const historyQuery = z.object({ limit: z.coerce.number().int().positive().max(500).optional() });

@Controller("resources")
export class ResourcesController {
  /**
   * `DB` only. **AuthGuard and PermissionGuard are global `APP_GUARD`s registered ONCE by
   * `AuthModule` and their order is load-bearing** (Plan 02) — `resources.module.ts` registers
   * neither, and `ops.module.ts` says why in as many words: a second registration would run a
   * permission check against a request whose actor the first guard has not attached.
   */
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The tree, depth-capped and cycle-safe. `read.ts`'s header argues the shape. */
  @Get("tree")
  @RequirePermission(RESOURCES_READ, "hospital")
  async tree(@Query() query: unknown): Promise<{ roots: ResourceNode[] }> {
    const q = parsed(treeQuery, query);
    try {
      return { roots: await resourceTree(this.db, q) };
    } catch (e) {
      toHttp(e);
    }
  }

  /** One parent's direct children of one kind, flat, carrying the occupancy triad. §11.2's bed board. */
  @Get("board")
  @RequirePermission(RESOURCES_READ, "hospital")
  async board(@Query() query: unknown): Promise<{ rows: ResourceBoardRow[] }> {
    const q = parsed(boardQuery, query);
    try {
      return { rows: await resourceBoard(this.db, q) };
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * One resource's transitions, oldest first by `seq`.
   *
   * **An unknown id answers 200 with an empty list, not 404**, and that is a decision: this is a
   * SUB-RESOURCE read, `resourceHistory` cannot distinguish "no such resource" from "no transitions
   * yet" without a second query, and a resource legitimately has an empty history only in the
   * instant before its creation row lands. The e2e leg below pins the choice so it reads as chosen.
   */
  @Get(":id/history")
  @RequirePermission(RESOURCES_READ, "hospital")
  async history(@Param("id") id: string, @Query() query: unknown): Promise<{ rows: ResourceHistoryRow[] }> {
    const q = parsed(historyQuery, query);
    try {
      return { rows: await resourceHistory(this.db, id, q) };
    } catch (e) {
      toHttp(e);
    }
  }
}
