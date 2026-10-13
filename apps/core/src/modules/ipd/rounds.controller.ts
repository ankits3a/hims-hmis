import { Body, Controller, Get, HttpException, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import { IpdError, IpdRefusal, ipdRefusalStatus } from "./errors";
import { cancelIpOrder, placeIpOrder, stopIpOrder } from "./orders";
import { IPD_CHARGES_REVERSE, IPD_ORDER_PLACE, IPD_ROUND_SIGN } from "./permissions";
import { resolveBackdatedVisit } from "./charges";
import { closeConsult, cosignRound, requestConsult, signRound } from "./rounds";
import { readRoundPatient, readRoundsList, roundsConsultantChoices } from "./rounds-read";
import type { Actor, IpdConsultantChoice, IpdRefusalBody, IpdRoundPatient, IpdRoundsList } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ModuleRegistry } from "../../kernel/modules/loader";

/**
 * E4.2 (#734) — the rounds routes (`IPD_ROUNDS_ROUTES`). Thin: each route is its intent function, which re-checks the
 * permission (the copilot reaches the same functions without this controller). Refusals answer `IpdRefusalBody`. No
 * answer here carries money (decision 0058).
 */
function toHttp(e: unknown): never {
  if (e instanceof IpdRefusal) {
    const status = ipdRefusalStatus(e.code);
    const body: IpdRefusalBody = { statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix };
    if (e.detail !== undefined) body.detail = e.detail;
    throw new HttpException(body, status);
  }
  if (e instanceof IpdError) {
    const status = e.code === "ipd_forbidden" ? 403 : e.code === "admission_workflow_inactive" ? 503 : e.code.endsWith("_not_found") ? 404 : 422;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  if (e instanceof z.ZodError) {
    throw new HttpException({ statusCode: 400, code: "invalid_request", message: "request body failed validation", detail: e.issues }, 400);
  }
  throw e;
}

const admissionParam = z.ulid();
const backdatedBody = z.strictObject({ exceptionId: z.string().min(1).max(64), decision: z.enum(["charge", "waive"]) });

@Controller("ipd")
export class IpdRoundsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  @Get("rounds")
  @RequirePermission(IPD_ROUND_SIGN, "hospital")
  async list(@CurrentActor() actor: Actor): Promise<IpdRoundsList> {
    try { return await readRoundsList(this.db, actor); } catch (e) { toHttp(e); }
  }

  // Declared before `rounds/:admissionId` so the literal segment is never read as an id.
  @Get("rounds/consultants")
  @RequirePermission(IPD_ROUND_SIGN, "hospital")
  async consultants(@CurrentActor() actor: Actor): Promise<{ items: IpdConsultantChoice[] }> {
    try { return { items: await roundsConsultantChoices(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @Get("rounds/:admissionId")
  @RequirePermission(IPD_ROUND_SIGN, "hospital")
  async patient(@CurrentActor() actor: Actor, @Param("admissionId") id: string): Promise<IpdRoundPatient> {
    try { return await readRoundPatient(this.db, actor, admissionParam.parse(id)); } catch (e) { toHttp(e); }
  }

  @Post("rounds/sign")
  @RequirePermission(IPD_ROUND_SIGN, "hospital")
  async sign(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await signRound(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("rounds/cosign")
  @RequirePermission(IPD_ROUND_SIGN, "hospital")
  async cosign(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await cosignRound(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("orders")
  @RequirePermission(IPD_ORDER_PLACE, "hospital")
  async placeOrder(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await placeIpOrder(this.db, actor, body, { orderKinds: collectOrderKinds(this.registry) }); } catch (e) { toHttp(e); }
  }

  @Post("orders/stop")
  @RequirePermission(IPD_ORDER_PLACE, "hospital")
  async stopOrder(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await stopIpOrder(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("orders/cancel")
  @RequirePermission(IPD_ORDER_PLACE, "hospital")
  async cancelOrder(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await cancelIpOrder(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("consults")
  @RequirePermission(IPD_ROUND_SIGN, "hospital")
  async requestConsult(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await requestConsult(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  /** Review of 72f10b68 — billing's answer to a `visit_backdated` exception: charge the visit as of its day, or waive it. */
  @Post("charge-exceptions/backdated-visit")
  @RequirePermission(IPD_CHARGES_REVERSE, "hospital")
  async backdatedVisit(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await resolveBackdatedVisit(this.db, actor, backdatedBody.parse(body)); } catch (e) { toHttp(e); }
  }

  @Post("consults/close")
  @RequirePermission(IPD_ROUND_SIGN, "hospital")
  async closeConsult(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await closeConsult(this.db, actor, body); } catch (e) { toHttp(e); }
  }
}
