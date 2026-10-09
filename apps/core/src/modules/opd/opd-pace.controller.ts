import { Controller, Get, Inject, Query } from "@nestjs/common";
import { z } from "zod";
import { PACE_DEFAULT_PERIOD, PACE_PERIODS } from "@hmis/contracts";
import type { Actor, MyPace } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor } from "../../kernel/auth/decorators";
import { parsed } from "./opd-masters.controller";
import { loadMyPace } from "./pace";
import type { Db } from "../../kernel/db/client";

const paceQuery = z.object({ period: z.enum(PACE_PERIODS).optional() });

/**
 * MY PACE — `GET /me/performance?period=today|7d|30d` (owner 2026-10-09).
 *
 * `/me/…` and no `userId`, for the reason `/me/brief` and `/me/team` give: there is nowhere to put
 * somebody else's id, so there is no version of this route that reads a colleague. No permission on
 * the door either, like them — WHAT a login is answered is decided inside from the login alone
 * (`loadMyPace`): a doctor their consultations, anybody else an empty answer, which is information
 * and not a refusal. It writes no event, as `/me/brief` writes none: the caller reads their own
 * figures and two anonymous averages, no patient and no named colleague.
 *
 * The longest period is 30 days, inside every caller's history floor (91 days, `kernel/desk/horizon`),
 * and the period is a closed word — there is no date to walk backwards with.
 */
@Controller("me")
export class OpdPaceController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("performance")
  async performance(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<MyPace> {
    const q = parsed(paceQuery, query);
    return loadMyPace(this.db, actor, q.period ?? PACE_DEFAULT_PERIOD);
  }
}
