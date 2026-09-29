import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { prepBayList, prepStudyView } from "./prep-bay";
import { decideGateOverride, gateOverrideRequests } from "./override-requests";
import { parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS5 — **THE PREP & SAFETY BAY over HTTP, and the radiologist's override queue.**
 *
 *   · `GET /radiology/prep` and `GET /radiology/prep/studies/:studyId` — the bay's list and the
 *     patient in hand, on `radiology.gates.satisfy`: the bay is the people who clear gates, and the
 *     read carries allergies, a creatinine and an LMP, which the desk has no reason to see.
 *   · `GET /radiology/gate-override-requests` and `POST …/:approvalId/decide` — the radiologist's
 *     side of "Ask the radiologist", on `radiology.gates.override` (the radiologist's alone). The
 *     REQUEST is filed on the study console's controller, next to satisfy / waive / override.
 */
const decideBody = z.object({
  verdict: z.enum(["grant", "refuse"]),
  reason: z.string().min(1).max(400),
});

@Controller("radiology")
export class RadiologyPrepController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("prep")
  @RequirePermission("radiology.gates.satisfy", "hospital")
  async list(@CurrentActor() actor: Actor): Promise<unknown> {
    try {
      return { rows: await prepBayList(this.db, actor) };
    } catch (e) { toHttp(e); }
  }

  @Get("prep/studies/:studyId")
  @RequirePermission("radiology.gates.satisfy", "hospital")
  async study(@CurrentActor() actor: Actor, @Param("studyId") studyId: string): Promise<unknown> {
    try {
      return { view: await prepStudyView(this.db, actor, studyId) };
    } catch (e) { toHttp(e); }
  }

  @Get("gate-override-requests")
  @RequirePermission("radiology.gates.override", "hospital")
  async requests(
    @CurrentActor() actor: Actor, @Query("studyId") studyId?: string,
  ): Promise<unknown> {
    try {
      return {
        requests: await gateOverrideRequests(this.db, actor, studyId === undefined ? {} : { studyId }),
      };
    } catch (e) { toHttp(e); }
  }

  /** The radiologist's decision. `grant` runs the EXISTING override with this reason. */
  @Post("gate-override-requests/:approvalId/decide")
  @RequirePermission("radiology.gates.override", "hospital")
  async decide(
    @CurrentActor() actor: Actor, @Param("approvalId") approvalId: string, @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(decideBody, body);
    try {
      return await decideGateOverride(this.db, actor, { approvalId, verdict: input.verdict, reason: input.reason });
    } catch (e) { toHttp(e); }
  }
}
