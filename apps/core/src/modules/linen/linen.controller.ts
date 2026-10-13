import { Body, Controller, Get, HttpException, Inject, Param, Post, Query } from "@nestjs/common";
import { linenVarianceQuery } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { LinenError, linenHttpStatus } from "./errors";
import {
  approveCondemn, borrowBetweenWards, receiveFromLaundry, recordInfected, recordSoiled, recordWardCount, rejectCondemn,
  requestCondemn, sendToLaundry, setParLevel, topUpWard,
} from "./intents";
import { LINEN_HANDLE, LINEN_MANAGE, LINEN_VIEW } from "./manifest";
import { linenBoard, linenHandlerView, weeklyVariance } from "./reads";
import type { Actor, LinenActResult, LinenBoardView, LinenHandlerView, LinenVarianceRow } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * THE LINEN DOORS. The door checks the permission; the intent checks the ledger. A refusal answers
 * `{ code, message, fix }` (spec IPD core §0A.5).
 */
const body = (b: unknown): Record<string, unknown> => (typeof b === "object" && b !== null ? b as Record<string, unknown> : {});

async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LinenError) {
      const status = linenHttpStatus(e.code);
      throw new HttpException({ statusCode: status, code: e.code, message: e.message, fix: e.fix, details: e.details }, status);
    }
    throw e;
  }
}

type Decided = { id: string; state: string };

@Controller("linen")
export class LinenController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("board")
  @RequirePermission(LINEN_VIEW, "hospital", { alsoAdmits: [LINEN_MANAGE] })
  async board(): Promise<LinenBoardView> {
    return linenBoard(this.db, new Date());
  }

  @Get("handler")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async handler(): Promise<LinenHandlerView> {
    return linenHandlerView(this.db, new Date());
  }

  @Get("variance")
  @RequirePermission(LINEN_VIEW, "hospital", { alsoAdmits: [LINEN_MANAGE] })
  async variance(@Query() q: unknown): Promise<LinenVarianceRow[]> {
    const r = linenVarianceQuery.safeParse(q);
    if (!r.success) throw new HttpException({ statusCode: 400, code: "bad_input", message: "The request is not complete.", fix: "Pick a week from the list." }, 400);
    return weeklyVariance(this.db, new Date(r.data.from), new Date(r.data.to));
  }

  @Post("wards/:id/top-up")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async topUp(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<LinenActResult> {
    return refusing(() => topUpWard(this.db, actor, { ...body(b), wardId: id }));
  }

  @Post("wards/:id/soiled")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async soiled(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<LinenActResult> {
    return refusing(() => recordSoiled(this.db, actor, { ...body(b), wardId: id }));
  }

  @Post("wards/:id/infected")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async infected(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<LinenActResult> {
    return refusing(() => recordInfected(this.db, actor, { ...body(b), wardId: id }));
  }

  @Post("wards/:id/count")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async count(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<LinenActResult> {
    return refusing(() => recordWardCount(this.db, actor, { ...body(b), wardId: id }));
  }

  @Post("wards/:id/par")
  @RequirePermission(LINEN_MANAGE, "hospital")
  async par(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<{ wardId: string; itemCode: string; par: number | null }> {
    return refusing(() => setParLevel(this.db, actor, { ...body(b), wardId: id }));
  }

  @Post("borrow")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async borrow(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<LinenActResult> {
    return refusing(() => borrowBetweenWards(this.db, actor, b));
  }

  @Post("laundry/batches")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async send(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<LinenActResult> {
    return refusing(() => sendToLaundry(this.db, actor, b));
  }

  @Post("laundry/batches/:id/receive")
  @RequirePermission(LINEN_HANDLE, "hospital")
  async receive(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<LinenActResult> {
    return refusing(() => receiveFromLaundry(this.db, actor, { ...body(b), batchId: id }));
  }

  @Post("condemn")
  @RequirePermission(LINEN_HANDLE, "hospital", { alsoAdmits: [LINEN_MANAGE] })
  async condemn(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<Decided> {
    return refusing(async () => { const r = await requestCondemn(this.db, actor, b); return { id: r.id, state: r.state }; });
  }

  @Post("condemn/:id/approve")
  @RequirePermission(LINEN_MANAGE, "hospital")
  async approve(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Decided> {
    return refusing(async () => { const r = await approveCondemn(this.db, actor, { ...body(b), requestId: id }); return { id: r.id, state: r.state }; });
  }

  @Post("condemn/:id/reject")
  @RequirePermission(LINEN_MANAGE, "hospital")
  async reject(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Decided> {
    return refusing(async () => { const r = await rejectCondemn(this.db, actor, { ...body(b), requestId: id }); return { id: r.id, state: r.state }; });
  }
}
