import { Body, Controller, Get, HttpException, Inject, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { BillingError, billingHttpStatus } from "../billing";
import {
  assignBed, blockBed, markBedClean, releaseIncumbentBed, releaseReservation, reserveBed, unblockBed,
} from "./beds";
import { readBedBoard } from "./beds-board";
import { IpdError, IpdRefusal, ipdRefusalStatus } from "./errors";
import { IPD_BEDS_CLEAN, IPD_BEDS_MANAGE, IPD_BEDS_VIEW } from "./manifest";
import type { Actor, IpdBedBoard, IpdRefusalBody } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * E1.1 (#718) — the bed routes. Thin: each route is its intent function, and the function re-checks the
 * permission the guard checked (the copilot and agents reach the same functions without this controller).
 * A refusal answers its contract code with the rule, the fix and the bed's own rule (`IpdRefusalBody`).
 */
function toHttp(e: unknown): never {
  if (e instanceof IpdRefusal) {
    const status = ipdRefusalStatus(e.code);
    const body: IpdRefusalBody = { statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix };
    if (e.bedRule !== undefined) body.bedRule = e.bedRule;
    if (e.detail !== undefined) body.detail = e.detail;
    throw new HttpException(body, status);
  }
  if (e instanceof IpdError) {
    const status = e.code === "ipd_forbidden" ? 403 : 422;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  if (e instanceof BillingError) {
    const status = billingHttpStatus(e.code);
    throw new HttpException({ statusCode: status, code: e.code, message: e.message }, status);
  }
  if (e instanceof z.ZodError) {
    throw new HttpException({ statusCode: 400, code: "invalid_request", message: "request body failed validation", detail: e.issues }, 400);
  }
  throw e;
}

const boardQuery = z.object({ wall: z.enum(["0", "1", "true", "false"]).optional() });

@Controller("ipd/beds")
export class IpdBedsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("board")
  @RequirePermission(IPD_BEDS_VIEW, "hospital")
  async board(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<IpdBedBoard> {
    try {
      const q = boardQuery.parse(query);
      return await readBedBoard(this.db, actor, { wall: q.wall === "1" || q.wall === "true" });
    } catch (e) { toHttp(e); }
  }

  @Post("reserve")
  @RequirePermission(IPD_BEDS_MANAGE, "hospital")
  async reserve(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await reserveBed(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("release-reservation")
  @RequirePermission(IPD_BEDS_MANAGE, "hospital")
  async release(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await releaseReservation(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("assign")
  @RequirePermission(IPD_BEDS_MANAGE, "hospital")
  async assign(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await assignBed(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("block")
  @RequirePermission(IPD_BEDS_MANAGE, "hospital")
  async block(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await blockBed(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("unblock")
  @RequirePermission(IPD_BEDS_MANAGE, "hospital")
  async unblock(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await unblockBed(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("clean")
  @RequirePermission(IPD_BEDS_CLEAN, "hospital")
  async clean(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await markBedClean(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("release-incumbent")
  @RequirePermission(IPD_BEDS_MANAGE, "hospital")
  async releaseIncumbent(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await releaseIncumbentBed(this.db, actor, body); } catch (e) { toHttp(e); }
  }
}
