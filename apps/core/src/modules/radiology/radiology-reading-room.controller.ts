import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { CONFIG, DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import { IMAGING_FOLLOWUP_CHANNELS, IMAGING_PEER_SCORES } from "../../kernel/db/schema/radiology";
import {
  bookFollowup, closeFollowup, doctorFollowups, followupBoard, markFollowupNotified,
} from "./followups";
import { peerBoard, peerCase, scorePeerReview } from "./peer-review";
import { teleBoard } from "./tele";
import { overReadNightPrelim } from "./reports";
import { idSchema, parsed, toHttp } from "./radiology-http";
import type { AuthedRequest } from "../../kernel/auth/decorators";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { ModuleRegistry } from "../../kernel/modules/loader";

/**
 * PLAN 18-S RS8c — **THE READING ROOM, PART 3: FOLLOW-UPS, PEER REVIEW, NIGHT & OUTSIDE READS.**
 *
 * Grants (no new permission):
 *   · the Follow-ups list and its notice / close — `radiology.reports.write` (the reading room);
 *   · booking a follow-up — `radiology.orders.place` (the treating doctor from the results inbox, or
 *     the desk): it PLACES AN ORDER, and `placeImagingOrder` also demands the kernel's `orders.place`;
 *   · the doctor's own follow-ups to book — `radiology.reports.read` (RS9's inbox grant);
 *   · peer review and the night over-read — `radiology.reports.amend`, which only a consultant
 *     radiologist holds (a resident does not, RS8b); the over-read signs, so it carries the second
 *     factor exactly as sign and amend do.
 */
const notifiedBody = z.object({
  channel: z.enum(IMAGING_FOLLOWUP_CHANNELS),
  note: z.string().max(500).nullish(),
});
const closeBody = z.object({ reason: z.string().min(1).max(40), note: z.string().max(500) });
const bookBody = z.object({ encounterNo: z.string().trim().min(1).max(32).nullish(), serviceId: idSchema.nullish() });
const scoreBody = z.object({
  score: z.enum(IMAGING_PEER_SCORES),
  learningCase: z.boolean().optional(),
  note: z.string().max(1000).nullish(),
});
const overreadBody = z.object({
  grade: z.enum(["concur", "minor", "major"]),
  note: z.string().max(1000).nullish(),
  findings: z.string().max(20_000).nullish(),
  impression: z.string().max(4000).nullish(),
  acknowledgedWarnings: z.array(z.string().min(1).max(64)).max(20).optional(),
});

@Controller("radiology")
export class RadiologyReadingRoomController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  private decls() { return collectOrderKinds(this.registry); }

  /* ── T1 · follow-ups ── */

  @Get("reading/followups")
  @RequirePermission("radiology.reports.write", "hospital")
  async followups(@CurrentActor() actor: Actor): Promise<unknown> {
    try {
      return await followupBoard(this.db, actor);
    } catch (e) { toHttp(e); }
  }

  @Post("followups/:followupId/notified")
  @RequirePermission("radiology.reports.write", "hospital")
  async notified(@CurrentActor() actor: Actor, @Param("followupId") followupId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(notifiedBody, body);
    try {
      return await withTx(this.db, (tx) => markFollowupNotified(tx, actor, { followupId: parsed(idSchema, followupId), ...input }));
    } catch (e) { toHttp(e); }
  }

  @Post("followups/:followupId/close")
  @RequirePermission("radiology.reports.write", "hospital")
  async close(@CurrentActor() actor: Actor, @Param("followupId") followupId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(closeBody, body);
    try {
      return await withTx(this.db, (tx) => closeFollowup(tx, actor, { followupId: parsed(idSchema, followupId), ...input }));
    } catch (e) { toHttp(e); }
  }

  @Post("followups/:followupId/book")
  @RequirePermission("radiology.orders.place", "hospital")
  async book(@CurrentActor() actor: Actor, @Param("followupId") followupId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(bookBody, body ?? {});
    try {
      return await bookFollowup(this.db, actor, this.decls(), {
        followupId: parsed(idSchema, followupId), encounterNo: input.encounterNo ?? null, serviceId: input.serviceId ?? null,
      });
    } catch (e) { toHttp(e); }
  }

  /** RS9's results inbox: the treating doctor's follow-ups still to book. */
  @Get("results/followups")
  @RequirePermission("radiology.reports.read", "hospital")
  async myFollowups(@CurrentActor() actor: Actor): Promise<unknown> {
    try {
      return { rows: await doctorFollowups(this.db, actor) };
    } catch (e) { toHttp(e); }
  }

  /* ── T2 · peer review ── */

  @Get("reading/peer")
  @RequirePermission("radiology.reports.amend", "hospital")
  async peer(@CurrentActor() actor: Actor): Promise<unknown> {
    try {
      return await peerBoard(this.db, actor);
    } catch (e) { toHttp(e); }
  }

  @Get("reading/peer/:reviewId")
  @RequirePermission("radiology.reports.amend", "hospital")
  async peerCase(@CurrentActor() actor: Actor, @Param("reviewId") reviewId: string): Promise<unknown> {
    try {
      return { case: await peerCase(this.db, actor, parsed(idSchema, reviewId)) };
    } catch (e) { toHttp(e); }
  }

  @Post("reading/peer/:reviewId/score")
  @RequirePermission("radiology.reports.amend", "hospital")
  async score(@CurrentActor() actor: Actor, @Param("reviewId") reviewId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(scoreBody, body);
    try {
      return await withTx(this.db, (tx) => scorePeerReview(tx, actor, { reviewId: parsed(idSchema, reviewId), ...input }));
    } catch (e) { toHttp(e); }
  }

  /* ── T3 · night & outside reads ── */

  @Get("reading/tele")
  @RequirePermission("radiology.reports.amend", "hospital")
  async tele(@CurrentActor() actor: Actor): Promise<unknown> {
    try {
      return await teleBoard(this.db, actor);
    } catch (e) { toHttp(e); }
  }

  @Post("tele/:teleReadId/overread")
  @RequirePermission("radiology.reports.amend", "hospital", { secondFactor: true })
  async overread(
    @CurrentActor() actor: Actor, @Req() req: AuthedRequest, @Param("teleReadId") teleReadId: string, @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(overreadBody, body);
    try {
      return await withTx(this.db, (tx) => overReadNightPrelim(tx, actor, this.decls(), {
        teleReadId: parsed(idSchema, teleReadId), ...input,
        secondFactorAt: req.hmisSession?.secondFactorAt ?? null,
        windowMinutes: this.cfg.secondFactorWindowMinutes,
      }));
    } catch (e) { toHttp(e); }
  }
}
