import { Body, Controller, Get, HttpException, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { counterCharge, counterReturn, lookupCounterAdmission, readCounterSales, searchCounterShelfForIp } from "./counter-charge";
import { IpdError, IpdRefusal, ipdRefusalStatus } from "./errors";
import { IPD_EMAR_ISSUE } from "./permissions";
import type { Actor, IpdCounterAdmission, IpdCounterSales, IpdCounterShelfEntry, IpdRefusalBody } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * #787 (IP counter) — the OPD pharmacy counter's charge to an admission (`IPD_COUNTER_ROUTES`). Thin: each route is its act
 * function, which re-checks `ipd.emar.issue`. Refusals answer `IpdRefusalBody`. A pharmacist's surface: the charge answers
 * its amount.
 */
function toHttp(e: unknown): never {
  if (e instanceof IpdRefusal) {
    const status = ipdRefusalStatus(e.code);
    const body: IpdRefusalBody = { statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix };
    if (e.detail !== undefined) body.detail = e.detail;
    throw new HttpException(body, status);
  }
  if (e instanceof IpdError) {
    const status = e.code === "ipd_forbidden" ? 403 : e.code.endsWith("_not_found") ? 404 : 422;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  if (e instanceof z.ZodError) {
    throw new HttpException({ statusCode: 400, code: "invalid_request", message: "request failed validation", detail: e.issues }, 400);
  }
  throw e;
}

const lookupQuery = z.object({ q: z.string().trim().min(3).max(32) });
const shelfQuery = z.object({ q: z.string().trim().max(64).default("") });

@Controller("ipd/counter")
export class IpdCounterController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("admission")
  @RequirePermission(IPD_EMAR_ISSUE, "hospital")
  async lookup(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<IpdCounterAdmission> {
    try { return await lookupCounterAdmission(this.db, actor, lookupQuery.parse(query).q); } catch (e) { toHttp(e); }
  }

  @Get("shelf")
  @RequirePermission(IPD_EMAR_ISSUE, "hospital")
  async shelf(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<IpdCounterShelfEntry[]> {
    try { return await searchCounterShelfForIp(this.db, actor, shelfQuery.parse(query).q); } catch (e) { toHttp(e); }
  }

  @Get("admissions/:admissionId/sales")
  @RequirePermission(IPD_EMAR_ISSUE, "hospital")
  async sales(@CurrentActor() actor: Actor, @Param("admissionId") id: string): Promise<IpdCounterSales> {
    try { return await readCounterSales(this.db, actor, z.ulid().parse(id)); } catch (e) { toHttp(e); }
  }

  @Post("charge")
  @RequirePermission(IPD_EMAR_ISSUE, "hospital")
  async charge(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await counterCharge(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("return")
  @RequirePermission(IPD_EMAR_ISSUE, "hospital")
  async returnSale(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await counterReturn(this.db, actor, body); } catch (e) { toHttp(e); }
  }
}
