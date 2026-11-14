import { BadRequestException, Body, Controller, Get, Headers, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { imagingDeskArriveBody, imagingDeskCollectBody } from "@hmis/contracts";
import { arriveAtDesk, collectAtDesk, deskVisitsToday, proposeSlot, walkInNow } from "./desk";
import { idSchema, parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * #1078 (IM2) — **THE IMAGING DESK'S ACTS OVER HTTP.** `desk.ts` holds the rules; each act checks its
 * own permissions there as well as at the route, so the route's string is the PRIMARY one a census
 * reads and the act's own list is the whole of it:
 *
 *   · `POST arrive` — `radiology.checkin`.
 *   · `POST collect` — `billing.invoice.issue` here; `billing.receipt.record` and
 *     `radiology.bill_decisions.manage` (the link) in the act. It REQUIRES an `Idempotency-Key`: the
 *     key is what makes a retry after a dropped answer, or after an issue the link did not follow,
 *     replay the charge rather than repeat it.
 *   · `POST studies/:id/walk-in` — `radiology.schedule`; `radiology.checkin` in the act.
 *   · `GET studies/:id/proposal`, `GET visits` — `radiology.schedule`, the desk's own read string.
 */
const visitsQuery = z.object({ patientId: idSchema });

@Controller("radiology/desk")
export class RadiologyDeskController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Opening the patient on the day: every study of the visit booked for today is checked in. */
  @Post("arrive")
  @RequirePermission("radiology.checkin", "hospital")
  async arrive(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(imagingDeskArriveBody, body);
    try {
      return await arriveAtDesk(this.db, actor, { encounterNo: input.encounterNo });
    } catch (e) { toHttp(e); }
  }

  /** The house invoice for the studies in hand, and each line linked to its study, in one act. */
  @Post("collect")
  @RequirePermission("billing.invoice.issue", "hospital")
  async collect(
    @CurrentActor() actor: Actor, @Body() body: unknown, @Headers("idempotency-key") idemKey?: string,
  ): Promise<unknown> {
    const input = parsed(imagingDeskCollectBody, body);
    if (idemKey === undefined || idemKey.trim() === "") {
      throw new BadRequestException("the desk's collect needs an Idempotency-Key — it is what makes a retry safe");
    }
    try {
      return await collectAtDesk(this.db, actor, input, idemKey.trim());
    } catch (e) { toHttp(e); }
  }

  /** Booked now on the first free machine and checked in, in one transaction. */
  @Post("studies/:studyId/walk-in")
  @RequirePermission("radiology.schedule", "hospital")
  async walkIn(@CurrentActor() actor: Actor, @Param("studyId") studyId: string): Promise<unknown> {
    try {
      return await walkInNow(this.db, actor, { studyId: parsed(idSchema, studyId) });
    } catch (e) { toHttp(e); }
  }

  /** The Slot step's prefill: the first free quarter hour on a machine that may take the study. */
  @Get("studies/:studyId/proposal")
  @RequirePermission("radiology.schedule", "hospital")
  async proposal(@CurrentActor() actor: Actor, @Param("studyId") studyId: string): Promise<unknown> {
    try {
      return { proposal: await proposeSlot(this.db, actor, { studyId: parsed(idSchema, studyId) }) };
    } catch (e) { toHttp(e); }
  }

  /** The desk door, after the patient search: this patient's visits of today. */
  @Get("visits")
  @RequirePermission("radiology.schedule", "hospital")
  async visits(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<unknown> {
    const q = parsed(visitsQuery, query);
    try {
      return { visits: await deskVisitsToday(this.db, actor, { patientId: q.patientId }) };
    } catch (e) { toHttp(e); }
  }
}
