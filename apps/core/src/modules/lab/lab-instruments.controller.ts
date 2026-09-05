import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { parsed, toHttp } from "./lab-http";
import { instrumentWorklist, LAB_INSTRUMENTS_READ, listInstruments } from "./instruments";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PLAN 17-E T2 — THE ROUTE THE BRIDGE PULLS ═══
 *
 * `GET /lab/instruments` — the register, for a screen.
 * `GET /lab/instruments/:instrumentId/worklist?sampleId=S…` — what to run on this tube.
 *
 * Modelled on 18b's `radiology-mwl.controller.ts` deliberately: **a route the bridge PULLS**, not a
 * file a worker consumer writes into a directory that does not exist until somebody buys a host.
 * The same reasoning applies here for a smaller reason — the bench PC is not this repository's
 * deployment target and never will be.
 *
 * ═══ THE BRIDGE IS A SERVICE **USER**, NOT AN AGENT — AND THAT IS NOT A PREFERENCE ═══
 *
 * This phase's D2 first said the bridge would authenticate as an agent, because `agents` +
 * `api_key_hash` + `kill_switch` already exist. It cannot: `kernel/auth/guards.ts` throws
 * `ForbiddenException("agents hold no permissions yet")` for any non-user actor BEFORE it reaches
 * `hasPermission`, so an agent cannot pass `@RequirePermission` at all. The agent-permission table
 * is a declared Plan 12 seam that has not shipped.
 *
 * 18b had already met this and answered it: `modality_bridge` is a role holding exactly one
 * permission, and its title in `seed-roles.ts` says what it is — *"a MACHINE account: pulls the
 * worklist export; holds nothing else"*. `lab_bridge` is the same shape.
 *
 * `lab.instruments.read` is therefore SEPARATE from `lab.instruments.manage`. A machine account that
 * could also register machines and re-map codes could rename any test it reports.
 */
const worklistQuery = z.object({ sampleId: z.string().min(1).max(32) });

@Controller("lab")
export class LabInstrumentsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The register — a screen's read. Held by the lab head, not by the bridge. */
  @Get("instruments")
  @RequirePermission("lab.instruments.manage", "hospital")
  async register(): Promise<unknown> {
    try {
      return { items: await listInstruments(this.db) };
    } catch (e) { toHttp(e); }
  }

  /**
   * WHAT THIS ANSWER DOES NOT CARRY IS THE POINT: no patient name, no UHID, no date of birth, no
   * diagnosis, no order number. An analyser needs a test list, and a bench PC speaking ASTM in clear
   * text on a flat hospital LAN is the last place in the building to put PHI.
   */
  @Get("instruments/:instrumentId/worklist")
  @RequirePermission(LAB_INSTRUMENTS_READ, "hospital")
  async worklist(
    @CurrentActor() actor: Actor,
    @Param("instrumentId") instrumentId: string,
    @Query() raw: unknown,
  ): Promise<unknown> {
    const q = parsed(worklistQuery, raw);
    try {
      return await instrumentWorklist(this.db, actor, { instrumentId, sampleId: q.sampleId });
    } catch (e) { toHttp(e); }
  }
}
