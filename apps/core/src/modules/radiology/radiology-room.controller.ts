import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { istDayString } from "../../kernel/approvals/cumulative";
import { recordRepeatExposure } from "./acquisition";
import { REPEAT_REASON_CODES } from "./events";
import { roomRejects, roomView } from "./room";
import { idSchema, parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS6 — **THE MODALITY ROOMS, OVER HTTP.** Two reads and one act, all on
 * `radiology.acquire` — the technologist's permission, which the radiographer and the radiologist
 * hold and the desk does not (18a T7's separation, unchanged).
 *
 *   · `GET /radiology/studies/:id/room` — the console's read (`room.ts`);
 *   · `POST /radiology/studies/:id/acquisition/repeat` — a retaken exposure with its reason code;
 *     raises `repeat_no_charge` once per study (`recordRepeatExposure`);
 *   · `GET /radiology/room/rejects?from&to` — the reject analysis (IST days, inclusive; default the
 *     last seven).
 */
const repeatBody = z.object({ reason: z.enum(REPEAT_REASON_CODES) }).strict();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

@Controller("radiology")
export class RadiologyRoomController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("studies/:studyId/room")
  @RequirePermission("radiology.acquire", "hospital")
  async room(@CurrentActor() actor: Actor, @Param("studyId") studyId: string): Promise<unknown> {
    parsed(idSchema, studyId);
    try {
      return { study: await roomView(this.db, actor, studyId) };
    } catch (e) { toHttp(e); }
  }

  @Post("studies/:studyId/acquisition/repeat")
  @RequirePermission("radiology.acquire", "hospital")
  async repeat(
    @CurrentActor() actor: Actor,
    @Param("studyId") studyId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(repeatBody, body);
    try {
      return await withTx(this.db, (tx) => recordRepeatExposure(tx, actor, { studyId, reason: input.reason }));
    } catch (e) { toHttp(e); }
  }

  @Get("room/rejects")
  @RequirePermission("radiology.acquire", "hospital")
  async rejects(@Query("from") from?: string, @Query("to") to?: string): Promise<unknown> {
    const today = istDayString(new Date());
    const weekAgo = istDayString(new Date(Date.now() - 6 * 86_400_000));
    try {
      return await roomRejects(this.db, {
        from: from === undefined ? weekAgo : parsed(day, from),
        to: to === undefined ? today : parsed(day, to),
      });
    } catch (e) { toHttp(e); }
  }
}
